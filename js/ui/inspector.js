import * as THREE from 'three';
import { escapeHtml } from '../core/escape-html.js';
import { TransformCommand } from '../core/scene-manager.js';
import { PoseChangeCommand } from '../animation/rig-system.js';
/**
 * Web Blender Studio - Inspector / Properties Module
 * Handles object transform (drag-to-scrub), PBR material editing, and mesh statistics.
 * Fully synchronized with SceneManager and 3D Viewport TransformControls.
 */

import { getModifierStack } from '../core/modifiers.js';
import * as ModifierStack from '../core/modifier-stack.js';
import { setMeshShading, flipMeshNormals, recalculateMeshNormals, getShadingState, SHADING_MODES } from '../core/shading.js';
import { updateImageObjectProperties, replaceImageObjectSource, convertImageToMeshPlane } from '../core/image-objects.js';
import { dataBlockRegistry } from '../core/data-blocks.js';
import { textureLeaseRegistry } from '../render/texture-lease-registry.js';
import { bakeMeshTexture } from '../render/texture-baker.js';
import { getPaintLayerStack, ensurePaintLayerStack } from '../core/paint-layers.js';
import { ShaderGraph, getShaderGraphForMaterial } from '../core/shader-graph.js';
import { applyShaderGraphToMaterial } from '../core/shader-compiler-three.js';
import { rebuildCurveMesh, convertCurveToMesh } from '../core/curve-objects.js';
import { enforceShadowBudget, refreshLightHelper, syncLightDirection } from '../core/light-helper.js';
import {
  ensureVertexGroups,
  addVertexGroup,
  removeVertexGroup,
  renameVertexGroup,
  setActiveVertexGroup,
  assignVerticesToGroup,
  removeVerticesFromGroup,
  selectGroupVertices,
  deselectGroupVertices,
  mirrorVertexGroup,
  getEditModeBufferVertexIndices,
  captureVertexGroupsSnapshot,
  VertexGroupsCommand,
} from '../animation/vertex-groups.js';

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

export class Inspector {
  /**
   * @param {HTMLElement|string} container - DOM element or selector for inspector
   * @param {Object} sceneManager - Reference to SceneManager
   */
  constructor(container, sceneManager = null) {
    this.container = typeof container === 'string' ? document.querySelector(container) : container;
    this.sceneManager = sceneManager;
    this.targetObject = null;
    this.activeTab = 'object'; // 'world', 'object', 'modifier', 'material', 'data'
    this.isEditingInput = false;

    this.initDOM();
    this.bindEvents();

    if (this.sceneManager) {
      this.setSceneManager(this.sceneManager);
    }
  }

  setSceneManager(sm) {
    this.sceneManager = sm;
    this.bindSceneEvents();
    const active = this.sceneManager.getActiveObject
      ? this.sceneManager.getActiveObject()
      : (this.sceneManager.activeObject || this.sceneManager.selectedObject);
    if (active) {
      this.setTargetObject(active);
    }
  }

  initDOM() {
    if (!this.container) return;

    this.container.innerHTML = `
      <div class="blender-properties-panel">
        <!-- Vertical category navigation bar -->
        <div class="properties-category-tabs">
          <button class="prop-tab-btn" data-tab="tool" title="Active Tool & Workspace">
            <svg viewBox="0 0 16 16"><path d="M14.7 1.3a1 1 0 0 0-1.4 0L10.5 4.1l1.4 1.4 2.8-2.8a1 1 0 0 0 0-1.4zM9.8 4.8L2.4 12.2l-1.4 2.8 2.8-1.4 7.4-7.4-1.4-1.4z"/></svg>
          </button>
          <button class="prop-tab-btn" data-tab="world" title="World Settings">
            <svg viewBox="0 0 16 16"><path d="M8 0a8 8 0 1 0 0 16A8 8 0 0 0 8 0zm0 14.5a6.5 6.5 0 1 1 0-13 6.5 6.5 0 0 1 0 13zM2.5 8c0-.6.1-1.2.3-1.8l3 3.6v.7c0 .6.4 1 1 1v1.5A6.5 6.5 0 0 1 2.5 8z"/></svg>
          </button>
          <button class="prop-tab-btn active" data-tab="object" title="Object Properties">
            <svg viewBox="0 0 16 16"><path d="M7.5.5a1 1 0 0 1 1 0l6 3.5a1 1 0 0 1 .5.87v6.26a1 1 0 0 1-.5.87l-6 3.5a1 1 0 0 1-1 0l-6-3.5A1 1 0 0 1 1 11.13V4.87a1 1 0 0 1 .5-.87l6-3.5zM8 2.24L3.25 5 8 7.76 12.75 5 8 2.24zM2.5 6.44v4.54L7.25 13.7v-4.54L2.5 6.44zm11 0l-4.75 2.72v4.54l4.75-2.72V6.44z"/></svg>
          </button>
          <button class="prop-tab-btn" data-tab="modifier" title="Modifiers">
            <svg viewBox="0 0 16 16"><path d="M14.7 10.3l-2.4-2.4c.2-.6.2-1.2 0-1.8l2.4-2.4a1 1 0 0 0 0-1.4l-1.4-1.4a1 1 0 0 0-1.4 0L9.5 3.3c-.6-.2-1.2-.2-1.8 0L5.3.9a1 1 0 0 0-1.4 0L2.5 2.3a1 1 0 0 0 0 1.4l2.4 2.4c-.2.6-.2 1.2 0 1.8L2.5 10.3a1 1 0 0 0 0 1.4l1.4 1.4a1 1 0 0 0 1.4 0l2.4-2.4c.6.2 1.2.2 1.8 0l2.4 2.4a1 1 0 0 0 1.4 0l1.4-1.4a1 1 0 0 0 0-1.4zM8 9.5A1.5 1.5 0 1 1 8 6.5a1.5 1.5 0 0 1 0 3z"/></svg>
          </button>
          <button class="prop-tab-btn" data-tab="material" title="Material Properties">
            <svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="M8 1.5a6.5 6.5 0 0 1 6.5 6.5H8V1.5z"/></svg>
          </button>
          <button class="prop-tab-btn" data-tab="armature" title="Armature &amp; Bone Posing">
            <svg viewBox="0 0 16 16"><path fill="currentColor" d="M12 2a2 2 0 1 0 2 2 2 2 0 0 0-2-2zm-1 6h2v6h-2zM5 8h2v6H5zm3-3h2v11H8z"/></svg>
          </button>
          <button class="prop-tab-btn" data-tab="data" title="Mesh Data">
            <svg viewBox="0 0 16 16"><path d="M1 3a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V3zm2-1a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V3a1 1 0 0 0-1-1H3zm2 3h6v1H5V5zm0 3h6v1H5V8zm0 3h4v1H5v-1z"/></svg>
          </button>
        </div>

        <!-- Scrollable property content -->
        <div class="properties-content" id="properties-content-body">
          <div class="empty-inspector-msg">No object selected</div>
        </div>
      </div>
    `;

    this.contentBody = this.container.querySelector('#properties-content-body');
  }

  bindEvents() {
    const tabs = this.container.querySelectorAll('.prop-tab-btn');
    tabs.forEach((tab) => {
      tab.addEventListener('click', () => {
        tabs.forEach((t) => t.classList.remove('active'));
        tab.classList.add('active');
        this.activeTab = tab.dataset.tab;
        this.render();
      });
    });
  }

  bindSceneEvents() {
    if (!this.sceneManager) return;

    if (typeof this.sceneManager.on === 'function') {
      this.sceneManager.on('selectionChanged', (payload) => {
        this.setTargetObject(payload?.active || null);
      });
      this.sceneManager.on('objectRenamed', (payload) => {
        if (this.targetObject && (this.targetObject === payload?.object || this.targetObject.uuid === payload?.object?.uuid)) {
          const input = this.contentBody?.querySelector('.prop-object-name-input');
          if (input && document.activeElement !== input) {
            input.value = payload.newName || this.targetObject.name;
          }
        }
      });
      this.sceneManager.on('transformChanged', (obj) => {
        if (this.targetObject && (this.targetObject === obj || this.targetObject.uuid === obj?.uuid)) {
          this.updateTransformFields();
        }
      });
    }

    // Window events fallback
    window.addEventListener('blender:objectSelected', (e) => {
      this.setTargetObject(e.detail);
    });

    window.addEventListener('blender:transformChanged', (e) => {
      if (this.targetObject && (this.targetObject === e.detail || this.targetObject.uuid === e.detail?.uuid)) {
        this.updateTransformFields();
      }
    });

    window.addEventListener('blender:geometryChanged', (e) => {
      if (this.targetObject && (this.targetObject === e.detail || this.targetObject.uuid === e.detail?.uuid)) {
        if (this.activeTab === 'data' || this.activeTab === 'object') {
          this.render();
        }
      }
    });

    window.addEventListener('blender:cameraChanged', () => {
      if (this.targetObject && window.cameraManager?.getCameraEntry(this.targetObject)) {
        this.render();
      }
    });

    window.addEventListener('blender:bone-selected', (e) => {
      if (e.detail?.bone) {
        this.selectedBone = e.detail.bone;
        if (this.activeTab === 'armature') {
          this.render();
        }
      }
    });

    const refreshArmatureTab = () => {
      if (this.activeTab === 'armature' && !this.isEditingInput) {
        this.render();
      }
    };
    window.addEventListener('blender:edit-bone-mode-changed', refreshArmatureTab);
    window.addEventListener('blender:edit-bone-updated', refreshArmatureTab);
    window.addEventListener('blender:weight-paint-mode-changed', refreshArmatureTab);
    window.addEventListener('blender:mesh-skinned', (e) => {
      if (e.detail?.skinnedMesh) {
        this.targetObject = e.detail.skinnedMesh;
      }
      refreshArmatureTab();
    });
    window.addEventListener('blender:weight-brush-changed', (e) => {
      if (this.activeTab !== 'armature' || !this.contentBody || !e.detail) return;
      const b = e.detail;
      const modeEl = this.contentBody.querySelector('#insp-wp-mode');
      const radEl = this.contentBody.querySelector('#insp-wp-radius');
      const radVal = this.contentBody.querySelector('#insp-wp-radius-val');
      const strEl = this.contentBody.querySelector('#insp-wp-strength');
      const strVal = this.contentBody.querySelector('#insp-wp-strength-val');
      const mirEl = this.contentBody.querySelector('#insp-wp-mirror');
      if (modeEl && document.activeElement !== modeEl) modeEl.value = b.mode;
      if (radEl && document.activeElement !== radEl) radEl.value = String(b.radius);
      if (radVal) radVal.textContent = Number(b.radius).toFixed(2);
      if (strEl && document.activeElement !== strEl) strEl.value = String(b.strength);
      if (strVal) strVal.textContent = Number(b.strength).toFixed(2);
      if (mirEl) mirEl.checked = !!b.symmetryX;
    });
  }

  setTargetObject(obj) {
    if (obj !== this.targetObject) {
      this._procPbrAbort?.abort?.();
      this._procPbrAbort = null;
      this._procPbrGen = (this._procPbrGen || 0) + 1;
    }
    this.targetObject = obj;
    // Selection can fire hundreds of times during a DSL loop/import; rebuild the
    // whole properties panel at most once per animation frame.
    this.queueRender();
  }

  queueRender() {
    if (this._renderQueued) return;
    this._renderQueued = true;
    const schedule = (typeof window !== 'undefined' && window.requestAnimationFrame)
      ? window.requestAnimationFrame.bind(window)
      : (cb) => setTimeout(cb, 16);
    schedule(() => {
      this._renderQueued = false;
      this.render();
    });
  }

  update(obj) {
    if (obj) {
      this.targetObject = obj;
    }
    this.render();
  }

  render() {
    if (!this.contentBody) return;

    const currentTargetUuid = this.targetObject?.uuid || null;
    if (this.activeTab !== 'material' || currentTargetUuid !== this._lastPbrTargetUuid) {
      this._procPbrAbort?.abort?.();
      this._procPbrAbort = null;
      this._procPbrGen = (this._procPbrGen || 0) + 1;
      this._lastPbrTargetUuid = currentTargetUuid;
    }

    if (this.activeTab === 'world') {
      this.contentBody.innerHTML = '';
      this.renderWorldSection();
      return;
    }

    if (!this.targetObject) {
      this.contentBody.innerHTML = `
        <div class="empty-inspector-msg">
          <svg viewBox="0 0 24 24" width="32" height="32" fill="currentColor" style="opacity: 0.3; margin-bottom: 8px;">
            <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
          </svg>
          <div>Select an object in the 3D Viewport or Outliner to view and edit its properties.</div>
        </div>
      `;
      return;
    }

    this.contentBody.innerHTML = '';

    // Header identity (name + visibility)
    this.renderIdentitySection();

    // Camera objects have their own lens / clipping controls.
    const cameraEntry = window.cameraManager?.getCameraEntry(this.targetObject);
    if (cameraEntry) {
      if (this.activeTab === 'object' || this.activeTab === 'tool' || this.activeTab === 'data') {
        this.renderTransformSection();
        this.renderCameraSection(cameraEntry);
      } else if (this.activeTab === 'world') {
        this.renderWorldSection();
      }
      return;
    }

    // Light objects have dedicated Light Data & Shadow Inspector controls.
    if (this.targetObject.isLight) {
      if (this.activeTab === 'object' || this.activeTab === 'tool') {
        this.renderTransformSection();
        this.renderLightSection(this.targetObject);
      } else if (this.activeTab === 'data') {
        this.renderLightSection(this.targetObject);
      } else if (this.activeTab === 'world') {
        this.renderWorldSection();
      } else if (this.activeTab === 'modifier') {
        this.renderModifierSection();
      } else if (this.activeTab === 'armature') {
        this.renderArmatureSection();
      } else {
        this.contentBody.innerHTML += `<div class="empty-inspector-msg">Selected light does not support mesh ${escapeHtml(this.activeTab)} properties.</div>`;
      }
      return;
    }

    // Accordions depending on activeTab
    const isImageObj = Boolean(this.targetObject.userData?.isImageObject);
    const groupEditableMeshes = (!this.targetObject.isMesh && !this.targetObject.userData?.isScatterGroup)
      ? this._collectEditableMeshes(this.targetObject)
      : [];
    if (this.activeTab === 'object' || this.activeTab === 'tool') {
      this.renderTransformSection();
      if (isImageObj) {
        this.renderImageSection();
        if (this.targetObject.userData.imageMode === 'plane') {
          this.renderMaterialSection();
          this.renderMeshStatisticsSection();
        }
      } else if (this.targetObject.isMesh) {
        if (this.targetObject.userData?.curveData) this.renderCurveSection();
        this.renderMaterialSection();
        this.renderMeshStatisticsSection();
        this.renderPerformanceLodScatterSection();
      } else if (this.targetObject.isGroup || this.targetObject.userData?.isScatterGroup || groupEditableMeshes.length > 0) {
        if (groupEditableMeshes.length > 0) {
          this.renderMaterialSection();
        }
        this.renderPerformanceLodScatterSection();
      }
    } else if (this.activeTab === 'material') {
      if (this.targetObject.isMesh) {
        this.renderMaterialSection();
        this.renderSurfacePaintAndBakeSection();
      } else if (groupEditableMeshes.length > 0) {
        this.renderMaterialSection();
      } else {
        this.contentBody.innerHTML += `<div class="empty-inspector-msg">Selected object does not support materials.</div>`;
      }
    } else if (this.activeTab === 'data') {
      if (isImageObj) {
        this.renderImageSection();
      }
      if (this.targetObject.isMesh && (!isImageObj || this.targetObject.userData.imageMode === 'plane')) {
        this.renderMeshStatisticsSection();
        this.renderPerformanceLodScatterSection();
        this.renderVertexGroupsSection();
        this.renderNormalsSection();
      } else if (this.targetObject.userData?.isScatterGroup || this.targetObject.isGroup) {
        this.renderPerformanceLodScatterSection();
      } else if (!isImageObj) {
        this.contentBody.innerHTML += `<div class="empty-inspector-msg">No mesh geometry data available.</div>`;
      }
    } else if (this.activeTab === 'modifier') {
      this.renderModifierSection();
    } else if (this.activeTab === 'world') {
      this.renderWorldSection();
    } else if (this.activeTab === 'armature') {
      this.renderArmatureSection();
    }
  }

  renderArmatureSection() {
    const card = this.createCard('Armature & Bone Posing', true);
    const rigSystem = window.rigSystem;

    // Detect if target has skeleton or is bone or is plain mesh
    let skeleton = null;
    let character = this.targetObject;
    if (this.targetObject.isBone) {
      if (typeof this.targetObject.traverseAncestors === 'function') {
        this.targetObject.traverseAncestors(a => {
          if (!skeleton && a.userData?.skeleton) skeleton = a.userData.skeleton;
        });
      }
    } else if (this.targetObject.userData?.skeleton) {
      skeleton = this.targetObject.userData.skeleton;
    } else if (this.targetObject.skeleton) {
      skeleton = this.targetObject.skeleton;
    } else {
      this.targetObject.traverse(c => {
        if (!skeleton && (c.isSkinnedMesh && c.skeleton)) skeleton = c.skeleton;
      });
    }

    // CASE 1: Standard Mesh without skeleton -> Show Auto-Skinning option if armature exists in scene
    if (!skeleton && this.targetObject.isMesh) {
      let sceneArmature = null;
      if (window.scene) {
        window.scene.traverse(o => {
          if (!sceneArmature && (o.userData?.isArmature || o.userData?.skeleton || o.isSkeleton)) {
            sceneArmature = o;
          }
        });
      }

      const skinMode = this.skinMode || 'heat';
      card.body.innerHTML = `
        <div style="padding: 10px 4px;">
          <div style="font-weight: 600; color: #f39c12; margin-bottom: 6px; display: flex; align-items: center; gap: 6px;">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 2a2 2 0 1 0 2 2 2 2 0 0 0-2-2zm8 7h-5v13h-2v-6h-2v6H9V9H4V7h16z"/></svg>
            Auto-Skinning (Automatic Bone Weights)
          </div>
          <div style="font-size: 11px; color: var(--b-text-secondary); margin-bottom: 8px; line-height: 1.4;">
            This mesh is not rigged yet. Compute automatic weights and bind it to an armature in the scene (equivalent to Blender <i>Ctrl+P &rarr; With Automatic Weights</i>).
          </div>
          <div class="prop-row" style="margin-bottom: 8px;">
            <span class="prop-label">Solver:</span>
            <select id="sel-insp-skin-mode" style="flex:1; background:var(--b-bg-input); color:var(--b-text-primary); border:1px solid var(--b-border-dark); padding:3px; border-radius:3px; font-size:11px;">
              <option value="heat" ${skinMode === 'heat' ? 'selected' : ''}>Bone Heat (Laplacian)</option>
              <option value="geodesic" ${skinMode === 'geodesic' ? 'selected' : ''}>Surface Geodesic</option>
              <option value="euclidean" ${skinMode === 'euclidean' ? 'selected' : ''}>Euclidean Distance</option>
            </select>
          </div>
          <button class="blender-btn-primary" id="btn-inspector-auto-skin" style="width: 100%; padding: 7px; background: #27ae60; color: #fff; border: none; border-radius: 4px; cursor: pointer; font-weight: 500;">
            🔗 Auto-Bind Mesh to Armature
          </button>
        </div>
      `;

      card.body.querySelector('#sel-insp-skin-mode')?.addEventListener('change', (e) => {
        this.skinMode = e.target.value;
      });
      card.body.querySelector('#btn-inspector-auto-skin')?.addEventListener('click', () => {
        if (rigSystem) {
          const modeSel = card.body.querySelector('#sel-insp-skin-mode')?.value || this.skinMode || 'heat';
          this.skinMode = modeSel;
          const skinned = rigSystem.autoSkinMesh(this.targetObject, sceneArmature, { mode: modeSel });
          if (skinned) {
            this.setTargetObject(skinned);
            this.render();
          }
        }
      });

      this.contentBody.appendChild(card.card);
      return;
    }

    if (!skeleton) {
      card.body.innerHTML = `<div class="empty-inspector-msg">No armature/skeleton found on this object. Select an Armature or rigged character in the 3D Viewport.</div>`;
      this.contentBody.appendChild(card.card);
      return;
    }

    // CASE 2: Target is Armature / SkinnedMesh / Bone
    const bones = skeleton.bones || [];
    let selectedBone = this.selectedBone;
    if (this.targetObject.isBone) {
      selectedBone = this.targetObject;
    }
    if (!selectedBone && bones.length > 0) {
      selectedBone = bones[0];
    }
    this.selectedBone = selectedBone;

    // Build bone options
    let boneOptionsHtml = '';
    bones.forEach((b) => {
      const cleanName = b.name.replace(/^mixamorig|^mixamo_/i, '');
      const isSel = selectedBone && selectedBone.uuid === b.uuid ? 'selected' : '';
      boneOptionsHtml += `<option value="${escapeHtml(b.name)}" ${isSel}>${escapeHtml(cleanName)} (${escapeHtml(b.name)})</option>`;
    });

    // Current Euler angles in degrees
    const degX = selectedBone ? (selectedBone.rotation.x * 180 / Math.PI).toFixed(1) : 0;
    const degY = selectedBone ? (selectedBone.rotation.y * 180 / Math.PI).toFixed(1) : 0;
    const degZ = selectedBone ? (selectedBone.rotation.z * 180 / Math.PI).toFixed(1) : 0;

    const isEditMode = !!rigSystem?.isEditBoneMode;
    const isWPMode = !!rigSystem?.isWeightPaintMode;
    const brush = rigSystem?.weightBrush || { mode: 'add', radius: 0.22, strength: 0.5, symmetryX: true };

    const descendantSet = new Set();
    if (selectedBone && typeof selectedBone.traverse === 'function') {
      selectedBone.traverse((d) => descendantSet.add(d));
    }
    const curParentName = selectedBone?.parent?.isBone ? selectedBone.parent.name : '';
    let parentOptionsHtml = `<option value="" ${!curParentName ? 'selected' : ''}>(Armature Root)</option>`;
    bones.forEach((b) => {
      if (descendantSet.has(b)) return;
      const sel = curParentName === b.name ? 'selected' : '';
      const escaped = escapeHtml(b.name);
      const cleanParent = escapeHtml(b.name.replace(/^mixamorig|^mixamo_/i, ''));
      parentOptionsHtml += `<option value="${escaped}" ${sel}>${cleanParent} (${escaped})</option>`;
    });

    const editBoneSectionHtml = isEditMode ? `
      <div style="margin-top: 10px; padding: 8px; background: rgba(243, 156, 18, 0.08); border: 1px solid rgba(243, 156, 18, 0.3); border-radius: 4px;">
        <div style="font-size: 11px; font-weight: 600; color: #f39c12; margin-bottom: 6px;">EDIT BONE OPERATIONS:</div>
        <div class="prop-row" style="gap: 4px; margin-bottom: 6px;">
          <input type="text" id="insp-edit-bone-name" value="${escapeHtml(selectedBone?.name || '')}" style="flex: 1; background: var(--b-bg-input); color: var(--b-text-primary); border: 1px solid var(--b-border-dark); padding: 3px 6px; border-radius: 3px; font-size: 11px;" />
          <button class="blender-btn" id="btn-insp-rename-bone" style="padding: 3px 8px; font-size: 11px; background: var(--b-bg-input); color: var(--b-text-primary); border: 1px solid var(--b-border-dark); border-radius: 3px; cursor: pointer;">Rename</button>
        </div>
        <div class="prop-row" style="margin-bottom: 6px;">
          <span class="prop-label">Parent:</span>
          <select id="insp-edit-bone-parent" style="flex: 1; background: var(--b-bg-input); color: var(--b-text-primary); border: 1px solid var(--b-border-dark); padding: 3px; border-radius: 3px; font-size: 11px;">
            ${parentOptionsHtml}
          </select>
        </div>
        <label style="display:flex; align-items:center; gap:6px; font-size:11px; color:var(--b-text-primary); margin-bottom:8px; cursor:pointer;">
          <input type="checkbox" id="chk-insp-bone-connect" ${rigSystem?.getBoneConnected(selectedBone) ? 'checked' : ''} ${selectedBone?.parent?.isBone ? '' : 'disabled'} />
          Connected to Parent Tail (use_connect)
        </label>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 6px;">
          <button class="blender-btn" id="btn-insp-extrude-bone" style="padding: 4px; font-size: 11px; background: var(--b-bg-input); border: 1px solid var(--b-border-dark); color: var(--b-text-primary); border-radius: 3px; cursor: pointer;">➕ Extrude (E)</button>
          <button class="blender-btn" id="btn-insp-add-bone" style="padding: 4px; font-size: 11px; background: var(--b-bg-input); border: 1px solid var(--b-border-dark); color: var(--b-text-primary); border-radius: 3px; cursor: pointer;">+ New Bone</button>
          <button class="blender-btn" id="btn-insp-delete-bone" style="padding: 4px; font-size: 11px; background: var(--b-bg-input); border: 1px solid var(--b-border-dark); color: #ff7675; border-radius: 3px; cursor: pointer;">🗑 Delete (X)</button>
          <button class="blender-btn" id="btn-insp-sym-bones" style="padding: 4px; font-size: 11px; background: var(--b-bg-input); border: 1px solid var(--b-border-dark); color: var(--b-text-primary); border-radius: 3px; cursor: pointer;">🪞 Sym X</button>
        </div>
      </div>
    ` : '';

    const weightBrushSectionHtml = isWPMode ? `
      <div style="margin-top: 10px; padding: 8px; background: rgba(231, 76, 60, 0.08); border: 1px solid rgba(231, 76, 60, 0.3); border-radius: 4px;">
        <div style="font-size: 11px; font-weight: 600; color: #ff7675; margin-bottom: 6px;">WEIGHT PAINT BRUSH:</div>
        <div class="prop-row" style="margin-bottom: 6px;">
          <span class="prop-label">Mode:</span>
          <select id="insp-wp-mode" style="flex: 1; background: var(--b-bg-input); color: var(--b-text-primary); border: 1px solid var(--b-border-dark); padding: 3px; border-radius: 3px; font-size: 11px;">
            <option value="add" ${brush.mode === 'add' ? 'selected' : ''}>Add</option>
            <option value="subtract" ${brush.mode === 'subtract' ? 'selected' : ''}>Subtract</option>
            <option value="smooth" ${brush.mode === 'smooth' ? 'selected' : ''}>Smooth</option>
            <option value="replace" ${brush.mode === 'replace' ? 'selected' : ''}>Replace</option>
          </select>
        </div>
        <div class="prop-row">
          <span class="prop-label">Radius:</span>
          <div style="flex:1; display:flex; align-items:center; gap:6px;">
            <input type="range" id="insp-wp-radius" min="0.02" max="1.0" step="0.02" value="${brush.radius}" style="flex:1;" />
            <span id="insp-wp-radius-val" style="width:36px; text-align:right; font-family:monospace; font-size:11px;">${Number(brush.radius).toFixed(2)}</span>
          </div>
        </div>
        <div class="prop-row">
          <span class="prop-label">Strength:</span>
          <div style="flex:1; display:flex; align-items:center; gap:6px;">
            <input type="range" id="insp-wp-strength" min="0.05" max="1.0" step="0.05" value="${brush.strength}" style="flex:1;" />
            <span id="insp-wp-strength-val" style="width:36px; text-align:right; font-family:monospace; font-size:11px;">${Number(brush.strength).toFixed(2)}</span>
          </div>
        </div>
        <label style="display:flex; align-items:center; gap:6px; font-size:11px; color:var(--b-text-primary); margin: 4px 0 8px 0; cursor:pointer;">
          <input type="checkbox" id="insp-wp-mirror" ${brush.symmetryX ? 'checked' : ''} /> Mirror Stroke Across X=0
        </label>
        <div style="display: grid; grid-template-columns: 1fr 1fr 1fr 1fr; gap: 4px;">
          <button class="blender-btn" id="btn-insp-wp-smooth" style="padding: 4px; font-size: 10px; background: var(--b-bg-input); border: 1px solid var(--b-border-dark); color: var(--b-text-primary); border-radius: 3px; cursor: pointer;">🌫 Smooth</button>
          <button class="blender-btn" id="btn-insp-wp-norm" style="padding: 4px; font-size: 10px; background: var(--b-bg-input); border: 1px solid var(--b-border-dark); color: var(--b-text-primary); border-radius: 3px; cursor: pointer;">⚖ Norm</button>
          <button class="blender-btn" id="btn-insp-wp-clean" style="padding: 4px; font-size: 10px; background: var(--b-bg-input); border: 1px solid var(--b-border-dark); color: var(--b-text-primary); border-radius: 3px; cursor: pointer;">✂ Clean</button>
          <button class="blender-btn" id="btn-insp-wp-mirror-x" style="padding: 4px; font-size: 10px; background: var(--b-bg-input); border: 1px solid var(--b-border-dark); color: var(--b-text-primary); border-radius: 3px; cursor: pointer;">🪞 Mirror</button>
        </div>
      </div>
    ` : '';

    card.body.innerHTML = `
      <!-- Pose & Edit Bone Mode Toggles -->
      <div class="prop-row" style="margin-bottom: 10px; border-bottom: 1px solid var(--b-border-dark); padding-bottom: 8px; gap: 6px;">
        <button class="blender-btn" id="btn-inspector-toggle-pose" style="flex: 1; padding: 4px 8px; background: ${rigSystem?.isPoseMode ? '#2980b9' : 'var(--b-bg-input)'}; color: #fff; border: 1px solid var(--b-border-dark); border-radius: 3px; cursor: pointer; font-size: 11px;">
          ${rigSystem?.isPoseMode ? '🦴 Pose Mode (ON)' : '🦴 Pose Mode'}
        </button>
        <button class="blender-btn" id="btn-inspector-toggle-edit-bones" style="flex: 1; padding: 4px 8px; background: ${isEditMode ? '#d35400' : 'var(--b-bg-input)'}; color: #fff; border: 1px solid var(--b-border-dark); border-radius: 3px; cursor: pointer; font-size: 11px;">
          ${isEditMode ? '🧱 Edit Bones (ON)' : '🧱 Edit Bones'}
        </button>
      </div>

      <!-- Bone Selector -->
      <div class="prop-row">
        <span class="prop-label">Bone:</span>
        <select id="inspector-bone-select" style="flex: 1; background: var(--b-bg-input); color: var(--b-text-primary); border: 1px solid var(--b-border-dark); padding: 4px; border-radius: 3px; font-size: 11px;">
          ${boneOptionsHtml}
        </select>
      </div>

      ${editBoneSectionHtml}

      <!-- Rotation Sliders -->
      <div style="margin-top: 10px; font-size: 11px; font-weight: 600; color: var(--b-text-secondary); margin-bottom: 4px;">
        BONE ROTATION:
      </div>

      <div class="prop-row">
        <span class="prop-label" style="color: #e74c3c; font-weight: bold;">X (Pitch):</span>
        <div class="prop-slider-wrap" style="flex: 1; display: flex; align-items: center; gap: 6px;">
          <input type="range" id="bone-rot-x" min="-180" max="180" step="1" value="${degX}" style="flex: 1;" />
          <span id="bone-val-x" style="width: 48px; text-align: right; font-family: monospace; font-size: 11px;">${degX}&deg;</span>
        </div>
      </div>

      <div class="prop-row">
        <span class="prop-label" style="color: #2ecc71; font-weight: bold;">Y (Yaw):</span>
        <div class="prop-slider-wrap" style="flex: 1; display: flex; align-items: center; gap: 6px;">
          <input type="range" id="bone-rot-y" min="-180" max="180" step="1" value="${degY}" style="flex: 1;" />
          <span id="bone-val-y" style="width: 48px; text-align: right; font-family: monospace; font-size: 11px;">${degY}&deg;</span>
        </div>
      </div>

      <div class="prop-row">
        <span class="prop-label" style="color: #3498db; font-weight: bold;">Z (Roll):</span>
        <div class="prop-slider-wrap" style="flex: 1; display: flex; align-items: center; gap: 6px;">
          <input type="range" id="bone-rot-z" min="-180" max="180" step="1" value="${degZ}" style="flex: 1;" />
          <span id="bone-val-z" style="width: 48px; text-align: right; font-family: monospace; font-size: 11px;">${degZ}&deg;</span>
        </div>
      </div>

      ${rigSystem ? (() => {
        const rollDeg = Math.round(((selectedBone?.userData?.boneRollRad || 0) * 180) / Math.PI);
        const cList = selectedBone ? rigSystem.getBoneConstraints(selectedBone) : [];
        const cRowsHtml = cList.length > 0
          ? cList.map((c, ci) => `
              <div style="display:flex; align-items:center; justify-content:space-between; font-size:10px; padding:2px 4px; background:rgba(255,255,255,0.04); border-radius:2px; margin-bottom:2px;">
                <span>${escapeHtml(c.name || c.type)}${c.targetBone ? ` → ${escapeHtml(c.targetBone)}` : ''}</span>
                <button class="blender-btn btn-rm-constraint" data-cst-idx="${ci}" style="padding:1px 5px; font-size:9px; background:transparent; border:1px solid var(--b-border-dark); color:#ff7675; border-radius:2px; cursor:pointer;">✕</button>
              </div>
            `).join('')
          : `<div style="font-size:10px; color:var(--b-text-muted);">No constraints on ${escapeHtml(selectedBone?.name || 'bone')}.</div>`;
        return `
          <div class="prop-row" style="margin-top:6px;">
            <span class="prop-label">Rest Roll:</span>
            <div style="flex:1; display:flex; align-items:center; gap:6px;">
              <input type="range" id="insp-bone-roll" min="-180" max="180" step="1" value="${rollDeg}" style="flex:1;" />
              <span id="insp-bone-roll-val" style="width:36px; text-align:right; font-family:monospace; font-size:10px;">${rollDeg}&deg;</span>
              <button class="blender-btn" id="btn-insp-recalc-roll" title="Auto-align bone roll Z-Up" style="padding:2px 5px; font-size:10px; background:var(--b-bg-input); border:1px solid var(--b-border-dark); color:var(--b-text-primary); border-radius:3px; cursor:pointer;">Z-Up</button>
            </div>
          </div>
          <div style="margin-top:8px; padding:6px; background:rgba(155, 89, 182, 0.08); border:1px solid rgba(155, 89, 182, 0.25); border-radius:4px;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
              <span style="font-size:10px; font-weight:600; color:#bb8fce;">CONSTRAINTS &amp; LIMITS</span>
              <button class="blender-btn" id="btn-insp-humanoid-limits" style="padding:2px 6px; font-size:9px; background:var(--b-bg-input); border:1px solid var(--b-border-dark); color:#fff; border-radius:2px; cursor:pointer;">🦴 Humanoid Limits</button>
            </div>
            ${cRowsHtml}
            <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:4px; margin-top:4px;">
              <button class="blender-btn" id="btn-insp-add-limit" style="padding:3px; font-size:9px; background:var(--b-bg-input); border:1px solid var(--b-border-dark); color:var(--b-text-primary); border-radius:2px; cursor:pointer;">+ Limit Rot</button>
              <button class="blender-btn" id="btn-insp-add-copyrot" style="padding:3px; font-size:9px; background:var(--b-bg-input); border:1px solid var(--b-border-dark); color:var(--b-text-primary); border-radius:2px; cursor:pointer;">+ Copy Rot</button>
              <button class="blender-btn" id="btn-insp-add-trackto" style="padding:3px; font-size:9px; background:var(--b-bg-input); border:1px solid var(--b-border-dark); color:var(--b-text-primary); border-radius:2px; cursor:pointer;">+ Track To</button>
            </div>
          </div>
        `;
      })() : ''}

      <!-- IK / FK Switch & Blending -->
      ${(() => {
        const ikChainKey = this.activeIKChainKey || 'leftArm';
        const curBlend = rigSystem ? rigSystem.getChainIKBlend(ikChainKey) : 1.0;
        const cols = rigSystem ? rigSystem.getBoneCollections(this.targetObject) : [];
        const colRowsHtml = cols.length === 0
          ? `<div style="font-size:10px; color:var(--b-text-secondary); padding:3px 0;">No bone collections yet.</div>`
          : cols.map((col, ci) => {
              const safeColName = escapeHtml(col.name);
              return `
            <div style="display:flex; align-items:center; gap:4px; margin-bottom:4px; font-size:10px;">
              <button class="blender-btn btn-insp-col-vis" data-col-name="${safeColName}" data-col-vis="${col.visible !== false ? '1' : '0'}" title="Toggle visibility" style="padding:2px 5px; background:var(--b-bg-input); border:1px solid var(--b-border-dark); border-radius:2px; cursor:pointer; color:${col.visible !== false ? '#f39c12' : '#666'};">${col.visible !== false ? '👁' : '🚫'}</button>
              <span style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${safeColName}">${safeColName} (${col.bones?.length || 0})</span>
              <button class="blender-btn btn-insp-col-assign" data-col-name="${safeColName}" title="Assign selected bone" style="padding:2px 5px; background:var(--b-bg-input); border:1px solid var(--b-border-dark); color:var(--b-text-primary); border-radius:2px; cursor:pointer;">+</button>
              <button class="blender-btn btn-insp-col-unassign" data-col-name="${safeColName}" title="Remove selected bone" style="padding:2px 5px; background:var(--b-bg-input); border:1px solid var(--b-border-dark); color:var(--b-text-primary); border-radius:2px; cursor:pointer;">−</button>
              <button class="blender-btn btn-insp-col-sel" data-col-name="${safeColName}" title="Select bones in collection" style="padding:2px 5px; background:var(--b-bg-input); border:1px solid var(--b-border-dark); color:var(--b-text-primary); border-radius:2px; cursor:pointer;">Sel</button>
              <button class="blender-btn btn-insp-col-del" data-col-idx="${ci}" title="Delete collection" style="padding:2px 5px; background:none; border:1px solid var(--b-border-dark); color:#ff7675; border-radius:2px; cursor:pointer;">✕</button>
            </div>
          `;
            }).join('');
        return `
          <div style="margin-top: 10px; padding: 8px; background: rgba(0, 206, 201, 0.06); border: 1px solid rgba(0, 206, 201, 0.25); border-radius: 4px;">
            <div style="font-size: 10px; font-weight: 600; color: #00cec9; margin-bottom: 6px;">IK / FK SWITCH &amp; BLEND:</div>
            <div class="prop-row" style="margin-bottom: 6px;">
              <span class="prop-label">Chain:</span>
              <select id="sel-insp-ik-chain" style="flex:1; background:var(--b-bg-input); color:var(--b-text-primary); border:1px solid var(--b-border-dark); padding:2px 4px; border-radius:3px; font-size:11px;">
                <option value="leftArm" ${ikChainKey === 'leftArm' ? 'selected' : ''}>Left Arm</option>
                <option value="rightArm" ${ikChainKey === 'rightArm' ? 'selected' : ''}>Right Arm</option>
                <option value="leftLeg" ${ikChainKey === 'leftLeg' ? 'selected' : ''}>Left Leg</option>
                <option value="rightLeg" ${ikChainKey === 'rightLeg' ? 'selected' : ''}>Right Leg</option>
              </select>
            </div>
            <div class="prop-row" style="margin-bottom: 6px;">
              <span class="prop-label">IK Blend:</span>
              <div style="flex:1; display:flex; align-items:center; gap:6px;">
                <input type="range" id="insp-ik-blend" min="0" max="1" step="0.05" value="${curBlend}" style="flex:1;" />
                <span id="insp-ik-blend-val" style="width:34px; text-align:right; font-family:monospace; font-size:10px;">${curBlend.toFixed(2)}</span>
              </div>
            </div>
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:6px;">
              <button class="blender-btn" id="btn-insp-snap-ik-to-fk" style="padding:4px; font-size:10px; background:var(--b-bg-input); border:1px solid var(--b-border-dark); color:var(--b-text-primary); border-radius:3px; cursor:pointer;">IK &larr; FK</button>
              <button class="blender-btn" id="btn-insp-snap-fk-to-ik" style="padding:4px; font-size:10px; background:var(--b-bg-input); border:1px solid var(--b-border-dark); color:var(--b-text-primary); border-radius:3px; cursor:pointer;">FK &larr; IK</button>
            </div>
          </div>

          <div style="margin-top: 10px; padding: 8px; background: rgba(255, 255, 255, 0.03); border: 1px solid var(--b-border-dark); border-radius: 4px;">
            <div style="font-size: 10px; font-weight: 600; color: var(--b-text-secondary); margin-bottom: 6px;">BONE COLLECTIONS:</div>
            <div style="display:flex; gap:4px; margin-bottom:6px;">
              <input type="text" id="insp-bone-col-name" placeholder="Collection name..." style="flex:1; background:var(--b-bg-input); color:var(--b-text-primary); border:1px solid var(--b-border-dark); padding:2px 6px; border-radius:3px; font-size:10px;" />
              <button class="blender-btn" id="btn-insp-add-bone-col" style="padding:2px 8px; font-size:10px; background:var(--b-bg-input); border:1px solid var(--b-border-dark); color:var(--b-text-primary); border-radius:3px; cursor:pointer;">+ New</button>
            </div>
            ${colRowsHtml}
          </div>
        `;
      })()}

      <!-- Quick Bone Tools Grid -->
      <div style="margin-top: 14px; display: grid; grid-template-columns: 1fr 1fr; gap: 6px;">
        <button class="blender-btn" id="btn-inspector-toggle-ik" style="padding: 5px; font-size: 11px; background: ${rigSystem?.isIKEnabled ? '#00cec9' : 'var(--b-bg-input)'}; border: 1px solid var(--b-border-dark); color: ${rigSystem?.isIKEnabled ? '#000' : 'var(--b-text-primary)'}; cursor: pointer; border-radius: 3px; font-weight:600;">
          🦾 Two-Bone IK ${rigSystem?.isIKEnabled ? '(ON)' : '(OFF)'}
        </button>
        <button class="blender-btn" id="btn-inspector-toggle-wp" style="padding: 5px; font-size: 11px; background: ${isWPMode ? '#e74c3c' : 'var(--b-bg-input)'}; border: 1px solid var(--b-border-dark); color: ${isWPMode ? '#fff' : 'var(--b-text-primary)'}; cursor: pointer; border-radius: 3px; font-weight:600;">
          🎨 Weight Paint ${isWPMode ? '(ON)' : '(OFF)'}
        </button>
        <button class="blender-btn" id="btn-bone-key-single" style="padding: 5px; font-size: 11px; background: var(--b-bg-input); border: 1px solid var(--b-border-dark); color: var(--b-text-primary); cursor: pointer; border-radius: 3px;">
          🔑 Key Bone (I)
        </button>
        <button class="blender-btn" id="btn-bone-key-all" style="padding: 5px; font-size: 11px; background: var(--b-bg-input); border: 1px solid var(--b-border-dark); color: var(--b-text-primary); cursor: pointer; border-radius: 3px;">
          🔑 Key All (Shift+I)
        </button>
        <button class="blender-btn" id="btn-bone-reset-single" style="padding: 5px; font-size: 11px; background: var(--b-bg-input); border: 1px solid var(--b-border-dark); color: var(--b-text-primary); cursor: pointer; border-radius: 3px;">
          🔄 Reset Bone
        </button>
        <button class="blender-btn" id="btn-bone-reset-all" style="padding: 5px; font-size: 11px; background: var(--b-bg-input); border: 1px solid var(--b-border-dark); color: var(--b-text-primary); cursor: pointer; border-radius: 3px;">
          🧍 Reset All
        </button>
        <button class="blender-btn" id="btn-bone-mirror-lr" style="padding: 5px; font-size: 11px; background: var(--b-bg-input); border: 1px solid var(--b-border-dark); color: var(--b-text-primary); cursor: pointer; border-radius: 3px;">
          🪞 Mirror L ➔ R
        </button>
        <button class="blender-btn" id="btn-bone-mirror-rl" style="padding: 5px; font-size: 11px; background: var(--b-bg-input); border: 1px solid var(--b-border-dark); color: var(--b-text-primary); border-radius: 3px;">
          🪞 Mirror R ➔ L
        </button>
      </div>

      ${weightBrushSectionHtml}
    `;

    // Bind slider & button events
    const select = card.body.querySelector('#inspector-bone-select');
    select?.addEventListener('change', (e) => {
      const b = bones.find(bn => bn.name === e.target.value);
      if (b && rigSystem) {
        this.selectedBone = b;
        rigSystem.selectBone(b);
        this.render();
      }
    });

    let prePoseSnap = null;
    const capturePrePose = () => {
      if (!prePoseSnap && skeleton?.bones) {
        prePoseSnap = {
          quats: skeleton.bones.map(b => b.quaternion.clone()),
          positions: skeleton.bones.map(b => b.position.clone()),
        };
      }
    };
    const commitPoseUndo = () => {
      if (!prePoseSnap || !skeleton?.bones || !this.sceneManager?.executeCommand) {
        prePoseSnap = null;
        return;
      }
      const afterQuats = skeleton.bones.map(b => b.quaternion.clone());
      const afterPositions = skeleton.bones.map(b => b.position.clone());
      let changed = false;
      for (let i = 0; i < skeleton.bones.length; i++) {
        if (Math.abs(1 - Math.abs(afterQuats[i].dot(prePoseSnap.quats[i]))) > 1e-6 ||
            afterPositions[i].distanceToSquared(prePoseSnap.positions[i]) > 1e-9) {
          changed = true;
          break;
        }
      }
      if (changed) {
        this.sceneManager.executeCommand(new PoseChangeCommand(
          skeleton,
          prePoseSnap.quats,
          afterQuats,
          prePoseSnap.positions,
          afterPositions,
          () => rigSystem?.updateSkeletonHelper(),
          `Pose ${this.selectedBone?.name || 'Bone'}`
        ));
      }
      prePoseSnap = null;
    };

    const updateBoneRot = () => {
      if (!this.selectedBone) return;
      capturePrePose();
      const x = parseFloat(card.body.querySelector('#bone-rot-x').value);
      const y = parseFloat(card.body.querySelector('#bone-rot-y').value);
      const z = parseFloat(card.body.querySelector('#bone-rot-z').value);

      if (this.selectedBone.rotation.isEuler) {
        this.selectedBone.rotation.set(x * Math.PI / 180, y * Math.PI / 180, z * Math.PI / 180, 'XYZ');
      }
      this.selectedBone.updateMatrixWorld(true);

      if (rigSystem?.onBoneRotated) rigSystem.onBoneRotated(this.selectedBone);

      // Reflect clamped values if a Limit Rotation constraint constrained the bone
      const rx = (this.selectedBone.rotation.x * 180 / Math.PI).toFixed(1);
      const ry = (this.selectedBone.rotation.y * 180 / Math.PI).toFixed(1);
      const rz = (this.selectedBone.rotation.z * 180 / Math.PI).toFixed(1);
      card.body.querySelector('#bone-val-x').innerHTML = `${rx}&deg;`;
      card.body.querySelector('#bone-val-y').innerHTML = `${ry}&deg;`;
      card.body.querySelector('#bone-val-z').innerHTML = `${rz}&deg;`;

      if (this.sceneManager?.requestRender) this.sceneManager.requestRender();
    };

    ['x', 'y', 'z'].forEach(axis => {
      const sl = card.body.querySelector(`#bone-rot-${axis}`);
      sl?.addEventListener('pointerdown', capturePrePose);
      sl?.addEventListener('focus', capturePrePose);
      sl?.addEventListener('input', updateBoneRot);
      sl?.addEventListener('change', commitPoseUndo);
    });

    card.body.querySelector('#insp-bone-roll')?.addEventListener('input', (e) => {
      const deg = parseFloat(e.target.value) || 0;
      const lbl = card.body.querySelector('#insp-bone-roll-val');
      if (lbl) lbl.innerHTML = `${Math.round(deg)}&deg;`;
      if (rigSystem && this.selectedBone) {
        rigSystem.setBoneRoll(this.selectedBone, deg * DEG2RAD, { recordUndo: false });
      }
    });
    card.body.querySelector('#btn-insp-recalc-roll')?.addEventListener('click', () => {
      if (rigSystem && this.targetObject) {
        rigSystem.recalculateBoneRoll(this.targetObject);
        this.render();
      }
    });
    card.body.querySelector('#btn-insp-humanoid-limits')?.addEventListener('click', () => {
      if (rigSystem) {
        rigSystem.applyHumanoidJointLimits(this.targetObject);
        this.render();
      }
    });
    card.body.querySelector('#btn-insp-add-limit')?.addEventListener('click', () => {
      if (rigSystem && this.selectedBone) {
        rigSystem.addBoneConstraint(this.selectedBone, {
          type: 'limitRotation',
          name: 'Limit Rotation',
          minDeg: { x: -45, y: -45, z: -45 },
          maxDeg: { x: 45, y: 45, z: 45 },
        });
        this.render();
      }
    });
    card.body.querySelector('#btn-insp-add-copyrot')?.addEventListener('click', () => {
      if (rigSystem && this.selectedBone) {
        const idx = bones.indexOf(this.selectedBone);
        const mirrorIdx = idx >= 0 ? rigSystem._findMirrorBoneIndex(skeleton, idx) : -1;
        const target = mirrorIdx >= 0 && mirrorIdx !== idx ? bones[mirrorIdx] : (bones[0] || this.selectedBone);
        rigSystem.addBoneConstraint(this.selectedBone, {
          type: 'copyRotation',
          name: 'Copy Rotation',
          targetBone: target.name,
        });
        this.render();
      }
    });
    card.body.querySelector('#btn-insp-add-trackto')?.addEventListener('click', () => {
      if (rigSystem && this.selectedBone) {
        const target = bones.find(b => /head|hand|foot/i.test(b.name) && b !== this.selectedBone) || bones[0];
        if (target) {
          rigSystem.addBoneConstraint(this.selectedBone, {
            type: 'trackTo',
            name: 'Track To',
            targetBone: target.name,
          });
          this.render();
        }
      }
    });
    card.body.querySelectorAll('.btn-rm-constraint').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (rigSystem && this.selectedBone) {
          rigSystem.removeBoneConstraint(this.selectedBone, Number(btn.dataset.cstIdx));
          this.render();
        }
      });
    });
    card.body.querySelector('#btn-bone-key-single')?.addEventListener('click', () => {
      rigSystem?.keyframePoseToTimeline(this.targetObject, this.selectedBone);
    });
    card.body.querySelector('#btn-bone-key-all')?.addEventListener('click', () => {
      rigSystem?.keyframePoseToTimeline(this.targetObject, 'all');
    });

    card.body.querySelector('#btn-inspector-toggle-pose')?.addEventListener('click', () => {
      if (rigSystem) {
        rigSystem.setPoseMode(!rigSystem.isPoseMode, this.targetObject);
        this.render();
      }
    });

    card.body.querySelector('#btn-inspector-toggle-edit-bones')?.addEventListener('click', () => {
      if (rigSystem) {
        if (rigSystem.isEditBoneMode) rigSystem.exitEditBoneMode();
        else rigSystem.enterEditBoneMode(this.targetObject);
        this.render();
      }
    });

    const renameInput = card.body.querySelector('#insp-edit-bone-name');
    renameInput?.addEventListener('focus', () => { this.isEditingInput = true; });
    renameInput?.addEventListener('blur', () => { this.isEditingInput = false; });
    card.body.querySelector('#btn-insp-rename-bone')?.addEventListener('click', () => {
      if (rigSystem && this.selectedBone && renameInput) {
        rigSystem.renameBone(this.selectedBone, renameInput.value);
        this.isEditingInput = false;
        this.render();
      }
    });

    card.body.querySelector('#insp-edit-bone-parent')?.addEventListener('change', (e) => {
      if (rigSystem && this.selectedBone) {
        rigSystem.reparentBone(this.selectedBone, e.target.value || null);
        this.render();
      }
    });

    card.body.querySelector('#chk-insp-bone-connect')?.addEventListener('change', (e) => {
      if (rigSystem && this.selectedBone) {
        rigSystem.setBoneConnected(this.selectedBone, e.target.checked);
        this.render();
      }
    });

    card.body.querySelector('#sel-insp-ik-chain')?.addEventListener('change', (e) => {
      this.activeIKChainKey = e.target.value;
      this.render();
    });
    card.body.querySelector('#insp-ik-blend')?.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      const lbl = card.body.querySelector('#insp-ik-blend-val');
      if (lbl) lbl.textContent = val.toFixed(2);
      const key = card.body.querySelector('#sel-insp-ik-chain')?.value || this.activeIKChainKey || 'leftArm';
      this.activeIKChainKey = key;
      if (rigSystem) {
        if (!rigSystem.isIKEnabled && rigSystem.ikChains.size === 0) {
          rigSystem.activeCharacter = this.targetObject;
          rigSystem.setupTwoBoneIK(this.targetObject);
        }
        rigSystem.setChainIKBlend(key, val);
        if (this.sceneManager?.requestRender) this.sceneManager.requestRender();
      }
    });
    card.body.querySelector('#btn-insp-snap-ik-to-fk')?.addEventListener('click', () => {
      const key = card.body.querySelector('#sel-insp-ik-chain')?.value || this.activeIKChainKey || 'leftArm';
      this.activeIKChainKey = key;
      if (rigSystem) {
        rigSystem.activeCharacter = this.targetObject;
        rigSystem.snapIKToFK(key);
        this.render();
      }
    });
    card.body.querySelector('#btn-insp-snap-fk-to-ik')?.addEventListener('click', () => {
      const key = card.body.querySelector('#sel-insp-ik-chain')?.value || this.activeIKChainKey || 'leftArm';
      this.activeIKChainKey = key;
      if (rigSystem) {
        rigSystem.activeCharacter = this.targetObject;
        rigSystem.snapFKToIK(key);
        this.render();
      }
    });

    const colNameInput = card.body.querySelector('#insp-bone-col-name');
    colNameInput?.addEventListener('focus', () => { this.isEditingInput = true; });
    colNameInput?.addEventListener('blur', () => { this.isEditingInput = false; });
    card.body.querySelector('#btn-insp-add-bone-col')?.addEventListener('click', () => {
      if (rigSystem) {
        const name = colNameInput?.value?.trim() || `Collection_${rigSystem.getBoneCollections(this.targetObject).length + 1}`;
        rigSystem.createBoneCollection(name, this.targetObject, this.selectedBone ? [this.selectedBone.name] : []);
        this.isEditingInput = false;
        this.render();
      }
    });
    card.body.querySelectorAll('.btn-insp-col-vis').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (!rigSystem) return;
        const vis = btn.dataset.colVis !== '1';
        rigSystem.setBoneCollectionVisibility(btn.dataset.colName, vis, this.targetObject);
        if (this.sceneManager?.requestRender) this.sceneManager.requestRender();
        this.render();
      });
    });
    card.body.querySelectorAll('.btn-insp-col-assign').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (rigSystem && this.selectedBone) {
          rigSystem.assignBoneToCollection(this.selectedBone, btn.dataset.colName, this.targetObject);
          this.render();
        }
      });
    });
    card.body.querySelectorAll('.btn-insp-col-unassign').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (rigSystem && this.selectedBone) {
          rigSystem.removeBoneFromCollection(this.selectedBone, btn.dataset.colName, this.targetObject);
          this.render();
        }
      });
    });
    card.body.querySelectorAll('.btn-insp-col-sel').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (rigSystem) {
          const picked = rigSystem.selectBoneCollection(btn.dataset.colName, this.targetObject);
          if (picked?.[0]) this.selectedBone = picked[0];
          this.render();
        }
      });
    });
    card.body.querySelectorAll('.btn-insp-col-del').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (rigSystem) {
          rigSystem.deleteBoneCollection(Number(btn.dataset.colIdx), this.targetObject);
          this.render();
        }
      });
    });

    card.body.querySelector('#btn-insp-extrude-bone')?.addEventListener('click', () => {
      if (rigSystem) {
        this.selectedBone = rigSystem.extrudeBone(this.selectedBone) || this.selectedBone;
        this.render();
      }
    });

    card.body.querySelector('#btn-insp-add-bone')?.addEventListener('click', () => {
      if (rigSystem) {
        this.selectedBone = rigSystem.addBone(this.selectedBone) || this.selectedBone;
        this.render();
      }
    });

    card.body.querySelector('#btn-insp-delete-bone')?.addEventListener('click', () => {
      if (rigSystem && this.selectedBone) {
        rigSystem.deleteBone(this.selectedBone);
        this.selectedBone = rigSystem.activeBone || skeleton.bones[0] || null;
        this.render();
      }
    });

    card.body.querySelector('#btn-insp-sym-bones')?.addEventListener('click', () => {
      rigSystem?.symmetrizeBones('left_to_right');
      this.render();
    });

    card.body.querySelector('#insp-wp-mode')?.addEventListener('change', (e) => {
      rigSystem?.setWeightBrush({ mode: e.target.value });
    });
    card.body.querySelector('#insp-wp-radius')?.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      const lbl = card.body.querySelector('#insp-wp-radius-val');
      if (lbl) lbl.textContent = val.toFixed(2);
      rigSystem?.setWeightBrush({ radius: val });
    });
    card.body.querySelector('#insp-wp-strength')?.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      const lbl = card.body.querySelector('#insp-wp-strength-val');
      if (lbl) lbl.textContent = val.toFixed(2);
      rigSystem?.setWeightBrush({ strength: val });
    });
    card.body.querySelector('#insp-wp-mirror')?.addEventListener('change', (e) => {
      rigSystem?.setWeightBrush({ symmetryX: !!e.target.checked });
    });
    card.body.querySelector('#btn-insp-wp-smooth')?.addEventListener('click', () => {
      rigSystem?.smoothWeights(rigSystem.weightPaintMesh, this.selectedBone, 1, 0.5, true);
    });
    card.body.querySelector('#btn-insp-wp-norm')?.addEventListener('click', () => {
      rigSystem?.normalizeWeights(rigSystem.weightPaintMesh, true);
    });
    card.body.querySelector('#btn-insp-wp-clean')?.addEventListener('click', () => {
      rigSystem?.cleanWeights(rigSystem.weightPaintMesh, 0.01, 4, true);
    });
    card.body.querySelector('#btn-insp-wp-mirror-x')?.addEventListener('click', () => {
      rigSystem?.mirrorWeightsX(rigSystem.weightPaintMesh, 'left', null, true);
    });

    card.body.querySelector('#btn-inspector-toggle-ik')?.addEventListener('click', () => {
      if (rigSystem) {
        rigSystem.activeCharacter = this.targetObject;
        rigSystem.setIKEnabled(!rigSystem.isIKEnabled);
        this.render();
      }
    });

    card.body.querySelector('#btn-inspector-toggle-wp')?.addEventListener('click', () => {
      if (rigSystem) {
        rigSystem.toggleWeightPaintMode(this.targetObject);
        this.render();
      }
    });

    card.body.querySelector('#btn-bone-reset-single')?.addEventListener('click', () => {
      if (this.selectedBone && rigSystem) {
        rigSystem.resetPose(this.targetObject, this.selectedBone.name);
        this.render();
      }
    });

    card.body.querySelector('#btn-bone-reset-all')?.addEventListener('click', () => {
      if (rigSystem) {
        rigSystem.resetPose(this.targetObject, null);
        this.render();
      }
    });

    card.body.querySelector('#btn-bone-mirror-lr')?.addEventListener('click', () => {
      if (rigSystem) {
        rigSystem.mirrorPose(this.targetObject, 'left_to_right');
        this.render();
      }
    });

    card.body.querySelector('#btn-bone-mirror-rl')?.addEventListener('click', () => {
      if (rigSystem) {
        rigSystem.mirrorPose(this.targetObject, 'right_to_left');
        this.render();
      }
    });

    this.contentBody.appendChild(card.card);
  }

  renderIdentitySection() {
    const ident = document.createElement('div');
    ident.className = 'prop-object-identity';

    const objType = this.targetObject.isMesh ? 'mesh' : (this.targetObject.isLight ? 'light' : 'camera');
    ident.innerHTML = `
      <svg class="prop-object-icon" viewBox="0 0 16 16">
        <path d="M8 1l7 4v6l-7 4-7-4V5l7-4z"/>
      </svg>
      <input type="text" class="prop-object-name-input" value="${escapeHtml(this.targetObject.name || 'Object')}" title="Object Name" spellcheck="false" />
    `;

    const nameInput = ident.querySelector('.prop-object-name-input');
    nameInput.addEventListener('change', (e) => {
      const newName = e.target.value.trim() || 'Object';
      if (this.sceneManager?.renameObject) {
        this.sceneManager.renameObject(this.targetObject, newName);
      } else {
        this.targetObject.name = newName;
      }
      window.dispatchEvent(new CustomEvent('blender:objectRenamed', {
        detail: { uuid: this.targetObject.uuid, name: newName }
      }));
    });

    this.contentBody.appendChild(ident);
  }

  // =========================================================================
  // Transform Section with Drag-To-Scrub inputs & Direct Numeric / Math Editing
  // =========================================================================
  renderTransformSection() {
    const card = this.createCard('Transform', true);

    const pos = this.targetObject.position || { x: 0, y: 0, z: 0 };
    const rot = this.targetObject.rotation ? {
      x: this.targetObject.rotation.x * RAD2DEG,
      y: this.targetObject.rotation.y * RAD2DEG,
      z: this.targetObject.rotation.z * RAD2DEG
    } : { x: 0, y: 0, z: 0 };
    const scale = this.targetObject.scale || { x: 1, y: 1, z: 1 };
    const dim = this.getDimensions(this.targetObject);

    card.body.innerHTML = `
      <!-- Location -->
      <div class="prop-row">
        <span class="prop-label">Location</span>
        <div class="prop-field-group">
          ${this.createScrubGroupHTML('pos', 'X', pos.x, 'm')}
          ${this.createScrubGroupHTML('pos', 'Y', pos.y, 'm')}
          ${this.createScrubGroupHTML('pos', 'Z', pos.z, 'm')}
        </div>
      </div>

      <!-- Rotation -->
      <div class="prop-row">
        <span class="prop-label">Rotation</span>
        <div class="prop-field-group">
          ${this.createScrubGroupHTML('rot', 'X', rot.x, '°')}
          ${this.createScrubGroupHTML('rot', 'Y', rot.y, '°')}
          ${this.createScrubGroupHTML('rot', 'Z', rot.z, '°')}
        </div>
      </div>

      <!-- Scale -->
      <div class="prop-row">
        <span class="prop-label">Scale</span>
        <div class="prop-field-group">
          ${this.createScrubGroupHTML('scale', 'X', scale.x, '')}
          ${this.createScrubGroupHTML('scale', 'Y', scale.y, '')}
          ${this.createScrubGroupHTML('scale', 'Z', scale.z, '')}
        </div>
      </div>

      <!-- Dimensions -->
      <div class="prop-row">
        <span class="prop-label">Dimensions</span>
        <div class="prop-field-group">
          ${this.createScrubGroupHTML('dim', 'X', dim.x, 'm')}
          ${this.createScrubGroupHTML('dim', 'Y', dim.y, 'm')}
          ${this.createScrubGroupHTML('dim', 'Z', dim.z, 'm')}
        </div>
      </div>
    `;

    this.setupScrubHandlers(card.body);
    this.contentBody.appendChild(card.card);
  }

  createScrubGroupHTML(property, axis, value, unit) {
    const num = Number(value).toFixed(2);
    return `
      <div class="scrub-input-wrap" data-prop="${property}" data-axis="${axis.toLowerCase()}" data-unit="${unit}">
        <span class="scrub-badge axis-${axis.toLowerCase()}">${axis}</span>
        <input type="text" class="scrub-input" value="${num}${unit}" autocomplete="off" spellcheck="false" />
      </div>
    `;
  }

  getDimensions(obj) {
    if (!obj) return { x: 0, y: 0, z: 0 };
    try {
      const box = new THREE.Box3().setFromObject(obj);
      const size = new THREE.Vector3();
      box.getSize(size);
      return { x: size.x, y: size.y, z: size.z };
    } catch (e) {
      return { x: 0, y: 0, z: 0 };
    }
  }

  _evaluateNumericExpression(expr, fallback = 0) {
    if (typeof expr === 'number') return expr;
    if (!expr || typeof expr !== 'string') return fallback;
    const cleaned = expr.trim().replace(/°|m|px|x/gi, '');
    if (!cleaned) return fallback;
    const directNum = parseFloat(cleaned);
    if (!isNaN(directNum) && !/[+\-*/^()]/.test(cleaned)) {
      return directNum;
    }
    try {
      let sanitized = cleaned
        .replace(/\bpi\b/gi, String(Math.PI))
        .replace(/\be\b/gi, String(Math.E));
      if (/^[\d\s+\-*/().%]+$/.test(sanitized)) {
        const result = Function('"use strict"; return (' + sanitized + ')')();
        return isFinite(result) ? result : fallback;
      }
    } catch (e) {
      console.warn('[Inspector] Invalid numeric expression:', expr);
    }
    return isNaN(directNum) ? fallback : directNum;
  }

  setupScrubHandlers(containerEl) {
    const scrubWraps = Array.from(containerEl.querySelectorAll('.scrub-input-wrap'));

    scrubWraps.forEach((wrap, index) => {
      const prop = wrap.dataset.prop;
      const axis = wrap.dataset.axis;
      const unit = wrap.dataset.unit || '';
      const input = wrap.querySelector('.scrub-input');
      const badge = wrap.querySelector('.scrub-badge');

      let startX = 0;
      let startVal = 0;
      let isDragging = false;
      let hasMoved = false;
      let preTransformSnapshot = null;

      const takeSnapshot = () => {
        if (!this.targetObject) return null;
        return {
          position: this.targetObject.position.clone(),
          quaternion: this.targetObject.quaternion.clone(),
          scale: this.targetObject.scale.clone()
        };
      };

      const commitUndo = (pre) => {
        if (!pre || !this.targetObject || !this.sceneManager) return;
        const post = {
          position: this.targetObject.position.clone(),
          quaternion: this.targetObject.quaternion.clone(),
          scale: this.targetObject.scale.clone()
        };
        if (!pre.position.equals(post.position) ||
            !pre.quaternion.equals(post.quaternion) ||
            !pre.scale.equals(post.scale)) {
          const cmd = new TransformCommand(this.targetObject, pre, post, () => {
            this.updateTransformFields();
          });
          this.sceneManager.executeCommand(cmd);
        }
      };

      // =====================================================================
      // 1. DRAG-TO-SCRUB: ATTACHED ONLY TO THE BADGE (X, Y, Z)
      // =====================================================================
      if (badge) {
        badge.title = `Drag horizontally on ${axis.toUpperCase()} to scrub value, or click input to type`;
        badge.addEventListener('mousedown', (e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          e.stopPropagation();

          startX = e.clientX;
          startVal = this.getCurrentPropValue(prop, axis);
          isDragging = true;
          hasMoved = false;
          preTransformSnapshot = takeSnapshot();
          this.isEditingInput = true;
          document.body.style.cursor = 'ew-resize';

          const onMouseMove = (ev) => {
            if (!isDragging) return;
            const deltaX = ev.clientX - startX;
            if (Math.abs(deltaX) > 2) hasMoved = true;

            // Calibration: Smooth, predictable, precise step
            let step = (prop === 'scale' || prop === 'dim') ? 0.005 : 0.01;
            if (ev.shiftKey) step *= 0.1; // Fine precision
            if (ev.ctrlKey) step *= 10.0; // Coarse snap

            let newVal = startVal + deltaX * step;
            if (prop === 'rot') {
              step = ev.shiftKey ? 0.05 : (ev.ctrlKey ? 5.0 : 0.5);
              newVal = startVal + deltaX * step;
            }
            if (prop === 'scale' || prop === 'dim') {
              newVal = Math.max(0.0001, newVal);
            }

            this.applyPropValue(prop, axis, newVal);
            input.value = `${newVal.toFixed(2)}${unit}`;
            this.updateRelatedFields(prop);
            this._emitObjectTransformed('interactive');
          };

          const onMouseUp = () => {
            isDragging = false;
            this.isEditingInput = false;
            document.body.style.cursor = '';
            window.removeEventListener('mousemove', onMouseMove);
            window.removeEventListener('mouseup', onMouseUp);

            if (hasMoved) {
              this.notifyTransformChange();
              commitUndo(preTransformSnapshot);
            } else {
              // Clicked badge without dragging -> Focus the input to type
              input.focus();
            }
          };

          window.addEventListener('mousemove', onMouseMove);
          window.addEventListener('mouseup', onMouseUp);
        });
      }

      // =====================================================================
      // 2. DIRECT NUMERIC TYPING: PURE INPUT INTERACTION & REALTIME SYNC
      // =====================================================================
      wrap.addEventListener('click', (e) => {
        if (e.target !== badge && document.activeElement !== input) {
          input.focus();
          input.select();
        }
      });

      input.addEventListener('focus', () => {
        this.isEditingInput = true;
        preTransformSnapshot = takeSnapshot();
        // Show raw number without unit for effortless typing
        const rawNum = this.getCurrentPropValue(prop, axis);
        input.value = Number.isInteger(rawNum) ? rawNum.toString() : rawNum.toFixed(3);
        setTimeout(() => input.select(), 0);
      });

      input.addEventListener('click', () => {
        input.select();
      });

      // Realtime sync as user types digits or math expressions
      input.addEventListener('input', () => {
        if (!this.targetObject) return;
        const currentVal = this.getCurrentPropValue(prop, axis);
        const parsed = this._evaluateNumericExpression(input.value, null);
        if (parsed !== null && !isNaN(parsed) && isFinite(parsed)) {
          this.applyPropValue(prop, axis, parsed);
          this.updateRelatedFields(prop);
          this.notifyTransformChange();
        }
      });

      const commitInput = () => {
        this.isEditingInput = false;
        const currentVal = this.getCurrentPropValue(prop, axis);
        const parsed = this._evaluateNumericExpression(input.value, currentVal);

        this.applyPropValue(prop, axis, parsed);
        input.value = `${parsed.toFixed(2)}${unit}`;
        this.updateRelatedFields(prop);
        this.notifyTransformChange();
        commitUndo(preTransformSnapshot);
      };

      input.addEventListener('blur', () => {
        if (this.isEditingInput) {
          commitInput();
        }
      });

      input.addEventListener('keydown', (e) => {
        // Prevent key events in this input from bubbling to 3D shortcuts (G, R, S, Delete)
        e.stopPropagation();

        if (e.key === 'Enter') {
          e.preventDefault();
          commitInput();
          input.blur();
        } else if (e.key === 'Tab') {
          e.preventDefault();
          commitInput();
          const nextIndex = e.shiftKey
            ? (index - 1 + scrubWraps.length) % scrubWraps.length
            : (index + 1) % scrubWraps.length;
          const nextInput = scrubWraps[nextIndex]?.querySelector('.scrub-input');
          if (nextInput) {
            setTimeout(() => {
              nextInput.focus();
              nextInput.select();
            }, 10);
          }
        } else if (e.key === 'Escape') {
          e.preventDefault();
          this.isEditingInput = false;
          input.value = `${this.getCurrentPropValue(prop, axis).toFixed(2)}${unit}`;
          input.blur();
        }
      });
    });
  }

  updateRelatedFields(changedProp) {
    if (!this.contentBody || !this.targetObject) return;
    const wraps = this.contentBody.querySelectorAll('.scrub-input-wrap');
    wraps.forEach((wrap) => {
      const p = wrap.dataset.prop;
      const a = wrap.dataset.axis;
      const u = wrap.dataset.unit || '';
      const inp = wrap.querySelector('.scrub-input');
      if (p !== changedProp && inp && document.activeElement !== inp) {
        const v = this.getCurrentPropValue(p, a);
        inp.value = `${v.toFixed(2)}${u}`;
      }
    });
  }

  getCurrentPropValue(prop, axis) {
    if (!this.targetObject) return 0;
    if (prop === 'pos') {
      return this.targetObject.position ? this.targetObject.position[axis] : 0;
    } else if (prop === 'rot') {
      return this.targetObject.rotation ? this.targetObject.rotation[axis] * RAD2DEG : 0;
    } else if (prop === 'scale') {
      return this.targetObject.scale ? this.targetObject.scale[axis] : 1;
    } else if (prop === 'dim') {
      return this.getDimensions(this.targetObject)[axis] || 0;
    }
    return 0;
  }

  applyPropValue(prop, axis, val) {
    if (!this.targetObject) return;
    if (prop === 'pos' && this.targetObject.position) {
      this.targetObject.position[axis] = val;
    } else if (prop === 'rot' && this.targetObject.rotation) {
      this.targetObject.rotation[axis] = val * DEG2RAD;
    } else if (prop === 'scale' && this.targetObject.scale) {
      this.targetObject.scale[axis] = Math.max(0.0001, val);
    } else if (prop === 'dim') {
      const currentDim = this.getDimensions(this.targetObject);
      if (currentDim[axis] > 0.0001 && val > 0) {
        const ratio = val / currentDim[axis];
        this.targetObject.scale[axis] *= ratio;
      }
    }

    if (this.targetObject.updateMatrixWorld) {
      this.targetObject.updateMatrixWorld(true);
    }

    if (this.sceneManager?.requestRender) {
      this.sceneManager.requestRender();
    }
  }

  _emitObjectTransformed(phase = 'interactive', force = false) {
    if (!this.targetObject || typeof window === 'undefined' || typeof CustomEvent === 'undefined') return;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (!force && phase === 'interactive' && now - (this._lastTransformEventTime || 0) < 50) return;
    this._lastTransformEventTime = now;
    window.dispatchEvent(new CustomEvent('blender:objectTransformed', {
      detail: { object: this.targetObject, source: 'inspector', phase }
    }));
  }

  notifyTransformChange() {
    if (this.sceneManager?.onTransformChanged) {
      this.sceneManager.onTransformChanged(this.targetObject);
    }
    window.dispatchEvent(new CustomEvent('blender:transformUpdated', { detail: this.targetObject }));
    this._emitObjectTransformed('interactive', false);
  }

  updateTransformFields() {
    if (!this.contentBody || !this.targetObject) return;

    const wraps = this.contentBody.querySelectorAll('.scrub-input-wrap');
    wraps.forEach((wrap) => {
      const prop = wrap.dataset.prop;
      const axis = wrap.dataset.axis;
      const unit = wrap.dataset.unit || '';
      const input = wrap.querySelector('.scrub-input');
      // Do not overwrite field if user is currently typing in it!
      if (document.activeElement === input) return;
      const val = this.getCurrentPropValue(prop, axis);
      input.value = `${val.toFixed(2)}${unit}`;
    });
  }

  // =========================================================================
  // Material Section (PBR Properties)
  // =========================================================================
  renderCameraSection(entry) {
    const cam = entry?.camera;
    if (!cam) return;
    const cm = window.cameraManager;
    const card = this.createCard('Camera', true);
    const sensor = 24;
    const focal = sensor / (2 * Math.tan((cam.fov * Math.PI) / 360));
    const isActive = cm?.getActiveCameraObject() === entry.group;
    const looking = cm?.lookingThrough === entry.group;

    card.body.innerHTML = `
      <div class="prop-row">
        <span class="prop-label">Lens (mm)</span>
        <div class="prop-slider-wrap">
          <input type="range" class="prop-slider" id="cam-lens" min="12" max="200" step="1" value="${focal.toFixed(0)}" />
          <span class="prop-slider-val" id="cam-lens-val">${focal.toFixed(0)} mm</span>
        </div>
      </div>
      <div class="prop-row">
        <span class="prop-label">FOV</span>
        <span class="prop-value" id="cam-fov-val">${cam.fov.toFixed(1)}°</span>
      </div>
      <div class="prop-row">
        <span class="prop-label">Clip Start</span>
        <input type="number" id="cam-clip-near" step="0.01" min="0.001" value="${cam.near}" style="flex:1; background: var(--b-bg-input); color: var(--b-text-primary); border: 1px solid var(--b-border-dark); padding: 2px 5px; font-size: 11px; border-radius: 3px;" />
      </div>
      <div class="prop-row">
        <span class="prop-label">Clip End</span>
        <input type="number" id="cam-clip-far" step="1" min="1" value="${cam.far}" style="flex:1; background: var(--b-bg-input); color: var(--b-text-primary); border: 1px solid var(--b-border-dark); padding: 2px 5px; font-size: 11px; border-radius: 3px;" />
      </div>
      <div class="prop-row">
        <span class="prop-label">Sensor</span>
        <span class="prop-value">24 mm (Vertical)</span>
      </div>
      <div class="prop-row">
        <span class="prop-label">Lock to View</span>
        <label class="prop-checkbox-wrap" style="font-size:11px; flex:1;">
          <input type="checkbox" class="prop-checkbox" id="cam-lock-view" ${cm?.lockToView ? 'checked' : ''} />
          Lock Camera to View
        </label>
      </div>
      <div style="display:flex; gap:6px; margin-top:8px; flex-wrap:wrap;">
        <button id="btn-cam-active" style="flex:1; min-width:90px; padding:4px 8px; font-size:11px; border-radius:3px; cursor:pointer; background:${isActive ? '#1d4ed8' : 'var(--b-bg-input)'}; color:${isActive ? '#fff' : 'var(--b-text-secondary)'}; border:1px solid ${isActive ? '#3b82f6' : 'var(--b-border-dark)'};" ${isActive ? 'disabled' : ''}>${isActive ? '✓ Active Camera' : 'Set Active'}</button>
        <button id="btn-cam-look" style="flex:1; min-width:90px; padding:4px 8px; font-size:11px; border-radius:3px; cursor:pointer; background:${looking ? '#3a2222' : 'var(--b-bg-input)'}; color:${looking ? '#f87171' : 'var(--b-text-secondary)'}; border:1px solid ${looking ? '#5a3333' : 'var(--b-border-dark)'};">${looking ? 'Exit Camera View' : 'Look Through (0)'}</button>
      </div>
      <div style="display:flex; gap:6px; margin-top:6px;">
        <button id="btn-cam-frame" style="flex:1; padding:4px 8px; font-size:11px; border-radius:3px; cursor:pointer; background:var(--b-bg-input); color:var(--b-text-secondary); border:1px solid var(--b-border-dark);">Frame Selected</button>
        <button id="btn-cam-align-view" style="flex:1; padding:4px 8px; font-size:11px; border-radius:3px; cursor:pointer; background:var(--b-bg-input); color:var(--b-text-secondary); border:1px solid var(--b-border-dark);" title="Snap camera to active 3D viewport view (Ctrl+Alt+0)">Align to View</button>
      </div>
    `;
    this.contentBody.appendChild(card.card);

    const refresh = () => this.render();

    card.body.querySelector('#cam-lock-view')?.addEventListener('change', (e) => {
      cm?.setLockToView?.(e.target.checked);
    });

    card.body.querySelector('#btn-cam-align-view')?.addEventListener('click', () => {
      cm?.alignActiveCameraToView?.(entry.group);
      this.updateTransformFields?.();
      refresh();
    });

    card.body.querySelector('#cam-lens')?.addEventListener('input', (e) => {
      const mm = parseFloat(e.target.value);
      cm?.applyLens(entry, mm);
      const fov = cam.fov;
      const lensVal = card.body.querySelector('#cam-lens-val');
      const fovVal = card.body.querySelector('#cam-fov-val');
      if (lensVal) lensVal.textContent = `${mm.toFixed(0)} mm`;
      if (fovVal) fovVal.textContent = `${fov.toFixed(1)}°`;
    });

    card.body.querySelector('#cam-clip-near')?.addEventListener('change', (e) => {
      const value = parseFloat(e.target.value);
      if (Number.isFinite(value) && value > 0 && value < cam.far) {
        cam.near = value;
        cam.updateProjectionMatrix();
      }
    });

    card.body.querySelector('#cam-clip-far')?.addEventListener('change', (e) => {
      const value = parseFloat(e.target.value);
      if (Number.isFinite(value) && value > cam.near) {
        cam.far = value;
        cam.updateProjectionMatrix();
      }
    });

    card.body.querySelector('#btn-cam-active')?.addEventListener('click', () => {
      cm?.setActiveCamera(entry.group);
      refresh();
    });

    card.body.querySelector('#btn-cam-look')?.addEventListener('click', () => {
      cm?.toggleViewCamera(entry.group);
      refresh();
    });

    card.body.querySelector('#btn-cam-frame')?.addEventListener('click', () => {
      cm?.frameSelection(entry);
      refresh();
    });
  }

  renderLightSection(light) {
    if (!light || !light.isLight) return;
    const engine = this.engine || (typeof window !== 'undefined' ? window.engine : null) || this.sceneManager?.engine || null;
    const typeLabel = light.isDirectionalLight ? 'Sun (Directional)'
      : light.isSpotLight ? 'Spot Light'
      : light.isPointLight ? 'Point Light'
      : light.isRectAreaLight ? 'Area (Rect) Light'
      : 'Ambient Light';
    const card = this.createCard(`Light (${typeLabel})`, true);
    const hexColor = light.color?.getHexString ? `#${light.color.getHexString()}` : '#ffffff';
    const canShadow = Boolean(light.isDirectionalLight || light.isSpotLight || light.isPointLight);
    const mapSize = light.shadow?.mapSize?.width || 1024;
    const bias = Number(light.shadow?.bias ?? -0.0005);
    const radius = Number(light.shadow?.radius ?? 1);
    const budget = enforceShadowBudget(this.sceneManager || engine?.scene, light);

    let extraRows = '';
    if (light.isPointLight || light.isSpotLight) {
      extraRows += `
        <div class="prop-row">
          <span class="prop-label">Range (m)</span>
          <input type="number" id="light-distance" min="0" step="0.5" value="${Number(light.distance || 0).toFixed(2)}" style="flex:1; background: var(--b-bg-input); color: var(--b-text-primary); border: 1px solid var(--b-border-dark); padding: 2px 6px; font-size: 11px; border-radius: 3px;" />
        </div>
        <div class="prop-row">
          <span class="prop-label">Decay</span>
          <input type="number" id="light-decay" min="0" max="4" step="0.1" value="${Number(light.decay ?? 2).toFixed(2)}" style="flex:1; background: var(--b-bg-input); color: var(--b-text-primary); border: 1px solid var(--b-border-dark); padding: 2px 6px; font-size: 11px; border-radius: 3px;" />
        </div>`;
    }
    if (light.isSpotLight) {
      const deg = THREE.MathUtils.radToDeg(light.angle || Math.PI / 6);
      extraRows += `
        <div class="prop-row">
          <span class="prop-label">Spot Cone</span>
          <div class="prop-slider-wrap">
            <input type="range" class="prop-slider" id="light-angle" min="5" max="85" step="1" value="${deg.toFixed(0)}" />
            <span class="prop-slider-val" id="light-angle-val">${deg.toFixed(0)}°</span>
          </div>
        </div>
        <div class="prop-row">
          <span class="prop-label">Penumbra</span>
          <div class="prop-slider-wrap">
            <input type="range" class="prop-slider" id="light-penumbra" min="0" max="1" step="0.02" value="${Number(light.penumbra ?? 0).toFixed(2)}" />
            <span class="prop-slider-val" id="light-penumbra-val">${Number(light.penumbra ?? 0).toFixed(2)}</span>
          </div>
        </div>`;
    }
    if (light.isRectAreaLight) {
      extraRows += `
        <div class="prop-row">
          <span class="prop-label">Size W × H</span>
          <div style="display:flex; gap:6px; flex:1;">
            <input type="number" id="light-area-w" min="0.1" step="0.1" value="${Number(light.width || 2).toFixed(2)}" style="width:50%; background: var(--b-bg-input); color: var(--b-text-primary); border: 1px solid var(--b-border-dark); padding: 2px 6px; font-size: 11px; border-radius: 3px;" />
            <input type="number" id="light-area-h" min="0.1" step="0.1" value="${Number(light.height || 2).toFixed(2)}" style="width:50%; background: var(--b-bg-input); color: var(--b-text-primary); border: 1px solid var(--b-border-dark); padding: 2px 6px; font-size: 11px; border-radius: 3px;" />
          </div>
        </div>`;
    }
    if (canShadow) {
      extraRows += `
        <div class="prop-row">
          <span class="prop-label">Shadows</span>
          <label class="prop-checkbox-wrap" style="font-size:11px; flex:1;">
            <input type="checkbox" class="prop-checkbox" id="light-cast-shadow" ${light.castShadow ? 'checked' : ''} />
            Cast Shadow (${budget.enabledCount}/${budget.limit})
          </label>
        </div>
        <div class="prop-row">
          <span class="prop-label">Shadow Map</span>
          <select id="light-shadow-res" style="flex:1; background: var(--b-bg-input); color: var(--b-text-primary); border: 1px solid var(--b-border-dark); padding: 2px 6px; font-size: 11px; border-radius: 3px;">
            <option value="512" ${mapSize === 512 ? 'selected' : ''}>512 × 512</option>
            <option value="1024" ${mapSize === 1024 ? 'selected' : ''}>1024 × 1024</option>
            <option value="2048" ${mapSize === 2048 ? 'selected' : ''}>2048 × 2048</option>
          </select>
        </div>
        <div class="prop-row">
          <span class="prop-label">Soft / Bias</span>
          <div style="display:flex; gap:6px; flex:1;">
            <input type="number" id="light-shadow-radius" min="0" max="16" step="0.2" value="${radius.toFixed(1)}" title="Shadow Soft Radius" style="width:50%; background: var(--b-bg-input); color: var(--b-text-primary); border: 1px solid var(--b-border-dark); padding: 2px 6px; font-size: 11px; border-radius: 3px;" />
            <input type="number" id="light-shadow-bias" step="0.0001" value="${bias.toFixed(4)}" title="Shadow Bias" style="width:50%; background: var(--b-bg-input); color: var(--b-text-primary); border: 1px solid var(--b-border-dark); padding: 2px 6px; font-size: 11px; border-radius: 3px;" />
          </div>
        </div>`;
    }
    if (light.isDirectionalLight || light.isSpotLight) {
      extraRows += `
        <button id="btn-light-aim-origin" style="width:100%; margin-top:6px; padding:4px 8px; font-size:11px; border-radius:3px; cursor:pointer; background:var(--b-bg-input); color:var(--b-text-secondary); border:1px solid var(--b-border-dark);">Aim Light at Origin (0,0,0)</button>`;
    }

    card.body.innerHTML = `
      <div class="prop-row">
        <span class="prop-label">Color</span>
        <input type="color" id="light-color" value="${hexColor}" style="width:42px; height:24px; border:1px solid var(--b-border-dark); background:transparent; padding:0; border-radius:3px; cursor:pointer;" />
        <span class="prop-value" id="light-color-hex" style="margin-left:6px; font-family:monospace; font-size:11px;">${hexColor.toUpperCase()}</span>
      </div>
      <div class="prop-row">
        <span class="prop-label">Intensity</span>
        <input type="number" id="light-intensity" min="0" max="500" step="0.1" value="${Number(light.intensity ?? 1).toFixed(2)}" style="flex:1; background: var(--b-bg-input); color: var(--b-text-primary); border: 1px solid var(--b-border-dark); padding: 2px 6px; font-size: 11px; border-radius: 3px;" />
      </div>
      ${extraRows}
    `;
    this.contentBody.appendChild(card.card);

    const notifyLightUpdate = (rebuildHelper = false) => {
      if (rebuildHelper) refreshLightHelper(light);
      engine?.markShadowDirty?.();
      engine?.requestRender?.();
      this.sceneManager?.emit?.('sceneUpdated', { source: 'inspector', object: light });
    };

    card.body.querySelector('#light-color')?.addEventListener('input', (e) => {
      light.color?.set?.(e.target.value);
      const hex = card.body.querySelector('#light-color-hex');
      if (hex) hex.textContent = e.target.value.toUpperCase();
      notifyLightUpdate(true);
    });

    card.body.querySelector('#light-intensity')?.addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      if (Number.isFinite(v) && v >= 0) {
        light.intensity = v;
        notifyLightUpdate(false);
      }
    });

    card.body.querySelector('#light-distance')?.addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      if (Number.isFinite(v) && v >= 0) {
        light.distance = v;
        notifyLightUpdate(false);
      }
    });

    card.body.querySelector('#light-decay')?.addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      if (Number.isFinite(v) && v >= 0) {
        light.decay = v;
        notifyLightUpdate(false);
      }
    });

    card.body.querySelector('#light-angle')?.addEventListener('input', (e) => {
      const deg = parseFloat(e.target.value);
      if (Number.isFinite(deg)) {
        light.angle = THREE.MathUtils.degToRad(Math.max(1, Math.min(89, deg)));
        const val = card.body.querySelector('#light-angle-val');
        if (val) val.textContent = `${deg.toFixed(0)}°`;
        notifyLightUpdate(true);
      }
    });

    card.body.querySelector('#light-penumbra')?.addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      if (Number.isFinite(v)) {
        light.penumbra = Math.max(0, Math.min(1, v));
        const val = card.body.querySelector('#light-penumbra-val');
        if (val) val.textContent = light.penumbra.toFixed(2);
        notifyLightUpdate(false);
      }
    });

    card.body.querySelector('#light-area-w')?.addEventListener('change', (e) => {
      const v = parseFloat(e.target.value);
      if (Number.isFinite(v) && v >= 0.05) {
        light.width = v;
        notifyLightUpdate(true);
      }
    });

    card.body.querySelector('#light-area-h')?.addEventListener('change', (e) => {
      const v = parseFloat(e.target.value);
      if (Number.isFinite(v) && v >= 0.05) {
        light.height = v;
        notifyLightUpdate(true);
      }
    });

    card.body.querySelector('#light-cast-shadow')?.addEventListener('change', (e) => {
      light.userData._shadowDesired = Boolean(e.target.checked);
      light.castShadow = Boolean(e.target.checked);
      enforceShadowBudget(this.sceneManager || engine?.scene, light);
      notifyLightUpdate(false);
      this.render();
    });

    card.body.querySelector('#light-shadow-res')?.addEventListener('change', (e) => {
      const res = parseInt(e.target.value, 10) || 1024;
      if (light.shadow) {
        light.shadow.mapSize.set(res, res);
        light.shadow.map?.dispose?.();
        light.shadow.map = null;
        light.shadow.needsUpdate = true;
      }
      notifyLightUpdate(false);
    });

    card.body.querySelector('#light-shadow-radius')?.addEventListener('change', (e) => {
      const v = parseFloat(e.target.value);
      if (light.shadow && Number.isFinite(v) && v >= 0) {
        light.shadow.radius = v;
        notifyLightUpdate(false);
      }
    });

    card.body.querySelector('#light-shadow-bias')?.addEventListener('change', (e) => {
      const v = parseFloat(e.target.value);
      if (light.shadow && Number.isFinite(v)) {
        light.shadow.bias = v;
        notifyLightUpdate(false);
      }
    });

    card.body.querySelector('#btn-light-aim-origin')?.addEventListener('click', () => {
      light.userData.useExplicitTarget = false;
      light.userData.rotationDriven = true;
      const worldPos = light.getWorldPosition(new THREE.Vector3());
      const aimDummy = new THREE.Object3D();
      aimDummy.position.copy(worldPos);
      aimDummy.lookAt(0, 0, 0);
      aimDummy.rotateY(Math.PI);
      if (light.parent) {
        light.parent.updateWorldMatrix(true, false);
        const invParentQ = light.parent.getWorldQuaternion(new THREE.Quaternion()).invert();
        light.quaternion.copy(invParentQ).multiply(aimDummy.quaternion);
      } else {
        light.quaternion.copy(aimDummy.quaternion);
      }
      light.updateMatrixWorld(true);
      this.updateTransformFields?.();
      syncLightDirection(light);
      refreshLightHelper(light);
      notifyLightUpdate(false);
    });
  }

  renderImageSection() {
    const obj = this.targetObject;
    const ud = obj?.userData;
    if (!obj || !ud?.isImageObject) return;

    const esc = (s) => String(s || '').replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));

    const mode = ud.imageMode || 'reference';
    const modeLabel = mode === 'background' ? 'Background' : (mode === 'plane' ? 'Mesh Plane' : 'Reference');
    const widthVal = Number(ud.baseWidth ?? 4).toFixed(2);
    const opacityVal = Number(ud.opacity ?? 0.85).toFixed(2);
    const sideVal = ud.displaySide || 'both';
    const depthVal = ud.depthOrder || 'default';
    const dimsText = `${ud.pixelWidth || '?'} × ${ud.pixelHeight || '?'} px`;

    const card = this.createCard('Image Properties', true);
    card.body.innerHTML = `
      <div style="display:flex; gap:8px; align-items:center; margin-bottom:10px; padding:6px; background:rgba(0,0,0,0.22); border:1px solid var(--b-border-dark); border-radius:4px;">
        ${ud.imageSrc ? `<img src="${esc(ud.imageSrc)}" alt="preview" style="width:42px; height:42px; object-fit:contain; background:#141414; border-radius:3px; border:1px solid #333;" />` : ''}
        <div style="min-width:0; flex:1;">
          <div style="font-size:11px; font-weight:600; color:var(--b-text-primary); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${esc(ud.fileName)}">${esc(ud.fileName || obj.name)}</div>
          <div style="font-size:10px; color:var(--b-text-secondary); margin-top:2px;">${modeLabel} · ${dimsText}</div>
        </div>
      </div>

      <div class="prop-row">
        <span class="prop-label">Size (m)</span>
        <input type="number" id="img-prop-size" min="0.05" step="0.1" value="${widthVal}" style="flex:1; background:var(--b-bg-input); color:var(--b-text-primary); border:1px solid var(--b-border-dark); padding:3px 6px; border-radius:3px; font-size:11px;" />
      </div>

      <div class="prop-row">
        <span class="prop-label">Opacity</span>
        <div class="prop-slider-wrap">
          <input type="range" class="prop-slider" id="img-prop-opacity" min="0.05" max="1" step="0.01" value="${opacityVal}" />
          <span class="prop-slider-val" id="img-prop-opacity-val">${opacityVal}</span>
        </div>
      </div>

      <div class="prop-row">
        <span class="prop-label">Flip</span>
        <div style="display:flex; gap:12px; flex:1;">
          <label class="prop-checkbox-wrap" style="font-size:11px;"><input type="checkbox" class="prop-checkbox" id="img-prop-flipx" ${ud.flipX ? 'checked' : ''} /> X</label>
          <label class="prop-checkbox-wrap" style="font-size:11px;"><input type="checkbox" class="prop-checkbox" id="img-prop-flipy" ${ud.flipY ? 'checked' : ''} /> Y</label>
        </div>
      </div>

      <div class="prop-row">
        <span class="prop-label">Side</span>
        <select id="img-prop-side" style="flex:1; background:var(--b-bg-input); color:var(--b-text-primary); border:1px solid var(--b-border-dark); padding:3px 6px; border-radius:3px; font-size:11px;">
          <option value="both" ${sideVal === 'both' ? 'selected' : ''}>Both</option>
          <option value="front" ${sideVal === 'front' ? 'selected' : ''}>Front</option>
          <option value="back" ${sideVal === 'back' ? 'selected' : ''}>Back</option>
        </select>
      </div>

      <div class="prop-row">
        <span class="prop-label">Depth</span>
        <select id="img-prop-depth" style="flex:1; background:var(--b-bg-input); color:var(--b-text-primary); border:1px solid var(--b-border-dark); padding:3px 6px; border-radius:3px; font-size:11px;">
          <option value="default" ${depthVal === 'default' ? 'selected' : ''}>Default</option>
          <option value="front" ${depthVal === 'front' ? 'selected' : ''}>In Front</option>
          <option value="back" ${depthVal === 'back' ? 'selected' : ''}>Back</option>
        </select>
      </div>

      <div class="prop-row" style="align-items:flex-start; margin-top:6px;">
        <span class="prop-label" style="padding-top:4px;">Align</span>
        <div style="display:grid; grid-template-columns:repeat(4, 1fr); gap:4px; flex:1;">
          <button type="button" class="blender-btn img-align-btn" data-align="front" style="padding:3px 4px; font-size:10px; background:var(--b-bg-input); color:var(--b-text-primary); border:1px solid var(--b-border-dark); border-radius:3px; cursor:pointer;">Front</button>
          <button type="button" class="blender-btn img-align-btn" data-align="right" style="padding:3px 4px; font-size:10px; background:var(--b-bg-input); color:var(--b-text-primary); border:1px solid var(--b-border-dark); border-radius:3px; cursor:pointer;">Right</button>
          <button type="button" class="blender-btn img-align-btn" data-align="top" style="padding:3px 4px; font-size:10px; background:var(--b-bg-input); color:var(--b-text-primary); border:1px solid var(--b-border-dark); border-radius:3px; cursor:pointer;">Top</button>
          <button type="button" class="blender-btn img-align-btn" data-align="view" style="padding:3px 4px; font-size:10px; background:var(--b-bg-input); color:var(--b-text-primary); border:1px solid var(--b-border-dark); border-radius:3px; cursor:pointer;">View</button>
        </div>
      </div>

      <div style="display:flex; flex-direction:column; gap:6px; margin-top:10px;">
        <button type="button" id="btn-img-replace" style="width:100%; padding:5px 8px; font-size:11px; border-radius:3px; cursor:pointer; background:var(--b-bg-input); color:var(--b-text-primary); border:1px solid var(--b-border-dark);">Replace Image…</button>
        ${mode !== 'plane' ? `<button type="button" id="btn-img-to-plane" style="width:100%; padding:5px 8px; font-size:11px; border-radius:3px; cursor:pointer; background:var(--b-accent-blue); color:#fff; border:none; font-weight:600;">Convert to Mesh Plane</button>` : ''}
      </div>
      <input type="file" id="img-replace-file-input" accept="image/*" style="display:none;" />
    `;
    this.contentBody.appendChild(card.card);

    const requestSceneUpdate = (updateFields = false) => {
      if (updateFields) this.updateTransformFields();
      this.sceneManager?.onTransformChanged?.(obj);
      this.sceneManager?.requestRender?.();
    };

    card.body.querySelector('#img-prop-size')?.addEventListener('change', (e) => {
      const nextSize = parseFloat(e.target.value);
      if (Number.isFinite(nextSize) && nextSize >= 0.05) {
        updateImageObjectProperties(obj, { baseWidth: nextSize });
        requestSceneUpdate(true);
      }
    });

    card.body.querySelector('#img-prop-opacity')?.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      updateImageObjectProperties(obj, { opacity: val });
      const valEl = card.body.querySelector('#img-prop-opacity-val');
      if (valEl) valEl.textContent = val.toFixed(2);
      requestSceneUpdate(false);
    });

    card.body.querySelector('#img-prop-flipx')?.addEventListener('change', (e) => {
      updateImageObjectProperties(obj, { flipX: e.target.checked });
      requestSceneUpdate(false);
    });

    card.body.querySelector('#img-prop-flipy')?.addEventListener('change', (e) => {
      updateImageObjectProperties(obj, { flipY: e.target.checked });
      requestSceneUpdate(false);
    });

    card.body.querySelector('#img-prop-side')?.addEventListener('change', (e) => {
      updateImageObjectProperties(obj, { displaySide: e.target.value });
      requestSceneUpdate(false);
    });

    card.body.querySelector('#img-prop-depth')?.addEventListener('change', (e) => {
      updateImageObjectProperties(obj, { depthOrder: e.target.value });
      requestSceneUpdate(false);
    });

    card.body.querySelectorAll('.img-align-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const align = btn.getAttribute('data-align');
        updateImageObjectProperties(obj, { align, camera: window.engine?.camera || null });
        requestSceneUpdate(true);
      });
    });

    const replaceInput = card.body.querySelector('#img-replace-file-input');
    card.body.querySelector('#btn-img-replace')?.addEventListener('click', () => replaceInput?.click());
    replaceInput?.addEventListener('change', async () => {
      const file = replaceInput.files?.[0];
      replaceInput.value = '';
      if (!file) return;
      try {
        await replaceImageObjectSource(obj, { file });
        this.render();
        requestSceneUpdate(true);
      } catch (err) {
        console.error('[Inspector] Replace image failed:', err);
      }
    });

    card.body.querySelector('#btn-img-to-plane')?.addEventListener('click', () => {
      convertImageToMeshPlane(obj, { sceneManager: this.sceneManager });
      this.render();
      requestSceneUpdate(false);
    });
  }

  _collectEditableMeshes(rootObj = this.targetObject) {
    if (!rootObj || rootObj.userData?.isScatterGroup) return [];
    if (rootObj.isMesh && !rootObj.userData?.isHelper && !rootObj.userData?.isSystemObject) {
      return [rootObj];
    }
    const meshes = [];
    rootObj.traverse?.((node) => {
      if (
        node?.isMesh &&
        !node.isInstancedMesh &&
        !node.userData?.isHelper &&
        !node.userData?.isSystemObject &&
        node.geometry?.attributes?.position
      ) {
        meshes.push(node);
      }
    });
    return meshes;
  }

  _backupOriginalMaterialsIfNeeded(meshes) {
    for (const m of meshes) {
      if (!m?.material) continue;
      m.userData = m.userData || {};
      if (m.userData.__importedMaterial) continue;
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      if (mats.some((mt) => mt && !mt.userData?.isDefaultClay)) {
        m.userData.__importedMaterial = Array.isArray(m.material)
          ? m.material.map((mt) => mt?.clone?.() || mt)
          : (m.material.clone?.() || m.material);
      }
    }
  }

  _restoreImportedMaterials(rootObj = this.targetObject) {
    const meshes = this._collectEditableMeshes(rootObj);
    let restored = 0;
    for (const m of meshes) {
      const orig = m.userData?.__importedMaterial;
      if (!orig) continue;
      const cloned = Array.isArray(orig)
        ? orig.map((mt) => mt?.clone?.() || mt)
        : (orig.clone?.() || orig);
      m.material = cloned;
      if (m.userData?.__originalMaterial) {
        m.userData.__originalMaterial = cloned;
      }
      const list = Array.isArray(cloned) ? cloned : [cloned];
      list.forEach((mt) => { if (mt) mt.needsUpdate = true; });
      restored++;
    }
    if (restored > 0 && typeof window !== 'undefined' && window.matcapStudio?.isMatCapActive) {
      window.matcapStudio.toggleMatCapMode(false);
    }
    this.sceneManager?.requestRender?.();
    this.render();
    return restored;
  }

  renderMaterialSection() {
    const editableMeshes = this._collectEditableMeshes(this.targetObject);
    if (editableMeshes.length === 0) return;
    this._backupOriginalMaterialsIfNeeded(editableMeshes);

    const targetMesh = this.targetObject.isMesh
      ? this.targetObject
      : (editableMeshes.find((m) => m === this.targetObject.userData?._lastClickedMesh) || editableMeshes[0]);

    const matArray = Array.isArray(targetMesh.material) ? targetMesh.material : null;
    const matSlotIdx = matArray
      ? Math.min(matArray.length - 1, Math.max(0, targetMesh.userData?._activeMatSlotIndex || 0))
      : 0;
    let mat = matArray
      ? matArray[matSlotIdx]
      : (targetMesh.material || (Array.isArray(targetMesh.materials) ? targetMesh.materials[0] : null));

    const hasAnyImportedBackup = editableMeshes.some((m) => Boolean(m.userData?.__importedMaterial));
    const partSelectorHtml = (editableMeshes.length > 1 || (matArray && matArray.length > 1)) ? `
      <div style="margin-bottom: 8px; padding: 6px 8px; background: rgba(59, 130, 246, 0.08); border: 1px solid rgba(96, 165, 250, 0.25); border-radius: 4px;">
        ${editableMeshes.length > 1 ? `
        <div class="prop-row" style="margin-bottom: ${matArray && matArray.length > 1 ? '6px' : '0'};">
          <span class="prop-label" style="font-size: 10.5px; color: #93c5fd;">Part (${editableMeshes.length})</span>
          <select id="mat-group-part-select" style="flex: 1; background: var(--b-bg-input); color: var(--b-text-primary); border: 1px solid var(--b-border-dark); padding: 3px 5px; border-radius: 3px; font-size: 11px;">
            ${editableMeshes.map((m, idx) => `<option value="${escapeHtml(m.uuid)}" ${m === targetMesh ? 'selected' : ''}>${idx + 1}. ${escapeHtml(m.name || 'Part')}</option>`).join('')}
          </select>
        </div>` : ''}
        ${matArray && matArray.length > 1 ? `
        <div class="prop-row" style="margin-bottom: 0;">
          <span class="prop-label" style="font-size: 10.5px; color: #93c5fd;">Slot (${matArray.length})</span>
          <select id="mat-slot-index-select" style="flex: 1; background: var(--b-bg-input); color: var(--b-text-primary); border: 1px solid var(--b-border-dark); padding: 3px 5px; border-radius: 3px; font-size: 11px;">
            ${matArray.map((mt, idx) => `<option value="${idx}" ${idx === matSlotIdx ? 'selected' : ''}>Slot ${idx + 1}: ${escapeHtml(mt?.name || 'Material')}</option>`).join('')}
          </select>
        </div>` : ''}
      </div>
    ` : '';

    const bindPartAndSlotSelectors = () => {
      card.body.querySelector('#mat-group-part-select')?.addEventListener('change', (e) => {
        const picked = editableMeshes.find((m) => m.uuid === e.target.value);
        if (picked && this.targetObject) {
          this.targetObject.userData = this.targetObject.userData || {};
          this.targetObject.userData._lastClickedMesh = picked;
          this.render();
        }
      });
      card.body.querySelector('#mat-slot-index-select')?.addEventListener('change', (e) => {
        targetMesh.userData = targetMesh.userData || {};
        targetMesh.userData._activeMatSlotIndex = parseInt(e.target.value, 10) || 0;
        this.render();
      });
    };

    const card = this.createCard('Material', true);
    const isUnassignedClay = !mat || !!mat.userData?.isDefaultClay;

    if (isUnassignedClay) {
      const isFlat = mat ? !!mat.flatShading : true;
      const isWire = mat ? !!mat.wireframe : false;
      card.body.innerHTML = `
        ${partSelectorHtml}
        <div style="background: rgba(0,0,0,0.28); border: 1px solid var(--b-border-dark); border-radius: 5px; padding: 8px 10px; margin-bottom: 10px;">
          <div style="display: flex; align-items: center; gap: 7px; font-size: 11.5px; color: var(--b-text-primary); font-weight: 600; margin-bottom: 3px;">
            <span style="display:inline-block; width: 12px; height: 12px; border-radius: 50%; background: linear-gradient(135deg, #e5e7eb, #9ca3af); border: 1px solid #555;"></span>
            <span>Default Clay (Unassigned)</span>
          </div>
          <div style="font-size: 10.5px; color: var(--b-text-muted); line-height: 1.4;">
            Like Blender: newly created 3D primitives start with neutral clay shading so topology and form remain easy to read.
          </div>
        </div>

        <button class="menu-btn" id="btn-create-mat" style="width: 100%; justify-content: center; background: var(--b-accent-blue); color: white; padding: 7px 12px; font-weight: 600; border-radius: 4px; margin-bottom: 8px; cursor: pointer;">
          + New Material (Create PBR Material)
        </button>
        ${hasAnyImportedBackup ? `
        <button class="menu-btn" id="btn-restore-imported-mat-clay" style="width: 100%; justify-content: center; background: #00b894; color: #081512; padding: 6px 12px; font-weight: 600; border-radius: 4px; margin-bottom: 8px; cursor: pointer;">
          🔄 Khôi phục chất liệu gốc (Restore Original Material)
        </button>
        ` : ''}

        <div class="prop-row" style="margin-bottom: 8px;">
          <span class="prop-label">Surface Shading</span>
          <div style="flex: 1; display: flex; gap: 6px;">
            <button type="button" id="btn-clay-flat" class="menu-btn" style="flex: 1; justify-content: center; padding: 4px 6px; font-size: 11px; background: ${isFlat ? 'var(--b-accent-blue)' : 'var(--b-bg-input)'}; color: #fff; border: 1px solid var(--b-border-light); border-radius: 4px;">Shade Flat</button>
            <button type="button" id="btn-clay-smooth" class="menu-btn" style="flex: 1; justify-content: center; padding: 4px 6px; font-size: 11px; background: ${!isFlat ? 'var(--b-accent-blue)' : 'var(--b-bg-input)'}; color: #fff; border: 1px solid var(--b-border-light); border-radius: 4px;">Shade Smooth</button>
          </div>
        </div>

        <div class="prop-row">
          <span class="prop-label">Display</span>
          <label class="prop-checkbox-wrap">
            <input type="checkbox" class="prop-checkbox" id="clay-wireframe" ${isWire ? 'checked' : ''} />
            <span style="font-size: 11px; color: var(--b-text-secondary);">Wireframe</span>
          </label>
        </div>
      `;
      bindPartAndSlotSelectors();
      const btnNew = card.body.querySelector('#btn-create-mat');
      if (btnNew) {
        btnNew.addEventListener('click', () => {
          const fresh = new THREE.MeshStandardMaterial({
            name: `${targetMesh.name || 'Object'}_Material`,
            color: 0xd2d5da,
            roughness: 0.45,
            metalness: 0.1,
            flatShading: false,
          });
          fresh.userData = { isDefaultClay: false };
          if (matArray) {
            targetMesh.material[matSlotIdx] = fresh;
          } else {
            targetMesh.material = fresh;
          }
          if (this.sceneManager?.requestRender) this.sceneManager.requestRender();
          this.render();
        });
      }
      card.body.querySelector('#btn-clay-flat')?.addEventListener('click', () => {
        if (mat) {
          mat.flatShading = true;
          mat.needsUpdate = true;
          targetMesh.geometry?.computeVertexNormals();
          this.sceneManager?.requestRender?.();
          this.render();
        }
      });
      card.body.querySelector('#btn-clay-smooth')?.addEventListener('click', () => {
        if (mat) {
          mat.flatShading = false;
          mat.needsUpdate = true;
          targetMesh.geometry?.computeVertexNormals();
          this.sceneManager?.requestRender?.();
          this.render();
        }
      });
      card.body.querySelector('#clay-wireframe')?.addEventListener('change', (e) => {
        if (mat) {
          mat.wireframe = e.target.checked;
          this.sceneManager?.requestRender?.();
        }
      });
      card.body.querySelector('#btn-restore-imported-mat-clay')?.addEventListener('click', () => {
        this._restoreImportedMaterials(this.targetObject);
      });
      this.contentBody.appendChild(card.card);
      return;
    }

    const hexColor = mat.color ? `#${mat.color.getHexString()}` : '#cccccc';
    const roughness = mat.roughness !== undefined ? mat.roughness : 0.5;
    const metalness = mat.metalness !== undefined ? mat.metalness : 0.0;
    const opacity = mat.opacity !== undefined ? mat.opacity : 1.0;
    const isWireframe = !!mat.wireframe;
    const emissionHex = mat.emissive ? `#${mat.emissive.getHexString()}` : '#000000';

    card.body.innerHTML = `
      ${partSelectorHtml}
      <!-- Material Slot Header with Restore Original & Reset to Clay buttons -->
      <div style="display: flex; align-items: center; justify-content: space-between; gap: 6px; padding: 5px 8px; margin-bottom: 10px; background: rgba(0,0,0,0.25); border: 1px solid var(--b-border-dark); border-radius: 4px; flex-wrap: wrap;">
        <span style="font-size: 11px; font-weight: 600; color: var(--b-text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">🎨 ${escapeHtml(mat.name || 'Principled BSDF')}</span>
        <div style="display: flex; gap: 4px; align-items: center; flex-shrink: 0;">
          ${hasAnyImportedBackup ? `
          <button type="button" id="btn-restore-imported-mat" style="padding: 2px 7px; font-size: 10px; background: #14382f; color: #6ee7b7; border: 1px solid #059669; border-radius: 3px; cursor: pointer;" title="Khôi phục toàn bộ chất liệu / texture gốc của mô hình">🔄 Khôi phục gốc</button>
          ` : ''}
          <button type="button" id="btn-mat-reset-clay" style="padding: 2px 7px; font-size: 10px; background: #3a2222; color: #fca5a5; border: 1px solid #5a3333; border-radius: 3px; cursor: pointer;" title="Remove material to reset object to default Blender gray clay">✕ Clay</button>
        </div>
      </div>

      <!-- Base Color -->
      <div class="prop-row">
        <span class="prop-label">Base Color</span>
        <div class="prop-color-wrap">
          <input type="color" class="prop-color-input" id="mat-color-input" value="${hexColor}" />
          <span class="prop-color-hex" id="mat-color-hex">${hexColor.toUpperCase()}</span>
        </div>
      </div>

      <!-- Roughness -->
      <div class="prop-row">
        <span class="prop-label">Roughness</span>
        <div class="prop-slider-wrap">
          <input type="range" class="prop-slider" id="mat-roughness" min="0" max="1" step="0.01" value="${roughness}" />
          <span class="prop-slider-val" id="mat-roughness-val">${roughness.toFixed(2)}</span>
        </div>
      </div>

      <!-- Metalness -->
      <div class="prop-row">
        <span class="prop-label">Metallic</span>
        <div class="prop-slider-wrap">
          <input type="range" class="prop-slider" id="mat-metalness" min="0" max="1" step="0.01" value="${metalness}" />
          <span class="prop-slider-val" id="mat-metalness-val">${metalness.toFixed(2)}</span>
        </div>
      </div>

      <!-- Opacity -->
      <div class="prop-row">
        <span class="prop-label">Opacity</span>
        <div class="prop-slider-wrap">
          <input type="range" class="prop-slider" id="mat-opacity" min="0" max="1" step="0.01" value="${opacity}" />
          <span class="prop-slider-val" id="mat-opacity-val">${opacity.toFixed(2)}</span>
        </div>
      </div>

      <!-- Emission Color -->
      <div class="prop-row">
        <span class="prop-label">Emission</span>
        <div class="prop-color-wrap">
          <input type="color" class="prop-color-input" id="mat-emission-input" value="${emissionHex}" />
          <span class="prop-color-hex" id="mat-emission-hex">${emissionHex.toUpperCase()}</span>
        </div>
      </div>

      <!-- Wireframe -->
      <div class="prop-row">
        <span class="prop-label">Wireframe</span>
        <label class="prop-checkbox-wrap">
          <input type="checkbox" class="prop-checkbox" id="mat-wireframe" ${isWireframe ? 'checked' : ''} />
          <span style="font-size: 11px; color: var(--b-text-secondary);">Render as wireframe</span>
        </label>
      </div>

      <!-- Flat Shading -->
      <div class="prop-row">
        <span class="prop-label">Flat Shading</span>
        <label class="prop-checkbox-wrap">
          <input type="checkbox" class="prop-checkbox" id="mat-flat-shading" ${mat.flatShading ? 'checked' : ''} />
          <span style="font-size: 11px; color: var(--b-text-secondary);">Per-face normals (low poly)</span>
        </label>
      </div>

      <!-- Double Sided -->
      <div class="prop-row">
        <span class="prop-label">Double Sided</span>
        <label class="prop-checkbox-wrap">
          <input type="checkbox" class="prop-checkbox" id="mat-double-sided" ${mat.side === THREE.DoubleSide ? 'checked' : ''} />
          <span style="font-size: 11px; color: var(--b-text-secondary);">Render back faces</span>
        </label>
      </div>

      <!-- Emissive Intensity -->
      <div class="prop-row">
        <span class="prop-label">Glow</span>
        <div class="prop-slider-wrap">
          <input type="range" class="prop-slider" id="mat-emissive-intensity" min="0" max="5" step="0.05" value="${mat.emissiveIntensity !== undefined ? mat.emissiveIntensity : 1}" />
          <span class="prop-slider-val" id="mat-emissive-intensity-val">${(mat.emissiveIntensity !== undefined ? mat.emissiveIntensity : 1).toFixed(2)}</span>
        </div>
      </div>

      <!-- Environment Reflection Intensity -->
      <div class="prop-row">
        <span class="prop-label">Env Reflection</span>
        <div class="prop-slider-wrap">
          <input type="range" class="prop-slider" id="mat-env-intensity" min="0" max="3" step="0.05" value="${mat.envMapIntensity !== undefined ? mat.envMapIntensity : 1.0}" />
          <span class="prop-slider-val" id="mat-env-intensity-val">${(mat.envMapIntensity !== undefined ? mat.envMapIntensity : 1.0).toFixed(2)}</span>
        </div>
      </div>

      <!-- Advanced Principled BSDF Physical Channels -->
      <div style="margin-top: 10px; padding: 6px; background: rgba(0,0,0,0.22); border-radius: 4px; border: 1px solid var(--b-border-dark);">
        <div style="font-size: 11px; font-weight: 600; color: #60a5fa; margin-bottom: 6px; display: flex; align-items: center; justify-content: space-between;">
          <span>✨ Principled BSDF (Physical Shading)</span>
        </div>

        <!-- 1. Transmission & IOR (Glass / Liquids) -->
        <div class="prop-row">
          <span class="prop-label">Transmission</span>
          <div class="prop-slider-wrap">
            <input type="range" class="prop-slider" id="mat-transmission" min="0" max="1" step="0.01" value="${mat.transmission || 0}" />
            <span class="prop-slider-val" id="mat-transmission-val">${(mat.transmission || 0).toFixed(2)}</span>
          </div>
        </div>
        <div class="prop-row">
          <span class="prop-label">IOR</span>
          <div class="prop-slider-wrap">
            <input type="range" class="prop-slider" id="mat-ior" min="1.0" max="2.5" step="0.01" value="${mat.ior !== undefined ? mat.ior : 1.5}" />
            <span class="prop-slider-val" id="mat-ior-val">${(mat.ior !== undefined ? mat.ior : 1.5).toFixed(2)}</span>
          </div>
        </div>
        <div class="prop-row">
          <span class="prop-label">Thickness</span>
          <div class="prop-slider-wrap">
            <input type="range" class="prop-slider" id="mat-thickness" min="0" max="5" step="0.1" value="${mat.thickness || 0}" />
            <span class="prop-slider-val" id="mat-thickness-val">${(mat.thickness || 0).toFixed(1)}</span>
          </div>
        </div>

        <!-- 2. Clearcoat (Car Paint Lacquer) -->
        <div class="prop-row" style="margin-top: 6px;">
          <span class="prop-label">Clearcoat</span>
          <div class="prop-slider-wrap">
            <input type="range" class="prop-slider" id="mat-clearcoat" min="0" max="1" step="0.01" value="${mat.clearcoat || 0}" />
            <span class="prop-slider-val" id="mat-clearcoat-val">${(mat.clearcoat || 0).toFixed(2)}</span>
          </div>
        </div>
        <div class="prop-row">
          <span class="prop-label">Clearcoat Rough</span>
          <div class="prop-slider-wrap">
            <input type="range" class="prop-slider" id="mat-clearcoat-rough" min="0" max="1" step="0.01" value="${mat.clearcoatRoughness || 0}" />
            <span class="prop-slider-val" id="mat-clearcoat-rough-val">${(mat.clearcoatRoughness || 0).toFixed(2)}</span>
          </div>
        </div>

        <!-- 3. Sheen (Fabric / Velvet) -->
        <div class="prop-row" style="margin-top: 6px;">
          <span class="prop-label">Sheen</span>
          <div class="prop-slider-wrap">
            <input type="range" class="prop-slider" id="mat-sheen" min="0" max="1" step="0.01" value="${mat.sheen || 0}" />
            <span class="prop-slider-val" id="mat-sheen-val">${(mat.sheen || 0).toFixed(2)}</span>
          </div>
        </div>
        <div class="prop-row">
          <span class="prop-label">Sheen Rough</span>
          <div class="prop-slider-wrap">
            <input type="range" class="prop-slider" id="mat-sheen-rough" min="0" max="1" step="0.01" value="${mat.sheenRoughness || 0}" />
            <span class="prop-slider-val" id="mat-sheen-rough-val">${(mat.sheenRoughness || 0).toFixed(2)}</span>
          </div>
        </div>
        <div class="prop-row">
          <span class="prop-label">Sheen Color</span>
          <div class="prop-color-wrap">
            <input type="color" class="prop-color-input" id="mat-sheen-color-input" value="${mat.sheenColor ? '#' + mat.sheenColor.getHexString() : '#ffffff'}" />
            <span class="prop-color-hex" id="mat-sheen-color-hex">${mat.sheenColor ? '#' + mat.sheenColor.getHexString().toUpperCase() : '#FFFFFF'}</span>
          </div>
        </div>
      </div>

      <!-- Real Image Textures Section (PBR Maps Upload) -->
      <div style="margin-top: 14px; padding-top: 10px; border-top: 1px solid var(--b-border-dark);">
        <div style="font-size: 11px; font-weight: 600; color: #4ade80; margin-bottom: 8px; display: flex; align-items: center; justify-content: space-between;">
          <span style="display: flex; align-items: center; gap: 5px;">
            <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M6.002 5.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0z"/><path d="M2.002 1a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V3a2 2 0 0 0-2-2h-12zm12 1a1 1 0 0 1 1 1v6.5l-3.777-1.947a.5.5 0 0 0-.577.093l-3.71 3.71-2.66-1.772a.5.5 0 0 0-.63.062L1.002 12V3a1 1 0 0 1 1-1h12z"/></svg>
            Image Textures (PBR Maps)
          </span>
        </div>

        <!-- 1. Base Color (Albedo/Diffuse Map) -->
        <div style="margin-bottom: 8px; padding: 6px; background: rgba(0,0,0,0.22); border-radius: 4px; border: 1px solid var(--b-border-dark);">
          <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px;">
            <span style="font-size: 11px; font-weight: 500; color: var(--b-text-primary);">Base Color (Diffuse)</span>
            <div style="display: flex; gap: 4px; align-items: center;">
              <button id="btn-mat-project-face" type="button" style="padding: 1px 6px; font-size: 10px; background: #1e3a8a; color: #93c5fd; border: 1px solid #2563eb; border-radius: 3px; cursor: pointer;" title="Project active view straight onto 3D model UVs (Project from View)">👤 Project View</button>
              <button id="btn-mat-remove-diffuse" style="padding: 1px 6px; font-size: 10px; background: #3a2222; color: #f87171; border: 1px solid #5a3333; border-radius: 3px; cursor: pointer; display: ${mat.map && (!mat.userData || !mat.userData.proceduralMap) ? 'inline-block' : 'none'};">Remove</button>
            </div>
          </div>
          <div style="display: flex; align-items: center; gap: 8px;">
            <div id="mat-diffuse-thumb" style="width: 34px; height: 34px; border: 1px solid var(--b-border-dark); border-radius: 3px; background: #111; overflow: hidden; display: flex; align-items: center; justify-content: center; flex-shrink: 0;">
              ${mat.map?.image && mat.map.image.src ? `<img src="${mat.map.image.src}" style="width: 100%; height: 100%; object-fit: cover;" />` : `<span style="font-size: 8px; color: #666;">Empty</span>`}
            </div>
            <input type="file" id="mat-file-diffuse" accept="image/*" style="font-size: 10px; color: var(--b-text-secondary); flex: 1; min-width: 0;" />
          </div>
        </div>

        <!-- 2. Alpha Map -->
        <div style="margin-bottom: 8px; padding: 6px; background: rgba(0,0,0,0.22); border-radius: 4px; border: 1px solid var(--b-border-dark);">
          <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px;">
            <span style="font-size: 11px; font-weight: 500; color: var(--b-text-primary);">Alpha Mask (Cutout)</span>
            <button id="btn-mat-remove-alpha" style="padding: 1px 6px; font-size: 10px; background: #3a2222; color: #f87171; border: 1px solid #5a3333; border-radius: 3px; cursor: pointer; display: ${mat.alphaMap ? 'inline-block' : 'none'};">Remove</button>
          </div>
          <div style="display: flex; align-items: center; gap: 8px;">
            <div id="mat-alpha-thumb" style="width: 34px; height: 34px; border: 1px solid var(--b-border-dark); border-radius: 3px; background: #111; overflow: hidden; display: flex; align-items: center; justify-content: center; flex-shrink: 0;">
              ${mat.alphaMap?.image && mat.alphaMap.image.src ? `<img src="${mat.alphaMap.image.src}" style="width: 100%; height: 100%; object-fit: cover;" />` : `<span style="font-size: 8px; color: #666;">Empty</span>`}
            </div>
            <input type="file" id="mat-file-alpha" accept="image/*" style="font-size: 10px; color: var(--b-text-secondary); flex: 1; min-width: 0;" />
          </div>
          <div class="prop-row" style="margin-top: 4px; margin-bottom: 0;">
            <span class="prop-label" style="font-size: 10px;">Alpha Cutoff</span>
            <div class="prop-slider-wrap">
              <input type="range" class="prop-slider" id="mat-alpha-test" min="0" max="0.99" step="0.01" value="${mat.alphaTest || 0.1}" />
              <span class="prop-slider-val" id="mat-alpha-test-val">${(mat.alphaTest || 0.1).toFixed(2)}</span>
            </div>
          </div>
        </div>

        <!-- 3. Normal Map -->
        <div style="margin-bottom: 8px; padding: 6px; background: rgba(0,0,0,0.22); border-radius: 4px; border: 1px solid var(--b-border-dark);">
          <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px;">
            <span style="font-size: 11px; font-weight: 500; color: var(--b-text-primary);">Normal Map</span>
            <button id="btn-mat-remove-normal" style="padding: 1px 6px; font-size: 10px; background: #3a2222; color: #f87171; border: 1px solid #5a3333; border-radius: 3px; cursor: pointer; display: ${mat.normalMap && (!mat.userData || !mat.userData.proceduralMap) ? 'inline-block' : 'none'};">Remove</button>
          </div>
          <div style="display: flex; align-items: center; gap: 8px;">
            <div id="mat-normal-thumb" style="width: 34px; height: 34px; border: 1px solid var(--b-border-dark); border-radius: 3px; background: #111; overflow: hidden; display: flex; align-items: center; justify-content: center; flex-shrink: 0;">
              ${mat.normalMap?.image && mat.normalMap.image.src && (!mat.userData || !mat.userData.proceduralMap) ? `<img src="${mat.normalMap.image.src}" style="width: 100%; height: 100%; object-fit: cover;" />` : `<span style="font-size: 8px; color: #666;">Empty</span>`}
            </div>
            <input type="file" id="mat-file-normal" accept="image/*" style="font-size: 10px; color: var(--b-text-secondary); flex: 1; min-width: 0;" />
          </div>
          <div class="prop-row" style="margin-top: 4px; margin-bottom: 0;">
            <span class="prop-label" style="font-size: 10px;">Strength</span>
            <div class="prop-slider-wrap">
              <input type="range" class="prop-slider" id="mat-user-normal-scale" min="0" max="3" step="0.05" value="${(mat.normalScale?.x !== undefined ? mat.normalScale.x : 1.0)}" />
              <span class="prop-slider-val" id="mat-user-normal-val">${(mat.normalScale?.x !== undefined ? mat.normalScale.x : 1.0).toFixed(2)}</span>
            </div>
          </div>
        </div>

        <!-- 4. Roughness Map -->
        <div style="margin-bottom: 8px; padding: 6px; background: rgba(0,0,0,0.22); border-radius: 4px; border: 1px solid var(--b-border-dark);">
          <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px;">
            <span style="font-size: 11px; font-weight: 500; color: var(--b-text-primary);">Roughness Map</span>
            <button id="btn-mat-remove-rough" style="padding: 1px 6px; font-size: 10px; background: #3a2222; color: #f87171; border: 1px solid #5a3333; border-radius: 3px; cursor: pointer; display: ${mat.roughnessMap && (!mat.userData || !mat.userData.proceduralMap) ? 'inline-block' : 'none'};">Remove</button>
          </div>
          <div style="display: flex; align-items: center; gap: 8px;">
            <div id="mat-rough-thumb" style="width: 34px; height: 34px; border: 1px solid var(--b-border-dark); border-radius: 3px; background: #111; overflow: hidden; display: flex; align-items: center; justify-content: center; flex-shrink: 0;">
              ${mat.roughnessMap?.image && mat.roughnessMap.image.src && (!mat.userData || !mat.userData.proceduralMap) ? `<img src="${mat.roughnessMap.image.src}" style="width: 100%; height: 100%; object-fit: cover;" />` : `<span style="font-size: 8px; color: #666;">Empty</span>`}
            </div>
            <input type="file" id="mat-file-rough" accept="image/*" style="font-size: 10px; color: var(--b-text-secondary); flex: 1; min-width: 0;" />
          </div>
        </div>

        <!-- Texture Repeat (Tiling) -->
        <div class="prop-row" style="margin-top: 6px;">
          <span class="prop-label">Tiling (Repeat U/V)</span>
          <div style="flex: 1; display: flex; gap: 6px;">
            <input type="number" id="mat-tile-u" min="0.1" max="50" step="0.5" value="${mat.map?.repeat?.x || 1}" style="width: 50%; background: var(--b-bg-input); color: var(--b-text-primary); border: 1px solid var(--b-border-dark); padding: 2px 4px; font-size: 11px; border-radius: 3px;" title="Repeat U" />
            <input type="number" id="mat-tile-v" min="0.1" max="50" step="0.5" value="${mat.map?.repeat?.y || 1}" style="width: 50%; background: var(--b-bg-input); color: var(--b-text-primary); border: 1px solid var(--b-border-dark); padding: 2px 4px; font-size: 11px; border-radius: 3px;" title="Repeat V" />
          </div>
        </div>

        <!-- Texture Offset U/V -->
        <div class="prop-row" style="margin-top: 6px;">
          <span class="prop-label">Offset U/V</span>
          <div style="flex: 1; display: flex; gap: 6px;">
            <input type="number" id="mat-offset-u" step="0.05" value="${mat.map?.offset?.x || 0}" style="width: 50%; background: var(--b-bg-input); color: var(--b-text-primary); border: 1px solid var(--b-border-dark); padding: 2px 4px; font-size: 11px; border-radius: 3px;" title="Offset U" />
            <input type="number" id="mat-offset-v" step="0.05" value="${mat.map?.offset?.y || 0}" style="width: 50%; background: var(--b-bg-input); color: var(--b-text-primary); border: 1px solid var(--b-border-dark); padding: 2px 4px; font-size: 11px; border-radius: 3px;" title="Offset V" />
          </div>
        </div>

        <!-- Texture Rotation -->
        <div class="prop-row" style="margin-top: 6px;">
          <span class="prop-label">Rotation</span>
          <div class="prop-slider-wrap">
            <input type="range" class="prop-slider" id="mat-tex-rot" min="-180" max="180" step="1" value="${mat.map ? Math.round(((mat.map.rotation || 0) * 180) / Math.PI) : 0}" />
            <span class="prop-slider-val" id="mat-tex-rot-val">${mat.map ? Math.round(((mat.map.rotation || 0) * 180) / Math.PI) : 0}°</span>
          </div>
        </div>
      </div>

      <!-- Procedural Textures & Normal Map Section -->
      <div style="margin-top: 14px; padding-top: 10px; border-top: 1px solid var(--b-border-dark);">
        <div style="font-size: 11px; font-weight: 600; color: #5bc0de; margin-bottom: 8px; display: flex; align-items: center; justify-content: space-between;">
          <span style="display: flex; align-items: center; gap: 5px;">
            <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M1 2.5A1.5 1.5 0 0 1 2.5 1h11A1.5 1.5 0 0 1 15 2.5v11a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 1 13.5v-11zM2.5 2a.5.5 0 0 0-.5.5v11a.5.5 0 0 0 .5.5h11a.5.5 0 0 0 .5-.5v-11a.5.5 0 0 0-.5-.5h-11zM8 4a.5.5 0 0 1 .5.5v3h3a.5.5 0 0 1 0 1h-3v3a.5.5 0 0 1-1 0v-3h-3a.5.5 0 0 1 0-1h3v-3A.5.5 0 0 1 8 4z"/></svg>
            Procedural Textures & Normal Map
          </span>
          <button id="btn-mat-reroll" style="padding: 2px 7px; font-size: 10px; background: var(--b-bg-input); color: var(--b-text-secondary); border: 1px solid var(--b-border-dark); border-radius: 3px; cursor: pointer;" title="Randomize texture seed">🔄 Re-roll</button>
        </div>

        <!-- Pattern Dropdown -->
        <div class="prop-row">
          <span class="prop-label">Pattern</span>
          <select id="mat-proc-preset" style="flex: 1; background: var(--b-bg-input); color: var(--b-text-primary); border: 1px solid var(--b-border-dark); padding: 4px; border-radius: 3px; font-size: 11px;">
            <option value="none">None (Smooth PBR)</option>
            <optgroup label="Surface & Mechanical">
              <option value="brushed">⚙️ Brushed Metal (Titanium / Scratches)</option>
              <option value="noise">🌫️ Perlin Noise (Grunge / Micro-Roughness)</option>
              <option value="voronoi">🧬 Voronoi Cellular (Leather / Scales)</option>
              <option value="carbon">🏁 Carbon Fiber (2x2 Twill Weave)</option>
              <option value="marble">🏛️ White Marble Veins</option>
              <option value="wood">🪵 Wood Grain Rings</option>
            </optgroup>
            <optgroup label="Architectural PBR (Worker 1K · True Roughness)">
              <option value="ashlar_stone">🧱 Ashlar Cut Stone</option>
              <option value="weathered_concrete">🏛️ Weathered Cast Concrete</option>
              <option value="stucco_plaster">🎨 Stucco Lime Plaster</option>
              <option value="roof_slates">🏠 Beveled Roof Slates</option>
              <option value="clay_roof_tiles">🏺 Clay Barrel Roof Tiles</option>
              <option value="wood_grain">🪵 Architectural Hardwood Planks</option>
              <option value="checkered_marble">♟️ Checkered Veined Marble</option>
              <option value="stained_mosaic">🌈 Leaded Stained Glass Mosaic</option>
              <option value="mullioned_glass">🪟 Mullioned Window Glass</option>
            </optgroup>
          </select>
        </div>
        <div style="font-size: 10px; color: var(--b-text-muted); margin: 3px 0 2px; display: flex; gap: 6px;">
          <span style="padding: 1px 5px; border-radius: 3px; background: rgba(74,144,226,0.14); color: #7db4f5;">Albedo: sRGB</span>
          <span style="padding: 1px 5px; border-radius: 3px; background: rgba(80,200,120,0.14); color: #6bd690;">Normal/Rough: Linear PNG</span>
        </div>

        <div id="mat-proc-options-wrap" style="display: none; margin-top: 8px;">
          <!-- Map Slots Checkboxes -->
          <div class="prop-row">
            <span class="prop-label">Apply Slots</span>
            <div style="flex: 1; display: flex; gap: 8px; font-size: 11px; color: var(--b-text-secondary);">
              <label style="display: flex; align-items: center; gap: 4px; cursor: pointer;" title="Apply as 3D Tangent Normal Map">
                <input type="checkbox" id="mat-slot-normal" checked> Normal
              </label>
              <label style="display: flex; align-items: center; gap: 4px; cursor: pointer;" title="Apply as Base Albedo Color Texture">
                <input type="checkbox" id="mat-slot-diffuse"> Diffuse
              </label>
              <label style="display: flex; align-items: center; gap: 4px; cursor: pointer;" title="Apply as Roughness Variation Map">
                <input type="checkbox" id="mat-slot-roughness"> Rough
              </label>
            </div>
          </div>

          <!-- Normal / Bump Scale Slider -->
          <div class="prop-row" id="row-bump-scale">
            <span class="prop-label">Normal Scale</span>
            <div class="prop-slider-wrap">
              <input type="range" class="prop-slider" id="mat-bump-intensity" min="0.1" max="4.0" step="0.1" value="1.0" />
              <span class="prop-slider-val" id="mat-bump-val">1.00</span>
            </div>
          </div>

          <!-- UV Repeat (Tiling) Slider -->
          <div class="prop-row">
            <span class="prop-label">UV Repeat</span>
            <div class="prop-slider-wrap">
              <input type="range" class="prop-slider" id="mat-uv-repeat" min="1" max="24" step="1" value="4" />
              <span class="prop-slider-val" id="mat-uv-repeat-val">4x</span>
            </div>
          </div>

          <!-- Swatch Thumbnail & Description -->
          <div class="prop-row" style="margin-top: 6px; align-items: center;">
            <span class="prop-label">Preview</span>
            <div style="flex: 1; display: flex; align-items: center; gap: 8px;">
              <canvas id="mat-proc-swatch" width="44" height="44" style="width: 44px; height: 44px; border: 1px solid var(--b-border-dark); border-radius: 4px; background: #111; flex-shrink: 0;"></canvas>
              <div id="mat-proc-desc" style="font-size: 10px; color: var(--b-text-muted); line-height: 1.3;">Tangent Normal Map from Sobel filter</div>
            </div>
          </div>
        </div>
      </div>
    `;

    // Hook inputs
    bindPartAndSlotSelectors();

    card.body.querySelector('#btn-restore-imported-mat')?.addEventListener('click', () => {
      this._restoreImportedMaterials(this.targetObject);
    });

    card.body.querySelector('#btn-mat-reset-clay')?.addEventListener('click', () => {
      this._backupOriginalMaterialsIfNeeded([targetMesh]);
      const clayMat = new THREE.MeshStandardMaterial({
        name: 'Default Clay (Unassigned)',
        color: 0xd2d5da,
        roughness: 0.65,
        metalness: 0.0,
        flatShading: true,
      });
      clayMat.userData = { isDefaultClay: true };
      if (matArray) {
        targetMesh.material[matSlotIdx] = clayMat;
      } else {
        targetMesh.material = clayMat;
      }
      targetMesh.geometry?.computeVertexNormals?.();
      this.sceneManager?.requestRender?.();
      this.render();
    });

    const colorInput = card.body.querySelector('#mat-color-input');
    const colorHex = card.body.querySelector('#mat-color-hex');
    colorInput.addEventListener('input', (e) => {
      const hex = e.target.value;
      colorHex.textContent = hex.toUpperCase();
      if (mat.color) mat.color.set(hex);
      mat.userData.isDefaultClay = false;
      if (this.sceneManager?.requestRender) this.sceneManager.requestRender();
    });

    const roughSlider = card.body.querySelector('#mat-roughness');
    const roughVal = card.body.querySelector('#mat-roughness-val');
    roughSlider.addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      roughVal.textContent = v.toFixed(2);
      mat.roughness = v;
      if (this.sceneManager?.requestRender) this.sceneManager.requestRender();
    });

    const metalSlider = card.body.querySelector('#mat-metalness');
    const metalVal = card.body.querySelector('#mat-metalness-val');
    metalSlider.addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      metalVal.textContent = v.toFixed(2);
      mat.metalness = v;
      if (this.sceneManager?.requestRender) this.sceneManager.requestRender();
    });

    const opacSlider = card.body.querySelector('#mat-opacity');
    const opacVal = card.body.querySelector('#mat-opacity-val');
    opacSlider.addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      opacVal.textContent = v.toFixed(2);
      mat.opacity = v;
      mat.transparent = v < 1.0;
      if (this.sceneManager?.requestRender) this.sceneManager.requestRender();
    });

    const emInput = card.body.querySelector('#mat-emission-input');
    const emHex = card.body.querySelector('#mat-emission-hex');
    emInput.addEventListener('input', (e) => {
      const hex = e.target.value;
      emHex.textContent = hex.toUpperCase();
      if (mat.emissive) mat.emissive.set(hex);
      if (this.sceneManager?.requestRender) this.sceneManager.requestRender();
    });

    const wireCheckbox = card.body.querySelector('#mat-wireframe');
    wireCheckbox.addEventListener('change', (e) => {
      mat.wireframe = e.target.checked;
      if (this.sceneManager?.requestRender) this.sceneManager.requestRender();
    });

    const flatCheckbox = card.body.querySelector('#mat-flat-shading');
    flatCheckbox?.addEventListener('change', (e) => {
      mat.flatShading = e.target.checked;
      mat.needsUpdate = true;
      if (this.sceneManager?.requestRender) this.sceneManager.requestRender();
    });

    const doubleSidedCheckbox = card.body.querySelector('#mat-double-sided');
    doubleSidedCheckbox?.addEventListener('change', (e) => {
      mat.side = e.target.checked ? THREE.DoubleSide : THREE.FrontSide;
      mat.needsUpdate = true;
      if (this.sceneManager?.requestRender) this.sceneManager.requestRender();
    });

    const glowSlider = card.body.querySelector('#mat-emissive-intensity');
    const glowVal = card.body.querySelector('#mat-emissive-intensity-val');
    glowSlider?.addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      glowVal.textContent = v.toFixed(2);
      mat.emissiveIntensity = v;
      if (this.sceneManager?.requestRender) this.sceneManager.requestRender();
    });

    const envSlider = card.body.querySelector('#mat-env-intensity');
    const envVal = card.body.querySelector('#mat-env-intensity-val');
    envSlider?.addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      if (envVal) envVal.textContent = v.toFixed(2);
      mat.envMapIntensity = v;
      if (this.sceneManager?.requestRender) this.sceneManager.requestRender();
    });

    const ensurePhysical = (props = {}) => {
      const mStudio = window.materialStudio || (window.app ? window.app.materialStudio : null);
      if (!mat.isMeshPhysicalMaterial) {
        if (mStudio?.upgradeToPhysicalMaterial) {
          const physical = mStudio.upgradeToPhysicalMaterial(mat, props);
          if (Array.isArray(targetMesh.material)) {
            targetMesh.material[matSlotIdx] = physical;
          } else {
            targetMesh.material = physical;
          }
          mat = physical;
        } else {
          const physical = new THREE.MeshPhysicalMaterial({
            color: mat.color ? mat.color.clone() : new THREE.Color(0xcccccc),
            roughness: mat.roughness !== undefined ? mat.roughness : 0.5,
            metalness: mat.metalness !== undefined ? mat.metalness : 0.0,
            map: mat.map,
            normalMap: mat.normalMap,
            ...props,
          });
          if (Array.isArray(targetMesh.material)) {
            targetMesh.material[matSlotIdx] = physical;
          } else {
            targetMesh.material = physical;
          }
          mat = physical;
        }
      } else {
        Object.assign(mat, props);
      }
      mat.needsUpdate = true;
      if (this.sceneManager?.requestRender) this.sceneManager.requestRender();
    };

    const transSlider = card.body.querySelector('#mat-transmission');
    const transVal = card.body.querySelector('#mat-transmission-val');
    transSlider?.addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      if (transVal) transVal.textContent = v.toFixed(2);
      ensurePhysical({ transmission: v });
    });

    const iorSlider = card.body.querySelector('#mat-ior');
    const iorVal = card.body.querySelector('#mat-ior-val');
    iorSlider?.addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      if (iorVal) iorVal.textContent = v.toFixed(2);
      ensurePhysical({ ior: v });
    });

    const thickSlider = card.body.querySelector('#mat-thickness');
    const thickVal = card.body.querySelector('#mat-thickness-val');
    thickSlider?.addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      if (thickVal) thickVal.textContent = v.toFixed(1);
      ensurePhysical({ thickness: v });
    });

    const clearSlider = card.body.querySelector('#mat-clearcoat');
    const clearVal = card.body.querySelector('#mat-clearcoat-val');
    clearSlider?.addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      if (clearVal) clearVal.textContent = v.toFixed(2);
      ensurePhysical({ clearcoat: v });
    });

    const clearRoughSlider = card.body.querySelector('#mat-clearcoat-rough');
    const clearRoughVal = card.body.querySelector('#mat-clearcoat-rough-val');
    clearRoughSlider?.addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      if (clearRoughVal) clearRoughVal.textContent = v.toFixed(2);
      ensurePhysical({ clearcoatRoughness: v });
    });

    const sheenSlider = card.body.querySelector('#mat-sheen');
    const sheenVal = card.body.querySelector('#mat-sheen-val');
    sheenSlider?.addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      if (sheenVal) sheenVal.textContent = v.toFixed(2);
      ensurePhysical({ sheen: v });
    });

    const sheenRoughSlider = card.body.querySelector('#mat-sheen-rough');
    const sheenRoughVal = card.body.querySelector('#mat-sheen-rough-val');
    sheenRoughSlider?.addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      if (sheenRoughVal) sheenRoughVal.textContent = v.toFixed(2);
      ensurePhysical({ sheenRoughness: v });
    });

    const sheenColorInput = card.body.querySelector('#mat-sheen-color-input');
    const sheenColorHex = card.body.querySelector('#mat-sheen-color-hex');
    sheenColorInput?.addEventListener('input', (e) => {
      const hex = e.target.value;
      if (sheenColorHex) sheenColorHex.textContent = hex.toUpperCase();
      ensurePhysical({ sheenColor: new THREE.Color(hex) });
    });

    // =========================================================================
    // Image Textures (User Uploaded PBR Maps) Logic
    // =========================================================================
    const loadAndApplyTexture = (file, slot) => {
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (evt) => {
        const dataUrl = evt.target.result;
        const loader = new THREE.TextureLoader();
        loader.load(dataUrl, (texture) => {
          texture.wrapS = THREE.RepeatWrapping;
          texture.wrapT = THREE.RepeatWrapping;
          const tileU = parseFloat(card.body.querySelector('#mat-tile-u')?.value || 1);
          const tileV = parseFloat(card.body.querySelector('#mat-tile-v')?.value || 1);
          texture.repeat.set(tileU, tileV);

          // Clear procedural preset indicator if user loads custom texture
          if (slot === 'diffuse' || slot === 'normal') {
            if (mat.userData) mat.userData.proceduralMap = null;
            const procPreset = card.body.querySelector('#mat-proc-preset');
            if (procPreset) procPreset.value = 'none';
          }

          if (slot === 'diffuse') {
            texture.colorSpace = THREE.SRGBColorSpace || THREE.sRGBEncoding || '';
            mat.map = texture;
            if (mat.color && mat.color.r === 0 && mat.color.g === 0 && mat.color.b === 0) {
              mat.color.set('#ffffff');
              const colInp = card.body.querySelector('#mat-color-input');
              if (colInp) colInp.value = '#ffffff';
            }
          } else if (slot === 'alpha') {
            mat.alphaMap = texture;
            mat.transparent = true;
            mat.depthWrite = true;
            if (mat.alphaTest === undefined || mat.alphaTest === 0) {
              mat.alphaTest = 0.1;
            }
          } else if (slot === 'normal') {
            mat.normalMap = texture;
            const normScale = parseFloat(card.body.querySelector('#mat-user-normal-scale')?.value || 1.0);
            if (!mat.normalScale) {
              mat.normalScale = new THREE.Vector2(normScale, normScale);
            } else {
              mat.normalScale.set(normScale, normScale);
            }
          } else if (slot === 'roughness') {
            mat.roughnessMap = texture;
          }

          mat.needsUpdate = true;
          if (this.sceneManager?.requestRender) this.sceneManager.requestRender();

          this.render();

          window.dispatchEvent(new CustomEvent('blender:textureUpdated', {
            detail: { mesh: targetMesh, slot, texture }
          }));
        });
      };
      reader.readAsDataURL(file);
    };

    // Project from view quick action
    card.body.querySelector('#btn-mat-project-face')?.addEventListener('click', () => {
      if (window.uvEditor) {
        window.uvEditor.alignFrontAndProject(targetMesh);
      }
    });

    // File input handlers
    card.body.querySelector('#mat-file-diffuse')?.addEventListener('change', (e) => {
      if (e.target.files && e.target.files[0]) loadAndApplyTexture(e.target.files[0], 'diffuse');
    });
    card.body.querySelector('#mat-file-alpha')?.addEventListener('change', (e) => {
      if (e.target.files && e.target.files[0]) loadAndApplyTexture(e.target.files[0], 'alpha');
    });
    card.body.querySelector('#mat-file-normal')?.addEventListener('change', (e) => {
      if (e.target.files && e.target.files[0]) loadAndApplyTexture(e.target.files[0], 'normal');
    });
    card.body.querySelector('#mat-file-rough')?.addEventListener('change', (e) => {
      if (e.target.files && e.target.files[0]) loadAndApplyTexture(e.target.files[0], 'roughness');
    });

    // Remove buttons (never GPU-dispose a texture owned by TextureLeaseRegistry or backups)
    const isTexBackedUp = (tex) => {
      if (!tex) return false;
      if (textureLeaseRegistry.isTextureOwned(tex)) return true;
      const orig = targetMesh.userData?.__importedMaterial;
      const list = Array.isArray(orig) ? orig : (orig ? [orig] : []);
      for (const m of list) {
        if (m && (m.map === tex || m.alphaMap === tex || m.normalMap === tex || m.roughnessMap === tex)) {
          return true;
        }
      }
      const slotMap = this._preProceduralBackups?.get(targetMesh);
      if (slotMap) {
        for (const prev of slotMap.values()) {
          if (prev && (prev.map === tex || prev.normalMap === tex || prev.roughnessMap === tex)) {
            return true;
          }
        }
      }
      return false;
    };
    const detachMapSlot = (prop) => {
      const tex = mat[prop];
      if (!tex) return;
      if (!isTexBackedUp(tex)) {
        tex.dispose?.();
      }
      mat[prop] = null;
      mat.needsUpdate = true;
      this.sceneManager?.requestRender?.();
      this.render();
      window.dispatchEvent(new CustomEvent('blender:textureUpdated', { detail: { mesh: targetMesh } }));
    };
    card.body.querySelector('#btn-mat-remove-diffuse')?.addEventListener('click', () => detachMapSlot('map'));
    card.body.querySelector('#btn-mat-remove-alpha')?.addEventListener('click', () => detachMapSlot('alphaMap'));
    card.body.querySelector('#btn-mat-remove-normal')?.addEventListener('click', () => detachMapSlot('normalMap'));
    card.body.querySelector('#btn-mat-remove-rough')?.addEventListener('click', () => detachMapSlot('roughnessMap'));

    // Sliders
    const sliderAlphaCutoff = card.body.querySelector('#mat-alpha-test');
    sliderAlphaCutoff?.addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      const valEl = card.body.querySelector('#mat-alpha-test-val');
      if (valEl) valEl.textContent = v.toFixed(2);
      mat.alphaTest = v;
      mat.needsUpdate = true;
      if (this.sceneManager?.requestRender) this.sceneManager.requestRender();
    });

    const sliderUserNorm = card.body.querySelector('#mat-user-normal-scale');
    sliderUserNorm?.addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      const valEl = card.body.querySelector('#mat-user-normal-val');
      if (valEl) valEl.textContent = v.toFixed(2);
      if (!mat.normalScale) {
        mat.normalScale = new THREE.Vector2(v, v);
      } else {
        mat.normalScale.set(v, v);
      }
      if (this.sceneManager?.requestRender) this.sceneManager.requestRender();
    });

    const updateTileRepeat = () => {
      const u = parseFloat(card.body.querySelector('#mat-tile-u')?.value || 1);
      const v = parseFloat(card.body.querySelector('#mat-tile-v')?.value || 1);
      ['map', 'alphaMap', 'normalMap', 'roughnessMap'].forEach(s => {
        if (mat[s] && mat[s].repeat) {
          mat[s].repeat.set(u, v);
          mat[s].needsUpdate = true;
        }
      });
      if (this.sceneManager?.requestRender) this.sceneManager.requestRender();
    };
    card.body.querySelector('#mat-tile-u')?.addEventListener('input', updateTileRepeat);
    card.body.querySelector('#mat-tile-v')?.addEventListener('input', updateTileRepeat);

    const applyTextureTransform = () => {
      const ou = parseFloat(card.body.querySelector('#mat-offset-u')?.value || 0);
      const ov = parseFloat(card.body.querySelector('#mat-offset-v')?.value || 0);
      const rotDeg = parseFloat(card.body.querySelector('#mat-tex-rot')?.value || 0);
      const rotRad = (rotDeg * Math.PI) / 180;
      ['map', 'alphaMap', 'normalMap', 'roughnessMap'].forEach((slot) => {
        const tex = mat[slot];
        if (!tex) return;
        if (tex.offset) tex.offset.set(ou, ov);
        tex.rotation = rotRad;
        tex.needsUpdate = true;
      });
      const valEl = card.body.querySelector('#mat-tex-rot-val');
      if (valEl) valEl.textContent = `${Math.round(rotDeg)}°`;
      if (this.sceneManager?.requestRender) this.sceneManager.requestRender();
    };
    card.body.querySelector('#mat-offset-u')?.addEventListener('input', applyTextureTransform);
    card.body.querySelector('#mat-offset-v')?.addEventListener('input', applyTextureTransform);
    card.body.querySelector('#mat-tex-rot')?.addEventListener('input', applyTextureTransform);

    // =========================================================================
    // Procedural Textures & Normal Map Logic (ONLY active when explicitly set)
    // =========================================================================
    let currentProcType = 'none';
    let currentRepeat = 4;
    let currentBump = (mat.normalScale && mat.normalScale.x) ? mat.normalScale.x : 1.0;
    let slotNormal = true;
    let slotDiffuse = false;
    let slotRough = false;

    if (mat.userData && mat.userData.proceduralMap && mat.userData.proceduralMap.type) {
      currentProcType = mat.userData.proceduralMap.type;
      if (mat.userData.proceduralMap.repeat) currentRepeat = mat.userData.proceduralMap.repeat;
      if (mat.userData.proceduralMap.bumpIntensity) currentBump = mat.userData.proceduralMap.bumpIntensity;
      if (mat.userData.proceduralMap.applyNormal !== undefined) slotNormal = mat.userData.proceduralMap.applyNormal;
      if (mat.userData.proceduralMap.applyDiffuse !== undefined) slotDiffuse = mat.userData.proceduralMap.applyDiffuse;
      if (mat.userData.proceduralMap.applyRoughness !== undefined) slotRough = mat.userData.proceduralMap.applyRoughness;
    }

    const selectProc = card.body.querySelector('#mat-proc-preset');
    const optionsWrap = card.body.querySelector('#mat-proc-options-wrap');
    const chkNormal = card.body.querySelector('#mat-slot-normal');
    const chkDiffuse = card.body.querySelector('#mat-slot-diffuse');
    const chkRough = card.body.querySelector('#mat-slot-roughness');
    const sliderBump = card.body.querySelector('#mat-bump-intensity');
    const valBump = card.body.querySelector('#mat-bump-val');
    const sliderRepeat = card.body.querySelector('#mat-uv-repeat');
    const valRepeat = card.body.querySelector('#mat-uv-repeat-val');
    const btnReroll = card.body.querySelector('#btn-mat-reroll');
    const swatchCanvas = card.body.querySelector('#mat-proc-swatch');
    const descText = card.body.querySelector('#mat-proc-desc');

    if (selectProc) selectProc.value = currentProcType;
    if (optionsWrap) optionsWrap.style.display = currentProcType !== 'none' ? 'block' : 'none';
    if (chkNormal) chkNormal.checked = slotNormal;
    if (chkDiffuse) chkDiffuse.checked = slotDiffuse;
    if (chkRough) chkRough.checked = slotRough;
    if (sliderBump) sliderBump.value = currentBump;
    if (valBump) valBump.textContent = Number(currentBump).toFixed(2);
    if (sliderRepeat) sliderRepeat.value = currentRepeat;
    if (valRepeat) valRepeat.textContent = `${currentRepeat}x`;

    let seedCounter = Math.floor(Math.random() * 10000);
    if (!this._preProceduralBackups) this._preProceduralBackups = new WeakMap();
    const getBackupKey = (meshObj, slot) => `${meshObj?.uuid || 'mesh'}:${slot}`;
    const getSlotBackupMap = (meshObj) => {
      let m = this._preProceduralBackups.get(meshObj);
      if (!m) { m = new Map(); this._preProceduralBackups.set(meshObj, m); }
      return m;
    };

    const updateProceduralState = () => {
      const type = selectProc ? selectProc.value : 'none';
      const mStudio = window.materialStudio || (window.app ? window.app.materialStudio : null);
      const pbrTarget = targetMesh || this.targetObject;
      const backupKey = getBackupKey(pbrTarget, matSlotIdx);

      // Always cancel any in-flight async Architectural PBR request before applying 'none' or a legacy sync pattern
      this._procPbrAbort?.abort?.();
      this._procPbrAbort = null;
      this._procPbrGen = (this._procPbrGen || 0) + 1;

      if (type === 'none') {
        if (optionsWrap) optionsWrap.style.display = 'none';
        const slotMap = pbrTarget ? this._preProceduralBackups.get(pbrTarget) : null;
        const prev = slotMap?.get(backupKey) || null;
        if (prev && pbrTarget) {
          const oldSlotMat = Array.isArray(pbrTarget.material) ? pbrTarget.material[matSlotIdx] : pbrTarget.material;
          if (prev.originalMaterial) {
            if (Array.isArray(pbrTarget.material)) {
              const nextArr = pbrTarget.material.slice();
              nextArr[matSlotIdx] = prev.originalMaterial;
              pbrTarget.material = nextArr;
            } else {
              pbrTarget.material = prev.originalMaterial;
            }
            mat = prev.originalMaterial;
            if (oldSlotMat && oldSlotMat !== prev.originalMaterial) {
              const root = this.sceneManager?.rootContainer || this.sceneManager?.scene;
              if (!root || !dataBlockRegistry.isMaterialShared(oldSlotMat, root, null)) {
                textureLeaseRegistry.release(oldSlotMat);
              }
            }
          }
          mat.map = prev.map || null;
          mat.normalMap = prev.normalMap || null;
          mat.roughnessMap = prev.roughnessMap || null;
          slotMap.delete(backupKey);
        } else {
          mat.normalMap = null;
          mat.map = null;
          mat.roughnessMap = null;
        }
        mat.needsUpdate = true;
        if (mat.userData) mat.userData.proceduralMap = null;
        if (this.sceneManager?.requestRender) this.sceneManager.requestRender();
        return;
      }

      if (optionsWrap) optionsWrap.style.display = 'block';
      if (!mStudio) return;

      mat.userData = mat.userData || {};
      const slotMap = pbrTarget ? getSlotBackupMap(pbrTarget) : null;
      if (slotMap && !slotMap.has(backupKey)) {
        // Store real Texture & Material references in private WeakMap keyed by `${uuid}:${slot}` (never in userData JSON!)
        slotMap.set(backupKey, {
          originalMaterial: mat,
          map: mat.map || null,
          normalMap: mat.normalMap || null,
          roughnessMap: mat.roughnessMap || null,
        });
      }
      const prevMaps = slotMap?.get(backupKey) || null;

      const repeat = parseFloat(sliderRepeat ? sliderRepeat.value : 4);
      const bump = parseFloat(sliderBump ? sliderBump.value : 1.0);
      const applyNorm = chkNormal ? chkNormal.checked : true;
      const applyDiff = chkDiffuse ? chkDiffuse.checked : false;
      const applyRgh = chkRough ? chkRough.checked : false;

      const ARCH_WORKER_PATTERNS = new Set([
        'ashlar_stone', 'weathered_concrete', 'stucco_plaster', 'roof_slates',
        'clay_roof_tiles', 'wood_grain', 'checkered_marble', 'stained_mosaic', 'mullioned_glass'
      ]);
      if (ARCH_WORKER_PATTERNS.has(type) && window.studio?.applyProceduralPBR) {
        if (!pbrTarget) return;
        const activeSlot = matSlotIdx;
        const currentMat = Array.isArray(pbrTarget.material)
          ? (pbrTarget.material[activeSlot] || pbrTarget.material[0])
          : pbrTarget.material;
        const wasArch = ARCH_WORKER_PATTERNS.has(currentMat?.userData?.proceduralMap?.type);
        // Only enable Diffuse & Rough defaults on first transition into an Architectural PBR pattern; respect user's subsequent uncheck!
        if (!wasArch) {
          if (chkDiffuse) chkDiffuse.checked = true;
          if (chkRough) chkRough.checked = true;
        }
        const useDiff = chkDiffuse ? chkDiffuse.checked : true;
        const useRough = chkRough ? chkRough.checked : true;
        this._procPbrAbort?.abort?.();
        const ac = new AbortController();
        this._procPbrAbort = ac;
        const reqGen = (this._procPbrGen = (this._procPbrGen || 0) + 1);
        if (descText) descText.textContent = `Generating ${type} (Worker PBR)…`;
        window.studio.applyProceduralPBR(pbrTarget, {
          pattern: type,
          resolution: 1024,
          repeat,
          slotIndex: Array.isArray(pbrTarget.material) ? activeSlot : undefined,
          normalScale: applyNorm ? bump : 0,
          useDiffuseMap: useDiff,
          useRoughnessMap: useRough,
          seed: seedCounter,
          signal: ac.signal,
        }).then(() => {
          if (reqGen !== this._procPbrGen || ac.signal.aborted || (this.targetObject && this.targetObject !== pbrTarget)) return;
          const updatedMat = Array.isArray(pbrTarget.material)
            ? (pbrTarget.material[activeSlot] || pbrTarget.material[0])
            : pbrTarget.material;
          if (updatedMat) {
            updatedMat.userData = updatedMat.userData || {};
            updatedMat.userData.proceduralMap = {
              type,
              repeat,
              bumpIntensity: bump,
              applyNormal: applyNorm,
              applyDiffuse: useDiff,
              applyRoughness: useRough,
            };
            mat = updatedMat;
          }
          if (descText) descText.textContent = `Applied ${type} (sRGB Albedo · Linear Normal/Roughness)`;
          this.sceneManager?.requestRender?.();
        }).catch((err) => {
          if (reqGen !== this._procPbrGen || err?.name === 'AbortError') return;
          if (descText) descText.textContent = `Procedural error: ${err?.message || err}`;
        });
        return;
      }

      const proc = mStudio.generateProceduralTexture(type, {
        repeat,
        bumpIntensity: bump,
        seed: seedCounter
      });

      if (!proc) return;

      const THREE_REF = mStudio.THREE || window.THREE;
      const wrapMode = THREE_REF ? THREE_REF.RepeatWrapping : 1000;

      // 1. Normal Map
      if (applyNorm && proc.normalMap) {
        proc.normalMap.wrapS = wrapMode;
        proc.normalMap.wrapT = wrapMode;
        proc.normalMap.repeat.set(repeat, repeat);
        proc.normalMap.needsUpdate = true;
        mat.normalMap = proc.normalMap;
        if (!mat.normalScale) {
          mat.normalScale = (THREE_REF && THREE_REF.Vector2) ? new THREE_REF.Vector2(bump, bump) : { x: bump, y: bump, set: function(x, y) { this.x = x; this.y = y; } };
        } else {
          mat.normalScale.set(bump, bump);
        }
      } else {
        mat.normalMap = prevMaps?.normalMap || null;
      }

      // 2. Diffuse / Albedo Map
      if (applyDiff && proc.texture) {
        proc.texture.wrapS = wrapMode;
        proc.texture.wrapT = wrapMode;
        proc.texture.repeat.set(repeat, repeat);
        proc.texture.needsUpdate = true;
        mat.map = proc.texture;
      } else {
        mat.map = prevMaps?.map || null;
      }

      // 3. Roughness Map
      if (applyRgh) {
        const rTex = proc.heightCanvas && THREE_REF ? new THREE_REF.CanvasTexture(proc.heightCanvas) : proc.texture;
        if (rTex) {
          rTex.wrapS = wrapMode;
          rTex.wrapT = wrapMode;
          rTex.repeat.set(repeat, repeat);
          rTex.needsUpdate = true;
          mat.roughnessMap = rTex;
        }
      } else {
        mat.roughnessMap = prevMaps?.roughnessMap || null;
      }

      mat.userData.proceduralMap = {
        type,
        repeat,
        bumpIntensity: bump,
        applyNormal: applyNorm,
        applyDiffuse: applyDiff,
        applyRoughness: applyRgh
      };

      mat.needsUpdate = true;

      // Swatch preview rendering
      if (swatchCanvas) {
        const sCtx = swatchCanvas.getContext('2d');
        const src = (applyNorm && proc.normalCanvas) ? proc.normalCanvas : (proc.canvas || proc.heightCanvas);
        if (src) {
          sCtx.clearRect(0, 0, 44, 44);
          sCtx.drawImage(src, 0, 0, 44, 44);
        }
      }

      if (descText) {
        const descs = {
          brushed: 'Anisotropic scratch lines along axis (Sobel Normal)',
          noise: 'Multi-octave Perlin fBm fractal heightmap',
          voronoi: 'Worley distance cellular pattern for scales/leather',
          carbon: '2x2 twill weave composite with 3D thread relief',
          marble: 'Sinusoidal vein turbulence marble stone',
          wood: 'Harmonic ring curvature wood grain'
        };
        descText.textContent = descs[type] || 'Procedural texture & normal map';
      }

      if (this.sceneManager?.requestRender) {
        this.sceneManager.requestRender();
      }
    };

    selectProc?.addEventListener('change', () => {
      seedCounter = Math.floor(Math.random() * 10000);
      updateProceduralState();
    });

    chkNormal?.addEventListener('change', updateProceduralState);
    chkDiffuse?.addEventListener('change', updateProceduralState);
    chkRough?.addEventListener('change', updateProceduralState);

    sliderBump?.addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      if (valBump) valBump.textContent = v.toFixed(2);
      if (mat.normalScale) {
        mat.normalScale.set(v, v);
      }
      if (this.sceneManager?.requestRender) this.sceneManager.requestRender();
    });

    sliderRepeat?.addEventListener('input', (e) => {
      const v = parseInt(e.target.value, 10);
      if (valRepeat) valRepeat.textContent = `${v}x`;
      updateProceduralState();
    });

    btnReroll?.addEventListener('click', () => {
      seedCounter = Math.floor(Math.random() * 10000);
      updateProceduralState();
    });

    this.contentBody.appendChild(card.card);
  }

  // =========================================================================
  // Wave 2: Texture Baking (Rust BVH), Paint Layers & Shader Nodes
  // =========================================================================
  renderSurfacePaintAndBakeSection() {
    const mesh = this.targetObject;
    if (!mesh?.isMesh) return;
    const card = this.createCard('Paint, Bake & Shader Nodes', false);
    const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    const stack = mat ? getPaintLayerStack(mat) : null;
    const hasSg = mat ? Boolean(getShaderGraphForMaterial(mat)) : false;

    const otherMeshes = [];
    this.sceneManager?.scene?.traverseVisible?.((n) => {
      if (n.isMesh && n !== mesh && !n.userData?.isSystemHelper && !n.userData?.isHelper && !n.userData?.isLightHelper) {
        otherMeshes.push(n);
      }
    });
    const highOpts = otherMeshes.map((m) => `<option value="${escapeHtml(m.uuid)}">${escapeHtml(m.name || m.uuid.slice(0, 6))}</option>`).join('');

    card.body.innerHTML = `
      <div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:8px;">
        <button type="button" id="btn-insp-enter-tp" class="prop-mini-btn" style="flex:1;padding:4px 6px;font-size:10px;background:#263344;color:#93c5fd;border:1px solid #3b5578;border-radius:3px;cursor:pointer;">🖌️ Texture Paint</button>
        <button type="button" id="btn-insp-enter-vp" class="prop-mini-btn" style="flex:1;padding:4px 6px;font-size:10px;background:#322644;color:#d8b4fe;border:1px solid #593b78;border-radius:3px;cursor:pointer;">🎨 Vertex Paint</button>
        <button type="button" id="btn-insp-open-sg" class="prop-mini-btn" style="flex:1;padding:4px 6px;font-size:10px;background:#22382c;color:#86efac;border:1px solid #356649;border-radius:3px;cursor:pointer;">🧩 ${hasSg ? 'Edit Nodes' : 'Init Nodes'}</button>
      </div>
      <div style="padding-top:6px;border-top:1px solid var(--b-border-dark);">
        <div style="font-size:11px;font-weight:600;color:#fbbf24;margin-bottom:6px;">Rust BVH Texture Baker</div>
        <div class="prop-row">
          <span class="prop-label">Map Type</span>
          <select id="bake-mode-select" style="flex:1;background:var(--b-bg-input);color:var(--b-text-primary);border:1px solid var(--b-border-dark);border-radius:3px;padding:2px 4px;font-size:11px;">
            <option value="ao">Ambient Occlusion (AO)</option>
            <option value="normal">Tangent Normal Map</option>
            <option value="worldNormal">World Normal Map</option>
            <option value="curvature">Curvature / Edge Wear</option>
            <option value="position">Position Map</option>
            <option value="combined">Combined Lightmap (GI)</option>
          </select>
        </div>
        <div class="prop-row">
          <span class="prop-label">Resolution</span>
          <select id="bake-res-select" style="flex:1;background:var(--b-bg-input);color:var(--b-text-primary);border:1px solid var(--b-border-dark);border-radius:3px;padding:2px 4px;font-size:11px;">
            <option value="256">256 × 256</option>
            <option value="512" selected>512 × 512</option>
            <option value="1024">1024 × 1024</option>
          </select>
        </div>
        <div class="prop-row">
          <span class="prop-label">High-Poly</span>
          <select id="bake-highpoly-select" style="flex:1;background:var(--b-bg-input);color:var(--b-text-primary);border:1px solid var(--b-border-dark);border-radius:3px;padding:2px 4px;font-size:11px;">
            <option value="">Self-Bake (Current Mesh)</option>
            ${highOpts}
          </select>
        </div>
        <div class="prop-row">
          <span class="prop-label">Samples</span>
          <input type="number" id="bake-samples-input" min="1" max="128" value="16" style="width:65px;background:var(--b-bg-input);color:var(--b-text-primary);border:1px solid var(--b-border-dark);border-radius:3px;padding:2px 4px;font-size:11px;">
          <span class="prop-label" style="min-width:46px;margin-left:6px;">Margin</span>
          <input type="number" id="bake-margin-input" min="0" max="16" value="4" style="width:48px;background:var(--b-bg-input);color:var(--b-text-primary);border:1px solid var(--b-border-dark);border-radius:3px;padding:2px 4px;font-size:11px;">
        </div>
        <div style="display:flex;align-items:center;gap:6px;margin-top:6px;">
          <button type="button" id="btn-run-rust-bake" style="flex:1;padding:5px 8px;font-size:11px;font-weight:600;background:#b45309;color:#fff;border:1px solid #d97706;border-radius:4px;cursor:pointer;">🔥 Bake Texture</button>
          <span id="bake-status-text" style="font-size:10px;color:#9ca3af;">${stack ? `${stack.slots.size} paint slot(s)` : 'Ready'}</span>
        </div>
      </div>
    `;

    card.body.querySelector('#btn-insp-enter-tp')?.addEventListener('click', () => {
      window.paintMode?.enter(mesh, 'texture-paint');
    });
    card.body.querySelector('#btn-insp-enter-vp')?.addEventListener('click', () => {
      window.paintMode?.enter(mesh, 'vertex-paint');
    });
    card.body.querySelector('#btn-insp-open-sg')?.addEventListener('click', () => {
      if (mat && !getShaderGraphForMaterial(mat)) {
        const g = ShaderGraph.createDefault();
        applyShaderGraphToMaterial(mat, g);
      }
      document.querySelector('.dock-tab[data-pane="dock-shader-editor"]')?.click();
      window.shaderEditor?.syncFromSelection();
    });
    card.body.querySelector('#btn-run-rust-bake')?.addEventListener('click', async () => {
      const btn = card.body.querySelector('#btn-run-rust-bake');
      const status = card.body.querySelector('#bake-status-text');
      const mode = card.body.querySelector('#bake-mode-select')?.value || 'ao';
      const size = parseInt(card.body.querySelector('#bake-res-select')?.value || '512', 10);
      const samples = parseInt(card.body.querySelector('#bake-samples-input')?.value || '16', 10);
      const margin = parseInt(card.body.querySelector('#bake-margin-input')?.value || '4', 10);
      const hpUuid = card.body.querySelector('#bake-highpoly-select')?.value || '';
      const highPolyMesh = hpUuid ? otherMeshes.find((m) => m.uuid === hpUuid) : null;
      if (btn) btn.disabled = true;
      if (status) status.textContent = 'Baking…';
      try {
        const res = await bakeMeshTexture({
          mesh,
          scene: this.sceneManager?.scene,
          highPolyMesh,
          mode,
          width: size,
          height: size,
          samples,
          margin,
          applyToMaterial: true,
        });
        if (status) status.textContent = `✓ ${res.mode} (${res.ms}ms)`;
        this.sceneManager?.requestRender?.();
      } catch (err) {
        if (status) status.textContent = `ERR: ${err.message}`;
      } finally {
        if (btn) btn.disabled = false;
      }
    });

    this.contentBody.appendChild(card.card);
  }

  // =========================================================================
  // Mesh Statistics Section (Vertices & Faces Count)
  // =========================================================================
  renderMeshStatisticsSection() {
    const card = this.createCard('Mesh Statistics', true);
    const geom = this.targetObject.geometry;
    const meshObj = this.targetObject;

    let vertCount = 0;
    let faceCount = 0;
    let triCount = 0;

    if (geom) {
      if (geom.attributes?.position) {
        vertCount = geom.attributes.position.count;
      }
      if (geom.index) {
        triCount = geom.index.count / 3;
        faceCount = triCount;
      } else if (geom.attributes?.position) {
        triCount = Math.floor(geom.attributes.position.count / 3);
        faceCount = triCount;
      }
    }

    const root = this.sceneManager?.rootContainer || null;
    if (root) dataBlockRegistry.syncFromScene(root);
    const meshBlock = meshObj?.isMesh ? dataBlockRegistry.ensureMeshBlock(meshObj) : null;
    const userCount = meshBlock ? Math.max(1, meshBlock.users.size) : 1;

    card.body.innerHTML = `
      <div class="mesh-stat-grid">
        <div class="mesh-stat-row">
          <span class="mesh-stat-label">Vertices:</span>
          <span class="mesh-stat-num">${vertCount.toLocaleString()}</span>
        </div>
        <div class="mesh-stat-row">
          <span class="mesh-stat-label">Faces:</span>
          <span class="mesh-stat-num">${faceCount.toLocaleString()}</span>
        </div>
        <div class="mesh-stat-row">
          <span class="mesh-stat-label">Triangles:</span>
          <span class="mesh-stat-num">${triCount.toLocaleString()}</span>
        </div>
        <div class="mesh-stat-row">
          <span class="mesh-stat-label">Mesh Users:</span>
          <span class="mesh-stat-num" id="insp-mesh-users-badge">${userCount}</span>
        </div>
      </div>
      ${meshBlock && userCount > 1 ? `
        <div style="margin-top:8px; display:flex; align-items:center; justify-content:space-between; gap:6px; padding:5px 6px; background:rgba(52,152,219,0.1); border:1px solid rgba(52,152,219,0.3); border-radius:4px;">
          <span style="font-size:10px; color:#8ecae6; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${escapeHtml(meshBlock.id)}">Linked (${userCount} users)</span>
          <button type="button" class="blender-btn" id="btn-insp-make-single-user" style="padding:2px 8px; font-size:10px; background:#2b4c65; color:#fff; border:1px solid #3c6d91; border-radius:3px; cursor:pointer;">Make Single-User</button>
        </div>
      ` : ''}
    `;

    card.body.querySelector('#btn-insp-make-single-user')?.addEventListener('click', () => {
      if (!meshObj?.isMesh) return;
      dataBlockRegistry.makeSingleUser(meshObj);
      if (root) dataBlockRegistry.syncFromScene(root);
      if (this.sceneManager) this.sceneManager.revision += 1;
      this.render();
    });

    this.contentBody.appendChild(card.card);
  }

  renderVertexGroupsSection() {
    const mesh = this.targetObject;
    if (!mesh || !mesh.isMesh) return;
    const vg = ensureVertexGroups(mesh);
    const activeGroup = vg.activeIndex >= 0 && vg.activeIndex < vg.groups.length ? vg.groups[vg.activeIndex] : null;
    const assignW = typeof this.vgAssignWeight === 'number' ? this.vgAssignWeight : 1.0;
    const card = this.createCard(`Vertex Groups (${vg.groups.length})`, true);

    const rowsHtml = vg.groups.length === 0
      ? `<div style="font-size:11px; color:var(--b-text-secondary); padding:4px 0;">No vertex groups defined on this mesh.</div>`
      : vg.groups.map((g, gi) => {
          const isSel = gi === vg.activeIndex;
          const cnt = Object.keys(g.entries || {}).length;
          return `
            <div class="vg-list-row" data-vg-idx="${gi}" style="display:flex; align-items:center; justify-content:space-between; padding:4px 6px; margin-bottom:2px; border-radius:3px; cursor:pointer; font-size:11px; background:${isSel ? 'rgba(243,156,18,0.22)' : 'var(--b-bg-input)'}; border:1px solid ${isSel ? '#f39c12' : 'var(--b-border-dark)'};">
              <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(g.name)}</span>
              <span style="font-family:monospace; font-size:10px; color:var(--b-text-secondary);">${cnt} vtx</span>
            </div>
          `;
        }).join('');

    card.body.innerHTML = `
      <div style="display:flex; gap:6px; align-items:flex-start;">
        <div style="flex:1; max-height:140px; overflow-y:auto;">${rowsHtml}</div>
        <div style="display:flex; flex-direction:column; gap:4px;">
          <button type="button" class="blender-btn" id="btn-vg-add" title="Add Vertex Group" style="padding:3px 8px; font-size:11px; background:var(--b-bg-input); border:1px solid var(--b-border-dark); color:var(--b-text-primary); border-radius:3px; cursor:pointer;">+</button>
          <button type="button" class="blender-btn" id="btn-vg-remove" title="Remove Active Vertex Group" style="padding:3px 8px; font-size:11px; background:var(--b-bg-input); border:1px solid var(--b-border-dark); color:#ff7675; border-radius:3px; cursor:pointer;" ${activeGroup ? '' : 'disabled'}>−</button>
          <button type="button" class="blender-btn" id="btn-vg-mirror" title="Mirror Weights L <-> R across X=0" style="padding:3px 8px; font-size:10px; background:var(--b-bg-input); border:1px solid var(--b-border-dark); color:var(--b-text-primary); border-radius:3px; cursor:pointer;" ${activeGroup ? '' : 'disabled'}>🪞</button>
        </div>
      </div>
      ${activeGroup ? `
        <div style="display:flex; gap:4px; margin-top:8px;">
          <input type="text" id="inp-vg-rename" value="${escapeHtml(activeGroup.name)}" style="flex:1; background:var(--b-bg-input); color:var(--b-text-primary); border:1px solid var(--b-border-dark); padding:3px 6px; border-radius:3px; font-size:11px;" />
          <button type="button" class="blender-btn" id="btn-vg-rename" style="padding:3px 8px; font-size:11px; background:var(--b-bg-input); border:1px solid var(--b-border-dark); color:var(--b-text-primary); border-radius:3px; cursor:pointer;">Rename</button>
        </div>
        <div class="prop-row" style="margin-top:8px;">
          <span class="prop-label">Weight:</span>
          <div style="flex:1; display:flex; align-items:center; gap:6px;">
            <input type="range" id="inp-vg-weight" min="0" max="1" step="0.05" value="${assignW}" style="flex:1;" />
            <span id="val-vg-weight" style="width:36px; text-align:right; font-family:monospace; font-size:11px;">${assignW.toFixed(2)}</span>
          </div>
        </div>
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:4px; margin-top:6px;">
          <button type="button" class="blender-btn" id="btn-vg-assign" style="padding:4px; font-size:11px; background:var(--b-bg-input); border:1px solid var(--b-border-dark); color:var(--b-text-primary); border-radius:3px; cursor:pointer;">Assign</button>
          <button type="button" class="blender-btn" id="btn-vg-unassign" style="padding:4px; font-size:11px; background:var(--b-bg-input); border:1px solid var(--b-border-dark); color:var(--b-text-primary); border-radius:3px; cursor:pointer;">Remove</button>
          <button type="button" class="blender-btn" id="btn-vg-select" style="padding:4px; font-size:11px; background:var(--b-bg-input); border:1px solid var(--b-border-dark); color:var(--b-text-primary); border-radius:3px; cursor:pointer;">Select</button>
          <button type="button" class="blender-btn" id="btn-vg-deselect" style="padding:4px; font-size:11px; background:var(--b-bg-input); border:1px solid var(--b-border-dark); color:var(--b-text-primary); border-radius:3px; cursor:pointer;">Deselect</button>
        </div>
      ` : ''}
    `;

    const commitVGEdit = (label, mutatorFn) => {
      const before = captureVertexGroupsSnapshot(mesh);
      const changed = mutatorFn();
      if (changed === false || changed === 0) return;
      const after = captureVertexGroupsSnapshot(mesh);
      if (this.sceneManager?.executeCommand) {
        this.sceneManager.executeCommand(
          new VertexGroupsCommand(mesh, before, after, () => this.render(), label)
        );
      }
      this.render();
    };

    card.body.querySelectorAll('.vg-list-row').forEach((row) => {
      row.addEventListener('click', () => {
        setActiveVertexGroup(mesh, Number(row.dataset.vgIdx));
        this.render();
      });
    });

    card.body.querySelector('#btn-vg-add')?.addEventListener('click', () => {
      commitVGEdit('Add Vertex Group', () => Boolean(addVertexGroup(mesh, 'Group')));
    });

    card.body.querySelector('#btn-vg-remove')?.addEventListener('click', () => {
      if (!activeGroup) return;
      commitVGEdit(`Remove Vertex Group ${activeGroup.name}`, () => removeVertexGroup(mesh, vg.activeIndex));
    });

    card.body.querySelector('#btn-vg-mirror')?.addEventListener('click', () => {
      if (!activeGroup) return;
      commitVGEdit(`Mirror Vertex Group ${activeGroup.name}`, () => Boolean(mirrorVertexGroup(mesh, vg.activeIndex)));
    });

    const renameEl = card.body.querySelector('#inp-vg-rename');
    renameEl?.addEventListener('focus', () => { this.isEditingInput = true; });
    renameEl?.addEventListener('blur', () => { this.isEditingInput = false; });
    card.body.querySelector('#btn-vg-rename')?.addEventListener('click', () => {
      if (!activeGroup || !renameEl) return;
      const next = renameEl.value.trim();
      if (!next || next === activeGroup.name) return;
      this.isEditingInput = false;
      commitVGEdit(`Rename Vertex Group -> ${next}`, () => renameVertexGroup(mesh, vg.activeIndex, next));
    });

    card.body.querySelector('#inp-vg-weight')?.addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      this.vgAssignWeight = v;
      const lbl = card.body.querySelector('#val-vg-weight');
      if (lbl) lbl.textContent = v.toFixed(2);
    });

    card.body.querySelector('#btn-vg-assign')?.addEventListener('click', () => {
      if (!activeGroup) return;
      const editMode = window.editMode;
      const verts = getEditModeBufferVertexIndices(editMode, mesh);
      if (!verts.length) {
        if (window.codeEditor) window.codeEditor.log('warn', 'Enter Edit Mode and select vertices to assign to Vertex Group.');
        return;
      }
      const w = typeof this.vgAssignWeight === 'number' ? this.vgAssignWeight : 1.0;
      commitVGEdit(`Assign ${verts.length} verts -> ${activeGroup.name}`, () => assignVerticesToGroup(mesh, vg.activeIndex, verts, w, 'replace'));
    });

    card.body.querySelector('#btn-vg-unassign')?.addEventListener('click', () => {
      if (!activeGroup) return;
      const editMode = window.editMode;
      const verts = getEditModeBufferVertexIndices(editMode, mesh);
      if (!verts.length) {
        if (window.codeEditor) window.codeEditor.log('warn', 'Enter Edit Mode and select vertices to remove from Vertex Group.');
        return;
      }
      commitVGEdit(`Remove ${verts.length} verts from ${activeGroup.name}`, () => removeVerticesFromGroup(mesh, vg.activeIndex, verts));
    });

    card.body.querySelector('#btn-vg-select')?.addEventListener('click', () => {
      if (!activeGroup) return;
      selectGroupVertices(mesh, vg.activeIndex, window.editMode);
      if (this.sceneManager?.requestRender) this.sceneManager.requestRender();
    });

    card.body.querySelector('#btn-vg-deselect')?.addEventListener('click', () => {
      if (!activeGroup) return;
      deselectGroupVertices(mesh, vg.activeIndex, window.editMode);
      if (this.sceneManager?.requestRender) this.sceneManager.requestRender();
    });

    this.contentBody.appendChild(card.card);
  }

  renderNormalsSection() {
    const mesh = this.targetObject;
    if (!mesh || !mesh.isMesh) return;
    const card = this.createCard('Normals & Shading (Blender 4.x)', true);
    const shading = getShadingState(mesh);
    const mode = shading.mode || 'smooth';
    const angle = shading.angleDeg ?? 30;

    card.body.innerHTML = `
      <!-- Shading Mode Switcher -->
      <div class="prop-row">
        <span class="prop-label">Mode</span>
        <div class="mod-axis-group" style="flex: 1;">
          <button class="mod-axis-btn ${mode === 'flat' ? 'active' : ''}" id="btn-shade-flat" style="flex:1;">Flat</button>
          <button class="mod-axis-btn ${mode === 'smooth' ? 'active' : ''}" id="btn-shade-smooth" style="flex:1;">Smooth</button>
          <button class="mod-axis-btn ${mode === 'auto' ? 'active' : ''}" id="btn-shade-auto" style="flex:1;">Auto Smooth</button>
        </div>
      </div>

      <!-- Auto Smooth Angle Slider -->
      <div class="prop-row" id="row-auto-smooth-angle" style="${mode === 'auto' ? '' : 'display:none;'}">
        <span class="prop-label">Angle</span>
        <div class="prop-slider-wrap">
          <input type="range" class="prop-slider" id="inp-auto-smooth-angle" min="1" max="180" step="1" value="${angle}" />
          <span class="prop-slider-val" id="val-auto-smooth-angle">${angle}°</span>
        </div>
      </div>

      <!-- Recalculate / Flip Actions -->
      <div class="prop-row" style="margin-top: 4px; gap: 6px;">
        <button class="timeline-btn" id="btn-recalc-outside" style="flex: 1; padding: 4px; font-size: 11px;" title="Shift+N">
          ↻ Outside
        </button>
        <button class="timeline-btn" id="btn-recalc-inside" style="flex: 1; padding: 4px; font-size: 11px;" title="Shift+Ctrl+N">
          ↺ Inside
        </button>
        <button class="timeline-btn" id="btn-flip-normals" style="flex: 1; padding: 4px; font-size: 11px;">
          ⇄ Flip
        </button>
      </div>
    `;

    const btnFlat = card.body.querySelector('#btn-shade-flat');
    const btnSmooth = card.body.querySelector('#btn-shade-smooth');
    const btnAuto = card.body.querySelector('#btn-shade-auto');
    const rowAngle = card.body.querySelector('#row-auto-smooth-angle');
    const inpAngle = card.body.querySelector('#inp-auto-smooth-angle');
    const valAngle = card.body.querySelector('#val-auto-smooth-angle');

    const setMode = (newMode) => {
      setMeshShading(mesh, newMode, { angleDeg: parseInt(inpAngle.value, 10), sceneManager: this.sceneManager });
      if (this.sceneManager?.requestRender) this.sceneManager.requestRender();
      this.render();
    };

    btnFlat.addEventListener('click', () => setMode(SHADING_MODES.FLAT));
    btnSmooth.addEventListener('click', () => setMode(SHADING_MODES.SMOOTH));
    btnAuto.addEventListener('click', () => setMode(SHADING_MODES.AUTO));

    inpAngle.addEventListener('input', (e) => {
      const a = parseInt(e.target.value, 10);
      valAngle.textContent = `${a}°`;
      setMeshShading(mesh, SHADING_MODES.AUTO, { angleDeg: a, sceneManager: this.sceneManager });
      if (this.sceneManager?.requestRender) this.sceneManager.requestRender();
    });

    card.body.querySelector('#btn-recalc-outside').addEventListener('click', () => {
      recalculateMeshNormals(mesh, false);
      if (this.sceneManager?.requestRender) this.sceneManager.requestRender();
    });
    card.body.querySelector('#btn-recalc-inside').addEventListener('click', () => {
      recalculateMeshNormals(mesh, true);
      if (this.sceneManager?.requestRender) this.sceneManager.requestRender();
    });
    card.body.querySelector('#btn-flip-normals').addEventListener('click', () => {
      flipMeshNormals(mesh);
      if (this.sceneManager?.requestRender) this.sceneManager.requestRender();
    });

    this.contentBody.appendChild(card.card);
  }

  // =========================================================================
  // Modifiers Section (Blender 4.x Modifier Stack)
  // =========================================================================
  renderModifierSection() {
    if (!this.targetObject || !this.targetObject.isMesh) {
      this.contentBody.innerHTML = `
        <div class="empty-inspector-msg">
          <svg viewBox="0 0 24 24" width="32" height="32" fill="currentColor" style="opacity: 0.3; margin-bottom: 8px;">
            <path d="M14.7 10.3l-2.4-2.4c.2-.6.2-1.2 0-1.8l2.4-2.4a1 1 0 0 0 0-1.4l-1.4-1.4a1 1 0 0 0-1.4 0L9.5 3.3c-.6-.2-1.2-.2-1.8 0L5.3.9a1 1 0 0 0-1.4 0L2.5 2.3a1 1 0 0 0 0 1.4l2.4 2.4c-.2.6-.2 1.2 0 1.8L2.5 10.3a1 1 0 0 0 0 1.4l1.4 1.4a1 1 0 0 0 1.4 0l2.4-2.4c.6.2 1.2.2 1.8 0l2.4 2.4a1 1 0 0 0 1.4 0l1.4-1.4a1 1 0 0 0 0-1.4zM8 9.5A1.5 1.5 0 1 1 8 6.5a1.5 1.5 0 0 1 0 3z"/>
          </svg>
          <div>Modifiers can only be applied to Mesh objects. Select a Mesh in the Viewport or Outliner.</div>
        </div>
      `;
      return;
    }

    const mesh = this.targetObject;
    const stack = getModifierStack(mesh);

    // Top Action Bar: Add Modifier Dropdown
    const topBar = document.createElement('div');
    topBar.className = 'modifier-menu-bar';
    topBar.innerHTML = `
      <div class="modifier-select-wrapper">
        <select class="modifier-select" id="modifier-add-select">
          <option value="" disabled selected>🔧 Add Modifier...</option>
          <optgroup label="Generate">
            <option value="array">Array (Linear Clones)</option>
            <option value="boolean">Boolean (Difference / Union / Intersect)</option>
            <option value="bevel">Bevel (Edge Chamfer)</option>
            <option value="decimate">Decimate (Polycount Reduction)</option>
            <option value="mirror">Mirror (Symmetry X / Y / Z)</option>
            <option value="multires">Multiresolution (Sculpt Levels)</option>
            <option value="remesh">Remesh (Voxel / Surface-Nets / Blocks)</option>
            <option value="screw">Screw / Lathe (360° &amp; Helical Extrude)</option>
            <option value="skin">Skin (Tubular Edge Skeleton)</option>
            <option value="solidify">Solidify (Shell Thickness & Rim)</option>
            <option value="subdivide">Subdivision Surface (Smooth)</option>
            <option value="weld">Weld (Merge by Distance)</option>
            <option value="wireframe">Wireframe (Polygon Lattice)</option>
          </optgroup>
          <optgroup label="Deform">
            <option value="cast">Cast (Sphere / Cylinder / Cuboid)</option>
            <option value="curve">Curve Deform (Follow Bezier/Path)</option>
            <option value="displace">Displace (fBm Procedural Noise)</option>
            <option value="lattice">Lattice (FFD Cage Deform)</option>
            <option value="randomize">Randomize (Seeded Jitter)</option>
            <option value="shrinkwrap">Shrinkwrap (Snap to Target Mesh)</option>
            <option value="simple_deform">SimpleDeform (Twist / Bend / Taper / Stretch)</option>
            <option value="smooth">Smooth (Laplacian Relaxation)</option>
            <option value="wave">Wave (Traveling Surface Ripple)</option>
          </optgroup>
          <optgroup label="Modify / Normals">
            <option value="data_transfer">DataTransfer (Normals / UVs / Colors)</option>
            <option value="weighted_normal">Weighted Normal (Hard-Surface Shading)</option>
          </optgroup>
        </select>
      </div>
    `;

    const addSelect = topBar.querySelector('#modifier-add-select');
    addSelect.addEventListener('change', (e) => {
      const type = e.target.value;
      if (!type) return;
      e.target.value = '';
      let initParams = {};
      if (type === 'boolean') {
        const selected = typeof this.sceneManager?.getSelectedObjects === 'function'
          ? this.sceneManager.getSelectedObjects()
          : [];
        const other = selected.find((o) => o && o !== mesh && o.isMesh);
        if (other) {
          initParams = {
            operandType: 'object',
            targetId: other.userData?.id || other.uuid,
            targetName: other.name || '',
            cutterDisplay: 'wire'
          };
        }
      }
      this._runStackOp(ModifierStack.addModifier(mesh, type, initParams, { sceneManager: this.sceneManager }));
    });

    this.contentBody.appendChild(topBar);

    if (this._stackError) {
      const errDiv = document.createElement('div');
      errDiv.style.cssText = 'color:#e06c75; font-size:11px; padding:6px 8px; border:1px solid #5a2a2a; border-radius:4px; margin-bottom:6px;';
      errDiv.textContent = this._stackError;
      this.contentBody.appendChild(errDiv);
    }

    // If stack is empty
    if (stack.length === 0) {
      const emptyMsg = document.createElement('div');
      emptyMsg.className = 'empty-inspector-msg';
      emptyMsg.style.padding = '20px 8px';
      emptyMsg.innerHTML = `
        <div style="font-size: 12px; color: var(--b-text-secondary); margin-bottom: 6px;">
          No active modifiers on this mesh.
        </div>
        <div style="font-size: 11px; color: var(--b-text-muted);">
          Select an option from <strong>Add Modifier</strong> above to apply procedural geometry.
        </div>
      `;
      this.contentBody.appendChild(emptyMsg);
      return;
    }

    // Active Modifier Cards List
    const stackList = document.createElement('div');
    stackList.className = 'modifier-stack-list';

    stack.forEach((mod, index) => {
      const card = this.createModifierCard(mesh, mod, index);
      stackList.appendChild(card);
    });

    this.contentBody.appendChild(stackList);

    // Bottom Stack Actions (Bake All / Remove All)
    const bottomBar = document.createElement('div');
    bottomBar.className = 'modifier-stack-actions';
    bottomBar.innerHTML = `
      <button class="timeline-btn" id="btn-bake-all-modifiers" style="flex: 1; padding: 5px; font-size: 11px; background: #2c4230; color: #a8f0b7; border-color: #3b5a41;" title="Apply all modifiers permanently into geometry">
        ✓ Apply All
      </button>
      <button class="timeline-btn" id="btn-clear-all-modifiers" style="flex: 1; padding: 5px; font-size: 11px; color: #e06c75;" title="Remove all modifiers and restore original geometry">
        ✕ Remove All
      </button>
    `;

    bottomBar.querySelector('#btn-bake-all-modifiers').addEventListener('click', () => {
      this._runStackOp(ModifierStack.bakeModifiers(mesh, null, { sceneManager: this.sceneManager }));
    });

    bottomBar.querySelector('#btn-clear-all-modifiers').addEventListener('click', () => {
      const removeAll = async () => {
        while (getModifierStack(mesh).length > 0) {
          await ModifierStack.removeModifier(mesh, 0, { sceneManager: this.sceneManager });
        }
      };
      this._runStackOp(removeAll());
    });

    this.contentBody.appendChild(bottomBar);
  }

  /**
   * Builds an interactive modifier rollout card for the Inspector.
   * @param {THREE.Mesh} mesh 
   * @param {Object} mod 
   * @param {number} index 
   * @returns {HTMLElement}
   */
  createModifierCard(mesh, mod, index) {
    const card = document.createElement('div');
    card.className = `modifier-card ${mod.enabled ? '' : 'disabled'}`;
    card.dataset.id = mod.id;

    // Pick icon based on modifier type
    let iconSvg = '';
    switch (mod.type) {
      case 'array':
        iconSvg = `<svg class="modifier-card-icon" viewBox="0 0 16 16"><rect x="1" y="5" width="6" height="6" rx="1" fill="currentColor"/><rect x="8" y="5" width="6" height="6" rx="1" fill="currentColor" opacity="0.6"/></svg>`;
        break;
      case 'mirror':
        iconSvg = `<svg class="modifier-card-icon" viewBox="0 0 16 16"><path d="M7 2L2 14h5V2zm2 0v12h5L9 2z" fill="currentColor"/></svg>`;
        break;
      case 'wireframe':
        iconSvg = `<svg class="modifier-card-icon" viewBox="0 0 16 16"><path d="M2 2h12v12H2V2zm1 1v10h10V3H3zm2 2h6v6H5V5z" fill="currentColor"/></svg>`;
        break;
      case 'bevel':
        iconSvg = `<svg class="modifier-card-icon" viewBox="0 0 16 16"><path d="M4 1h8l3 3v8l-3 3H4l-3-3V4l3-3z" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>`;
        break;
      case 'solidify':
        iconSvg = `<svg class="modifier-card-icon" viewBox="0 0 16 16"><rect x="2" y="2" width="12" height="12" rx="1" fill="none" stroke="currentColor" stroke-width="1.5"/><rect x="5" y="5" width="6" height="6" rx="0.5" fill="currentColor" opacity="0.6"/></svg>`;
        break;
      case 'displace':
        iconSvg = `<svg class="modifier-card-icon" viewBox="0 0 16 16"><path d="M1 12c3-4 5 2 8-2s4 1 6-4" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="5" cy="6" r="1.5" fill="currentColor"/></svg>`;
        break;
      case 'smooth':
        iconSvg = `<svg class="modifier-card-icon" viewBox="0 0 16 16"><path d="M2 13C5 7 11 7 14 13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
        break;
      case 'randomize':
        iconSvg = `<svg class="modifier-card-icon" viewBox="0 0 16 16"><circle cx="4" cy="4" r="1.5" fill="currentColor"/><circle cx="11" cy="6" r="2" fill="currentColor"/><circle cx="6" cy="11" r="1.8" fill="currentColor"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/></svg>`;
        break;
      case 'subdivide':
      case 'subdivision':
        iconSvg = `<svg class="modifier-card-icon" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 2v12M2 8h12" stroke="currentColor" stroke-width="1"/></svg>`;
        break;
      case 'boolean':
      case 'bool':
        iconSvg = `<svg class="modifier-card-icon" viewBox="0 0 16 16"><rect x="2" y="4" width="8" height="8" rx="1" fill="currentColor" opacity="0.6"/><rect x="6" y="4" width="8" height="8" rx="1" fill="none" stroke="currentColor" stroke-width="1.4" stroke-dasharray="2 1.5"/></svg>`;
        break;
      case 'decimate':
        iconSvg = `<svg class="modifier-card-icon" viewBox="0 0 16 16"><polygon points="8,2 14,13 2,13" fill="none" stroke="currentColor" stroke-width="1.5"/><line x1="5" y1="8" x2="11" y2="8" stroke="currentColor" stroke-width="1.2"/></svg>`;
        break;
      case 'screw':
      case 'lathe':
        iconSvg = `<svg class="modifier-card-icon" viewBox="0 0 16 16"><ellipse cx="8" cy="4" rx="5" ry="2" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M3 4c0 3 10 3 10 6s-10 2-10 4" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>`;
        break;
      case 'weighted_normal':
      case 'weightednormal':
        iconSvg = `<svg class="modifier-card-icon" viewBox="0 0 16 16"><rect x="3" y="6" width="10" height="7" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 6V1M6 3l2-2 2 2" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>`;
        break;
      default:
        iconSvg = `<svg class="modifier-card-icon" viewBox="0 0 16 16"><rect x="2" y="2" width="12" height="12" rx="2" fill="currentColor"/></svg>`;
    }

    // Header
    const header = document.createElement('div');
    header.className = 'modifier-card-header';
    header.innerHTML = `
      <div class="modifier-card-title-group" title="Click to collapse/expand">
        <span class="prop-card-arrow">&#9662;</span>
        ${iconSvg}
        <span>${escapeHtml(mod.name)}</span>
      </div>
      <div class="modifier-card-actions">
        <button class="mod-btn mod-btn-up" title="Move Modifier Up" style="padding:1px 5px;font-size:10px;">▲</button>
        <button class="mod-btn mod-btn-down" title="Move Modifier Down" style="padding:1px 5px;font-size:10px;">▼</button>
        <button class="mod-btn mod-btn-toggle ${mod.enabled ? 'active' : ''}" title="${mod.enabled ? 'Disable Modifier' : 'Enable Modifier'}">
          ${mod.enabled ? '👁' : '🚫'}
        </button>
        <button class="mod-btn mod-btn-apply" title="Apply modifier permanently to base geometry">
          Apply
        </button>
        <button class="mod-btn mod-btn-remove" title="Remove modifier">
          ✕
        </button>
      </div>
    `;

    // Header interaction
    const titleGroup = header.querySelector('.modifier-card-title-group');
    titleGroup.addEventListener('click', () => {
      card.classList.toggle('collapsed');
    });

    const stackCount = getModifierStack(mesh).length;
    const btnUp = header.querySelector('.mod-btn-up');
    const btnDown = header.querySelector('.mod-btn-down');
    if (btnUp) {
      btnUp.disabled = index <= 0;
      btnUp.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = getModifierStack(mesh).findIndex((m) => m.id === mod.id);
        if (idx > 0) this._runStackOp(ModifierStack.reorderModifier(mesh, idx, idx - 1, { sceneManager: this.sceneManager }));
      });
    }
    if (btnDown) {
      btnDown.disabled = index >= stackCount - 1;
      btnDown.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = getModifierStack(mesh).findIndex((m) => m.id === mod.id);
        if (idx >= 0 && idx < getModifierStack(mesh).length - 1) {
          this._runStackOp(ModifierStack.reorderModifier(mesh, idx, idx + 1, { sceneManager: this.sceneManager }));
        }
      });
    }

    const btnToggle = header.querySelector('.mod-btn-toggle');
    btnToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = getModifierStack(mesh).findIndex((m) => m.id === mod.id);
      if (idx < 0) return;
      this._runStackOp(ModifierStack.toggleModifier(mesh, idx, { sceneManager: this.sceneManager }));
    });

    const btnApply = header.querySelector('.mod-btn-apply');
    btnApply.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = getModifierStack(mesh).findIndex((m) => m.id === mod.id);
      if (idx < 0) return;
      this._runStackOp(ModifierStack.bakeModifiers(mesh, idx, { sceneManager: this.sceneManager }));
    });

    const btnRemove = header.querySelector('.mod-btn-remove');
    btnRemove.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = getModifierStack(mesh).findIndex((m) => m.id === mod.id);
      if (idx < 0) return;
      this._runStackOp(ModifierStack.removeModifier(mesh, idx, { sceneManager: this.sceneManager }));
    });

    card.appendChild(header);

    // Body
    const body = document.createElement('div');
    body.className = 'modifier-card-body';

    // Populate body controls according to modifier type
    this.renderModifierControls(mesh, mod, body);

    card.appendChild(body);
    return card;
  }

  /** Chạy một thao tác stack async; lỗi hiện inline, không alert loop. */
  _runStackOp(promise, { rerender = true } = {}) {
    promise
      .then(() => {
        this._stackError = null;
        if (this.sceneManager?.requestRender) this.sceneManager.requestRender();
        if (rerender) this.render();
      })
      .catch((err) => {
        if (err?.cancelled) return;
        this._stackError = String((err && err.message) || err);
        this.render();
      });
  }

  /**
   * Renders specific controls for a modifier type.
   * @param {THREE.Mesh} mesh
   * @param {Object} mod
   * @param {HTMLElement} body
   */
  renderModifierControls(mesh, mod, body) {
    const onParamChange = (newParams) => {
      const idx = getModifierStack(mesh).findIndex((m) => m.id === mod.id);
      if (idx < 0) return;
      // A slider drag fires `input` once per pixel. Coalesce the whole gesture
      // into a single undo entry and keep the live slider mounted in the DOM.
      this._runStackOp(ModifierStack.scrubModifier(mesh, idx, newParams, {
        sceneManager: this.sceneManager,
        description: 'Update modifier'
      }), { rerender: false });
    };

    if (mod.type === 'array') {
      const count = mod.params.count ?? 3;
      const offX = mod.params.offset?.x ?? 1.5;
      const offY = mod.params.offset?.y ?? 0.0;
      const offZ = mod.params.offset?.z ?? 0.0;
      const relOff = mod.params.useRelativeOffset !== false;
      const constOff = !!mod.params.useConstantOffset;
      const cX = mod.params.constantOffset?.x ?? 0.0;
      const cY = mod.params.constantOffset?.y ?? 0.0;
      const cZ = mod.params.constantOffset?.z ?? 0.0;

      body.innerHTML = `
        <!-- Count -->
        <div class="prop-row">
          <span class="prop-label">Count</span>
          <div class="prop-slider-wrap">
            <input type="range" class="prop-slider" id="mod-arr-count-slider" min="1" max="20" step="1" value="${count}" />
            <span class="prop-slider-val" id="mod-arr-count-val">${count}</span>
          </div>
        </div>

        <!-- Relative Offset -->
        <div class="prop-row">
          <span class="prop-label">Relative</span>
          <label class="prop-checkbox-wrap">
            <input type="checkbox" class="prop-checkbox" id="mod-arr-rel" ${relOff ? 'checked' : ''} />
            <span style="font-size: 11px; color: var(--b-text-secondary);">Relative to Object Size</span>
          </label>
        </div>

        <div class="prop-row" id="mod-arr-rel-wrap" style="${relOff ? '' : 'display:none;'}">
          <span class="prop-label">Factor</span>
          <div class="prop-field-group">
            <div class="scrub-input-wrap">
              <span class="scrub-badge axis-x">X</span>
              <input type="number" class="scrub-input" id="mod-arr-rx" step="0.1" value="${offX}" />
            </div>
            <div class="scrub-input-wrap">
              <span class="scrub-badge axis-y">Y</span>
              <input type="number" class="scrub-input" id="mod-arr-ry" step="0.1" value="${offY}" />
            </div>
            <div class="scrub-input-wrap">
              <span class="scrub-badge axis-z">Z</span>
              <input type="number" class="scrub-input" id="mod-arr-rz" step="0.1" value="${offZ}" />
            </div>
          </div>
        </div>

        <!-- Constant Offset -->
        <div class="prop-row">
          <span class="prop-label">Constant</span>
          <label class="prop-checkbox-wrap">
            <input type="checkbox" class="prop-checkbox" id="mod-arr-const" ${constOff ? 'checked' : ''} />
            <span style="font-size: 11px; color: var(--b-text-secondary);">Absolute Distance (m)</span>
          </label>
        </div>

        <div class="prop-row" id="mod-arr-const-wrap" style="${constOff ? '' : 'display:none;'}">
          <span class="prop-label">Distance</span>
          <div class="prop-field-group">
            <div class="scrub-input-wrap">
              <span class="scrub-badge axis-x">X</span>
              <input type="number" class="scrub-input" id="mod-arr-cx" step="0.5" value="${cX}" />
            </div>
            <div class="scrub-input-wrap">
              <span class="scrub-badge axis-y">Y</span>
              <input type="number" class="scrub-input" id="mod-arr-cy" step="0.5" value="${cY}" />
            </div>
            <div class="scrub-input-wrap">
              <span class="scrub-badge axis-z">Z</span>
              <input type="number" class="scrub-input" id="mod-arr-cz" step="0.5" value="${cZ}" />
            </div>
          </div>
        </div>
      `;

      // Event listeners
      const sliderCount = body.querySelector('#mod-arr-count-slider');
      const valCount = body.querySelector('#mod-arr-count-val');
      sliderCount.addEventListener('input', (e) => {
        const val = parseInt(e.target.value, 10);
        valCount.textContent = val;
        onParamChange({ count: val });
      });

      const chkRel = body.querySelector('#mod-arr-rel');
      const wrapRel = body.querySelector('#mod-arr-rel-wrap');
      chkRel.addEventListener('change', (e) => {
        wrapRel.style.display = e.target.checked ? '' : 'none';
        onParamChange({ useRelativeOffset: e.target.checked });
      });

      const inpRx = body.querySelector('#mod-arr-rx');
      const inpRy = body.querySelector('#mod-arr-ry');
      const inpRz = body.querySelector('#mod-arr-rz');
      const updateRelOffset = () => {
        onParamChange({
          offset: {
            x: parseFloat(inpRx.value) || 0,
            y: parseFloat(inpRy.value) || 0,
            z: parseFloat(inpRz.value) || 0
          }
        });
      };
      inpRx.addEventListener('input', updateRelOffset);
      inpRy.addEventListener('input', updateRelOffset);
      inpRz.addEventListener('input', updateRelOffset);

      const chkConst = body.querySelector('#mod-arr-const');
      const wrapConst = body.querySelector('#mod-arr-const-wrap');
      chkConst.addEventListener('change', (e) => {
        wrapConst.style.display = e.target.checked ? '' : 'none';
        onParamChange({ useConstantOffset: e.target.checked });
      });

      const inpCx = body.querySelector('#mod-arr-cx');
      const inpCy = body.querySelector('#mod-arr-cy');
      const inpCz = body.querySelector('#mod-arr-cz');
      const updateConstOffset = () => {
        onParamChange({
          constantOffset: {
            x: parseFloat(inpCx.value) || 0,
            y: parseFloat(inpCy.value) || 0,
            z: parseFloat(inpCz.value) || 0
          }
        });
      };
      inpCx.addEventListener('input', updateConstOffset);
      inpCy.addEventListener('input', updateConstOffset);
      inpCz.addEventListener('input', updateConstOffset);

    } else if (mod.type === 'mirror') {
      const mX = !!mod.params.mirrorX;
      const mY = !!mod.params.mirrorY;
      const mZ = !!mod.params.mirrorZ;
      const merge = mod.params.merge !== false;
      const thresh = mod.params.mergeThreshold ?? 0.005;

      body.innerHTML = `
        <!-- Axis Selection -->
        <div class="prop-row">
          <span class="prop-label">Axis</span>
          <div class="mod-axis-group" style="flex: 1;">
            <button class="mod-axis-btn axis-x ${mX ? 'active' : ''}" id="mod-mir-btn-x">X</button>
            <button class="mod-axis-btn axis-y ${mY ? 'active' : ''}" id="mod-mir-btn-y">Y</button>
            <button class="mod-axis-btn axis-z ${mZ ? 'active' : ''}" id="mod-mir-btn-z">Z</button>
          </div>
        </div>

        <!-- Merge Seams -->
        <div class="prop-row">
          <span class="prop-label">Merge</span>
          <label class="prop-checkbox-wrap">
            <input type="checkbox" class="prop-checkbox" id="mod-mir-merge" ${merge ? 'checked' : ''} />
            <span style="font-size: 11px; color: var(--b-text-secondary);">Weld symmetry seam</span>
          </label>
        </div>

        <!-- Merge Distance -->
        <div class="prop-row">
          <span class="prop-label">Threshold</span>
          <div class="prop-slider-wrap">
            <input type="range" class="prop-slider" id="mod-mir-thresh-slider" min="0.001" max="0.05" step="0.001" value="${thresh}" />
            <span class="prop-slider-val" id="mod-mir-thresh-val">${thresh.toFixed(3)}m</span>
          </div>
        </div>
      `;

      const btnX = body.querySelector('#mod-mir-btn-x');
      const btnY = body.querySelector('#mod-mir-btn-y');
      const btnZ = body.querySelector('#mod-mir-btn-z');

      btnX.addEventListener('click', () => {
        const next = !btnX.classList.contains('active');
        btnX.classList.toggle('active', next);
        onParamChange({ mirrorX: next });
      });

      btnY.addEventListener('click', () => {
        const next = !btnY.classList.contains('active');
        btnY.classList.toggle('active', next);
        onParamChange({ mirrorY: next });
      });

      btnZ.addEventListener('click', () => {
        const next = !btnZ.classList.contains('active');
        btnZ.classList.toggle('active', next);
        onParamChange({ mirrorZ: next });
      });

      const chkMerge = body.querySelector('#mod-mir-merge');
      chkMerge.addEventListener('change', (e) => {
        onParamChange({ merge: e.target.checked });
      });

      const sliderThresh = body.querySelector('#mod-mir-thresh-slider');
      const valThresh = body.querySelector('#mod-mir-thresh-val');
      sliderThresh.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        valThresh.textContent = `${val.toFixed(3)}m`;
        onParamChange({ mergeThreshold: val });
      });

    } else if (mod.type === 'wireframe') {
      const thickness = mod.params.thickness ?? 0.03;
      const replace = mod.params.replaceOriginal !== false;

      body.innerHTML = `
        <!-- Thickness -->
        <div class="prop-row">
          <span class="prop-label">Thickness</span>
          <div class="prop-slider-wrap">
            <input type="range" class="prop-slider" id="mod-wire-thick" min="0.005" max="0.2" step="0.005" value="${thickness}" />
            <span class="prop-slider-val" id="mod-wire-thick-val">${thickness.toFixed(3)}m</span>
          </div>
        </div>

        <!-- Replace Original -->
        <div class="prop-row">
          <span class="prop-label">Replace</span>
          <label class="prop-checkbox-wrap">
            <input type="checkbox" class="prop-checkbox" id="mod-wire-replace" ${replace ? 'checked' : ''} />
            <span style="font-size: 11px; color: var(--b-text-secondary);">Remove original faces</span>
          </label>
        </div>
      `;

      const sliderThick = body.querySelector('#mod-wire-thick');
      const valThick = body.querySelector('#mod-wire-thick-val');
      sliderThick.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        valThick.textContent = `${val.toFixed(3)}m`;
        onParamChange({ thickness: val });
      });

      const chkReplace = body.querySelector('#mod-wire-replace');
      chkReplace.addEventListener('change', (e) => {
        onParamChange({ replaceOriginal: e.target.checked });
      });

    } else if (mod.type === 'subdivide' || mod.type === 'subdivision') {
      const subdivisions = mod.params.subdivisions ?? 1;
      const renderLevels = mod.params.renderLevels ?? Math.max(subdivisions, 2);
      const subType = mod.params.subdivisionType || (mod.params.smooth === false ? 'simple' : 'catmull-clark');
      const crease = mod.params.crease ?? 0.0;
      const uvSmooth = mod.params.uvSmooth !== false;

      body.innerHTML = `
        <!-- Subdivision Algorithm Type -->
        <div class="prop-row">
          <span class="prop-label">Type</span>
          <div class="mod-axis-group" style="flex: 1;">
            <button class="mod-axis-btn ${subType === 'catmull-clark' ? 'active' : ''}" id="mod-sub-type-cc" style="flex:1;">Catmull-Clark</button>
            <button class="mod-axis-btn ${subType === 'simple' ? 'active' : ''}" id="mod-sub-type-simple" style="flex:1;">Simple</button>
          </div>
        </div>

        <!-- Levels Viewport -->
        <div class="prop-row">
          <span class="prop-label">Levels Viewport</span>
          <div class="prop-slider-wrap">
            <input type="range" class="prop-slider" id="mod-sub-level" min="0" max="4" step="1" value="${subdivisions}" />
            <span class="prop-slider-val" id="mod-sub-level-val">${subdivisions}</span>
          </div>
        </div>

        <!-- Render Levels -->
        <div class="prop-row">
          <span class="prop-label">Render</span>
          <div class="prop-slider-wrap">
            <input type="range" class="prop-slider" id="mod-sub-render" min="1" max="4" step="1" value="${renderLevels}" />
            <span class="prop-slider-val" id="mod-sub-render-val">${renderLevels}</span>
          </div>
        </div>

        <!-- Crease Weight -->
        <div class="prop-row">
          <span class="prop-label">Crease</span>
          <div class="prop-slider-wrap">
            <input type="range" class="prop-slider" id="mod-sub-crease" min="0" max="1" step="0.05" value="${crease}" />
            <span class="prop-slider-val" id="mod-sub-crease-val">${crease.toFixed(2)}</span>
          </div>
        </div>

        <!-- UV Smooth -->
        <div class="prop-row">
          <span class="prop-label">UV Smooth</span>
          <label class="prop-checkbox-wrap">
            <input type="checkbox" class="prop-checkbox" id="mod-sub-uv" ${uvSmooth ? 'checked' : ''} />
            <span style="font-size: 11px; color: var(--b-text-secondary);">Interpolate texture coordinates</span>
          </label>
        </div>
      `;

      body.querySelector('#mod-sub-type-cc').addEventListener('click', () => {
        onParamChange({ subdivisionType: 'catmull-clark', smooth: true });
      });
      body.querySelector('#mod-sub-type-simple').addEventListener('click', () => {
        onParamChange({ subdivisionType: 'simple', smooth: false });
      });

      const sliderSub = body.querySelector('#mod-sub-level');
      const valSub = body.querySelector('#mod-sub-level-val');
      sliderSub.addEventListener('input', (e) => {
        const val = parseInt(e.target.value, 10);
        valSub.textContent = val;
        onParamChange({ subdivisions: val, levels: val });
      });

      const sliderRender = body.querySelector('#mod-sub-render');
      const valRender = body.querySelector('#mod-sub-render-val');
      sliderRender.addEventListener('input', (e) => {
        const val = parseInt(e.target.value, 10);
        valRender.textContent = val;
        onParamChange({ renderLevels: val });
      });

      const sliderCrease = body.querySelector('#mod-sub-crease');
      const valCrease = body.querySelector('#mod-sub-crease-val');
      sliderCrease.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        valCrease.textContent = val.toFixed(2);
        onParamChange({ crease: val });
      });

      body.querySelector('#mod-sub-uv').addEventListener('change', (e) => {
        onParamChange({ uvSmooth: e.target.checked });
      });

    } else if (mod.type === 'bevel') {
      const width = mod.params.width ?? 0.08;
      const segments = mod.params.segments ?? 1;
      const profile = mod.params.profile ?? 0.5;
      const clampOverlap = mod.params.clampOverlap !== false;
      const limitMethod = mod.params.limitMethod || 'none';
      const angleLimitDeg = mod.params.angleLimitDeg ?? 30;
      const hardenNormals = !!mod.params.hardenNormals;

      body.innerHTML = `
        <!-- Width / Offset -->
        <div class="prop-row">
          <span class="prop-label">Width</span>
          <div class="prop-slider-wrap">
            <input type="range" class="prop-slider" id="mod-bev-width" min="0.005" max="0.5" step="0.005" value="${width}" />
            <span class="prop-slider-val" id="mod-bev-width-val">${width.toFixed(3)}m</span>
          </div>
        </div>

        <!-- Segments -->
        <div class="prop-row">
          <span class="prop-label">Segments</span>
          <div class="prop-slider-wrap">
            <input type="range" class="prop-slider" id="mod-bev-seg" min="1" max="8" step="1" value="${segments}" />
            <span class="prop-slider-val" id="mod-bev-seg-val">${segments}</span>
          </div>
        </div>

        <!-- Profile Shape -->
        <div class="prop-row">
          <span class="prop-label">Profile</span>
          <div class="prop-slider-wrap">
            <input type="range" class="prop-slider" id="mod-bev-prof" min="0" max="1" step="0.05" value="${profile}" />
            <span class="prop-slider-val" id="mod-bev-prof-val">${profile.toFixed(2)}</span>
          </div>
        </div>

        <!-- Limit Method -->
        <div class="prop-row">
          <span class="prop-label">Limit Method</span>
          <select class="prop-select" id="mod-bev-limit" style="flex:1;">
            <option value="none" ${limitMethod === 'none' ? 'selected' : ''}>None (All Edges)</option>
            <option value="angle" ${limitMethod === 'angle' ? 'selected' : ''}>Angle</option>
            <option value="weight" ${limitMethod === 'weight' ? 'selected' : ''}>Weight</option>
          </select>
        </div>

        <!-- Angle Threshold (only when Limit Method is Angle) -->
        <div class="prop-row" id="row-bev-angle" style="${limitMethod === 'angle' ? '' : 'display:none;'}">
          <span class="prop-label">Angle Limit</span>
          <div class="prop-slider-wrap">
            <input type="range" class="prop-slider" id="mod-bev-angle" min="1" max="180" step="1" value="${angleLimitDeg}" />
            <span class="prop-slider-val" id="mod-bev-angle-val">${angleLimitDeg}°</span>
          </div>
        </div>

        <!-- Clamp Overlap -->
        <div class="prop-row">
          <span class="prop-label">Clamp Overlap</span>
          <label class="prop-checkbox-wrap">
            <input type="checkbox" class="prop-checkbox" id="mod-bev-clamp" ${clampOverlap ? 'checked' : ''} />
            <span style="font-size: 11px; color: var(--b-text-secondary);">Prevent intersecting bevels</span>
          </label>
        </div>

        <!-- Harden Normals -->
        <div class="prop-row">
          <span class="prop-label">Harden Normals</span>
          <label class="prop-checkbox-wrap">
            <input type="checkbox" class="prop-checkbox" id="mod-bev-harden" ${hardenNormals ? 'checked' : ''} />
            <span style="font-size: 11px; color: var(--b-text-secondary);">Match adjacent flat face normals</span>
          </label>
        </div>
      `;

      const sliderWidth = body.querySelector('#mod-bev-width');
      const valWidth = body.querySelector('#mod-bev-width-val');
      sliderWidth.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        valWidth.textContent = `${val.toFixed(3)}m`;
        onParamChange({ width: val });
      });

      const sliderSeg = body.querySelector('#mod-bev-seg');
      const valSeg = body.querySelector('#mod-bev-seg-val');
      sliderSeg.addEventListener('input', (e) => {
        const val = parseInt(e.target.value, 10);
        valSeg.textContent = val;
        onParamChange({ segments: val });
      });

      const sliderProf = body.querySelector('#mod-bev-prof');
      const valProf = body.querySelector('#mod-bev-prof-val');
      sliderProf.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        valProf.textContent = val.toFixed(2);
        onParamChange({ profile: val });
      });

      const selLimit = body.querySelector('#mod-bev-limit');
      const rowAngle = body.querySelector('#row-bev-angle');
      selLimit.addEventListener('change', (e) => {
        rowAngle.style.display = e.target.value === 'angle' ? '' : 'none';
        onParamChange({ limitMethod: e.target.value });
      });

      const sliderAngle = body.querySelector('#mod-bev-angle');
      const valAngle = body.querySelector('#mod-bev-angle-val');
      sliderAngle.addEventListener('input', (e) => {
        const val = parseInt(e.target.value, 10);
        valAngle.textContent = `${val}°`;
        onParamChange({ angleLimitDeg: val });
      });

      body.querySelector('#mod-bev-clamp').addEventListener('change', (e) => {
        onParamChange({ clampOverlap: e.target.checked });
      });

      body.querySelector('#mod-bev-harden').addEventListener('change', (e) => {
        onParamChange({ hardenNormals: e.target.checked });
      });

    } else if (mod.type === 'solidify') {
      const thickness = mod.params.thickness ?? 0.05;
      const offset = mod.params.offset ?? -1.0;
      const evenThickness = mod.params.evenThickness !== false;
      const fillRim = mod.params.fillRim !== false;
      const onlyRim = !!mod.params.onlyRim;

      body.innerHTML = `
        <div class="prop-row">
          <span class="prop-label">Thickness</span>
          <div class="prop-slider-wrap">
            <input type="range" class="prop-slider" id="mod-sol-thick" min="0.005" max="0.5" step="0.005" value="${thickness}" />
            <span class="prop-slider-val" id="mod-sol-thick-val">${thickness.toFixed(3)}m</span>
          </div>
        </div>
        <div class="prop-row">
          <span class="prop-label">Offset</span>
          <div class="prop-slider-wrap">
            <input type="range" class="prop-slider" id="mod-sol-offset" min="-1" max="1" step="0.1" value="${offset}" />
            <span class="prop-slider-val" id="mod-sol-offset-val">${offset.toFixed(1)}</span>
          </div>
        </div>
        <div class="prop-row">
          <span class="prop-label">Even Thickness</span>
          <label class="prop-checkbox-wrap">
            <input type="checkbox" class="prop-checkbox" id="mod-sol-even" ${evenThickness ? 'checked' : ''} />
            <span style="font-size: 11px; color: var(--b-text-secondary);">Miter corner adjustment</span>
          </label>
        </div>
        <div class="prop-row">
          <span class="prop-label">Rim</span>
          <label class="prop-checkbox-wrap">
            <input type="checkbox" class="prop-checkbox" id="mod-sol-rim" ${fillRim ? 'checked' : ''} />
            <span style="font-size: 11px; color: var(--b-text-secondary);">Fill edge boundaries</span>
          </label>
        </div>
        <div class="prop-row">
          <span class="prop-label">Only Rim</span>
          <label class="prop-checkbox-wrap">
            <input type="checkbox" class="prop-checkbox" id="mod-sol-only-rim" ${onlyRim ? 'checked' : ''} />
            <span style="font-size: 11px; color: var(--b-text-secondary);">Discard shell surfaces</span>
          </label>
        </div>
      `;

      const slThick = body.querySelector('#mod-sol-thick');
      const valThick = body.querySelector('#mod-sol-thick-val');
      slThick.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        valThick.textContent = `${val.toFixed(3)}m`;
        onParamChange({ thickness: val });
      });

      const slOffset = body.querySelector('#mod-sol-offset');
      const valOffset = body.querySelector('#mod-sol-offset-val');
      slOffset.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        valOffset.textContent = val.toFixed(1);
        onParamChange({ offset: val });
      });

      body.querySelector('#mod-sol-even').addEventListener('change', (e) => {
        onParamChange({ evenThickness: e.target.checked });
      });
      body.querySelector('#mod-sol-rim').addEventListener('change', (e) => {
        onParamChange({ fillRim: e.target.checked });
      });
      body.querySelector('#mod-sol-only-rim').addEventListener('change', (e) => {
        onParamChange({ onlyRim: e.target.checked });
      });

    } else if (mod.type === 'displace' || mod.type === 'displacement') {
      const strength = mod.params.strength ?? 0.2;
      const midlevel = mod.params.midlevel ?? 0.5;
      const scale = mod.params.scale ?? 2.0;
      const octaves = mod.params.octaves ?? 3;
      const seed = mod.params.seed ?? 0;
      const direction = mod.params.direction ?? 'normal';

      body.innerHTML = `
        <div class="prop-row">
          <span class="prop-label">Strength</span>
          <div class="prop-slider-wrap">
            <input type="range" class="prop-slider" id="mod-disp-str" min="-1" max="1" step="0.02" value="${strength}" />
            <span class="prop-slider-val" id="mod-disp-str-val">${strength.toFixed(2)}</span>
          </div>
        </div>
        <div class="prop-row">
          <span class="prop-label">Midlevel</span>
          <div class="prop-slider-wrap">
            <input type="range" class="prop-slider" id="mod-disp-mid" min="0" max="1" step="0.05" value="${midlevel}" />
            <span class="prop-slider-val" id="mod-disp-mid-val">${midlevel.toFixed(2)}</span>
          </div>
        </div>
        <div class="prop-row">
          <span class="prop-label">Scale</span>
          <div class="prop-slider-wrap">
            <input type="range" class="prop-slider" id="mod-disp-scale" min="0.5" max="10" step="0.25" value="${scale}" />
            <span class="prop-slider-val" id="mod-disp-scale-val">${scale.toFixed(2)}</span>
          </div>
        </div>
        <div class="prop-row">
          <span class="prop-label">Octaves</span>
          <div class="prop-slider-wrap">
            <input type="range" class="prop-slider" id="mod-disp-oct" min="1" max="6" step="1" value="${octaves}" />
            <span class="prop-slider-val" id="mod-disp-oct-val">${octaves}</span>
          </div>
        </div>
        <div class="prop-row">
          <span class="prop-label">Direction</span>
          <select class="prop-select" id="mod-disp-dir" style="flex:1;">
            <option value="normal" ${direction === 'normal' ? 'selected' : ''}>Normal</option>
            <option value="x" ${direction === 'x' ? 'selected' : ''}>X Axis</option>
            <option value="y" ${direction === 'y' ? 'selected' : ''}>Y Axis</option>
            <option value="z" ${direction === 'z' ? 'selected' : ''}>Z Axis</option>
          </select>
        </div>
        <div class="prop-row">
          <span class="prop-label">Seed</span>
          <div class="prop-slider-wrap">
            <input type="range" class="prop-slider" id="mod-disp-seed" min="0" max="100" step="1" value="${seed}" />
            <span class="prop-slider-val" id="mod-disp-seed-val">${seed}</span>
          </div>
        </div>
      `;

      body.querySelector('#mod-disp-str').addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        body.querySelector('#mod-disp-str-val').textContent = val.toFixed(2);
        onParamChange({ strength: val });
      });
      body.querySelector('#mod-disp-mid').addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        body.querySelector('#mod-disp-mid-val').textContent = val.toFixed(2);
        onParamChange({ midlevel: val });
      });
      body.querySelector('#mod-disp-scale').addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        body.querySelector('#mod-disp-scale-val').textContent = val.toFixed(2);
        onParamChange({ scale: val });
      });
      body.querySelector('#mod-disp-oct').addEventListener('input', (e) => {
        const val = parseInt(e.target.value, 10);
        body.querySelector('#mod-disp-oct-val').textContent = val;
        onParamChange({ octaves: val });
      });
      body.querySelector('#mod-disp-dir').addEventListener('change', (e) => {
        onParamChange({ direction: e.target.value });
      });
      body.querySelector('#mod-disp-seed').addEventListener('input', (e) => {
        const val = parseInt(e.target.value, 10);
        body.querySelector('#mod-disp-seed-val').textContent = val;
        onParamChange({ seed: val });
      });

    } else if (mod.type === 'smooth' || mod.type === 'relax') {
      const factor = mod.params.factor ?? 0.5;
      const iterations = mod.params.iterations ?? 1;
      const pinBoundary = mod.params.pinBoundary !== false;

      body.innerHTML = `
        <div class="prop-row">
          <span class="prop-label">Factor</span>
          <div class="prop-slider-wrap">
            <input type="range" class="prop-slider" id="mod-sm-factor" min="0.05" max="1" step="0.05" value="${factor}" />
            <span class="prop-slider-val" id="mod-sm-factor-val">${factor.toFixed(2)}</span>
          </div>
        </div>
        <div class="prop-row">
          <span class="prop-label">Repeat</span>
          <div class="prop-slider-wrap">
            <input type="range" class="prop-slider" id="mod-sm-iter" min="1" max="10" step="1" value="${iterations}" />
            <span class="prop-slider-val" id="mod-sm-iter-val">${iterations}</span>
          </div>
        </div>
        <div class="prop-row">
          <span class="prop-label">Pin Boundary</span>
          <label class="prop-checkbox-wrap">
            <input type="checkbox" class="prop-checkbox" id="mod-sm-pin" ${pinBoundary ? 'checked' : ''} />
            <span style="font-size: 11px; color: var(--b-text-secondary);">Preserve mesh border edges</span>
          </label>
        </div>
      `;

      body.querySelector('#mod-sm-factor').addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        body.querySelector('#mod-sm-factor-val').textContent = val.toFixed(2);
        onParamChange({ factor: val });
      });
      body.querySelector('#mod-sm-iter').addEventListener('input', (e) => {
        const val = parseInt(e.target.value, 10);
        body.querySelector('#mod-sm-iter-val').textContent = val;
        onParamChange({ iterations: val });
      });
      body.querySelector('#mod-sm-pin').addEventListener('change', (e) => {
        onParamChange({ pinBoundary: e.target.checked });
      });

    } else if (mod.type === 'randomize') {
      const amount = mod.params.amount ?? 0.05;
      const seed = mod.params.seed ?? 42;
      const normalOnly = !!mod.params.normalOnly;

      body.innerHTML = `
        <div class="prop-row">
          <span class="prop-label">Amount</span>
          <div class="prop-slider-wrap">
            <input type="range" class="prop-slider" id="mod-rnd-amt" min="0.005" max="0.3" step="0.005" value="${amount}" />
            <span class="prop-slider-val" id="mod-rnd-amt-val">${amount.toFixed(3)}m</span>
          </div>
        </div>
        <div class="prop-row">
          <span class="prop-label">Normal Only</span>
          <label class="prop-checkbox-wrap">
            <input type="checkbox" class="prop-checkbox" id="mod-rnd-norm" ${normalOnly ? 'checked' : ''} />
            <span style="font-size: 11px; color: var(--b-text-secondary);">Displace along vertex normals</span>
          </label>
        </div>
        <div class="prop-row">
          <span class="prop-label">Seed</span>
          <div class="prop-slider-wrap">
            <input type="range" class="prop-slider" id="mod-rnd-seed" min="0" max="100" step="1" value="${seed}" />
            <span class="prop-slider-val" id="mod-rnd-seed-val">${seed}</span>
          </div>
        </div>
      `;

      body.querySelector('#mod-rnd-amt').addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        body.querySelector('#mod-rnd-amt-val').textContent = `${val.toFixed(3)}m`;
        onParamChange({ amount: val });
      });
      body.querySelector('#mod-rnd-norm').addEventListener('change', (e) => {
        onParamChange({ normalOnly: e.target.checked });
      });
      body.querySelector('#mod-rnd-seed').addEventListener('input', (e) => {
        const val = parseInt(e.target.value, 10);
        body.querySelector('#mod-rnd-seed-val').textContent = val;
        onParamChange({ seed: val });
      });
    } else {
      const modType = (mod.type || '').toLowerCase();
      if (modType === 'boolean' || modType === 'bool') {
        this._renderBooleanModifierControls(body, mod, mesh, onParamChange);
      } else if (modType === 'decimate') {
        this._renderDecimateModifierControls(body, mod, onParamChange);
      } else if (modType === 'screw' || modType === 'lathe') {
        this._renderScrewModifierControls(body, mod, onParamChange);
      } else if (modType === 'weighted_normal' || modType === 'weightednormal') {
        this._renderWeightedNormalModifierControls(body, mod, onParamChange);
      } else {
        this._renderProModifierControls(body, mod, mesh, onParamChange);
      }
    }
  }

  _renderBooleanModifierControls(body, mod, mesh, onParamChange) {
    const p = {
      operation: 'difference',
      operandType: 'primitive',
      targetId: '',
      targetName: '',
      cutterDisplay: 'wire',
      cutterPrimitive: 'box',
      cutterSize: 1.0,
      cutterOffset: { x: 0.45, y: 0.45, z: 0.45 },
      cutterRotation: { x: 0, y: 0, z: 0 },
      ...(mod.params || {})
    };

    const allObjs = typeof this.sceneManager?.getAllObjects === 'function'
      ? this.sceneManager.getAllObjects()
      : Array.from(this.sceneManager?.objects?.values() || []);
    const candidates = allObjs.filter((o) =>
      o && o !== mesh && o.isMesh && !o.userData?.isSystemObject && !o.userData?.isGizmo
    );

    const targetOptions = candidates.map((o) => {
      const id = o.userData?.id || o.uuid;
      const selected = (p.targetId && (p.targetId === id || p.targetId === o.uuid)) ||
        (p.targetName && p.targetName === o.name);
      return `<option value="${escapeHtml(id)}" ${selected ? 'selected' : ''}>${escapeHtml(o.name || id)}</option>`;
    }).join('');

    const isObj = p.operandType === 'object';
    const off = p.cutterOffset || { x: 0.45, y: 0.45, z: 0.45 };
    const rot = p.cutterRotation || { x: 0, y: 0, z: 0 };

    body.innerHTML = `
      <div class="modifier-param-row">
        <span class="modifier-param-label">Operation</span>
        <select class="modifier-select" id="mod-bool-op">
          <option value="difference" ${p.operation === 'difference' || p.operation === 'subtract' ? 'selected' : ''}>Difference</option>
          <option value="union" ${p.operation === 'union' ? 'selected' : ''}>Union</option>
          <option value="intersect" ${p.operation === 'intersect' ? 'selected' : ''}>Intersect</option>
        </select>
      </div>
      <div class="modifier-param-row">
        <span class="modifier-param-label">Operand Type</span>
        <select class="modifier-select" id="mod-bool-operand">
          <option value="object" ${isObj ? 'selected' : ''}>Object (Live Cutter)</option>
          <option value="primitive" ${!isObj ? 'selected' : ''}>Parametric Primitive</option>
        </select>
      </div>
      <div id="mod-bool-object-box" style="display:${isObj ? 'block' : 'none'}">
        <div class="modifier-param-row">
          <span class="modifier-param-label">Cutter Object</span>
          <select class="modifier-select" id="mod-bool-target">
            <option value="">-- Select Cutter Mesh --</option>
            ${targetOptions}
          </select>
        </div>
        <div class="modifier-param-row">
          <span class="modifier-param-label">Cutter Display</span>
          <select class="modifier-select" id="mod-bool-display">
            <option value="wire" ${p.cutterDisplay === 'wire' ? 'selected' : ''}>Wire</option>
            <option value="bounds" ${p.cutterDisplay === 'bounds' ? 'selected' : ''}>Bounds</option>
            <option value="solid" ${p.cutterDisplay === 'solid' ? 'selected' : ''}>Solid</option>
            <option value="hidden" ${p.cutterDisplay === 'hidden' ? 'selected' : ''}>Hidden</option>
          </select>
        </div>
      </div>
      <div id="mod-bool-prim-box" style="display:${!isObj ? 'block' : 'none'}">
        <div class="modifier-param-row">
          <span class="modifier-param-label">Cutter Shape</span>
          <select class="modifier-select" id="mod-bool-prim">
            <option value="box" ${p.cutterPrimitive === 'box' ? 'selected' : ''}>Box</option>
            <option value="cylinder" ${p.cutterPrimitive === 'cylinder' ? 'selected' : ''}>Cylinder</option>
            <option value="sphere" ${p.cutterPrimitive === 'sphere' ? 'selected' : ''}>Sphere</option>
          </select>
        </div>
        <div class="modifier-param-row">
          <span class="modifier-param-label">Cutter Size</span>
          <input type="range" class="modifier-range" id="mod-bool-size" min="0.1" max="5.0" step="0.05" value="${Number(p.cutterSize ?? 1)}">
          <span class="modifier-param-val" id="mod-bool-size-val">${Number(p.cutterSize ?? 1).toFixed(2)}</span>
        </div>
        <div class="modifier-param-row">
          <span class="modifier-param-label">Offset XYZ</span>
          <div style="display:flex;gap:4px;flex:1">
            <input type="number" step="0.05" class="modifier-num-input" id="mod-bool-off-x" value="${Number(off.x ?? 0)}" style="width:100%">
            <input type="number" step="0.05" class="modifier-num-input" id="mod-bool-off-y" value="${Number(off.y ?? 0)}" style="width:100%">
            <input type="number" step="0.05" class="modifier-num-input" id="mod-bool-off-z" value="${Number(off.z ?? 0)}" style="width:100%">
          </div>
        </div>
        <div class="modifier-param-row">
          <span class="modifier-param-label">Rotate Deg</span>
          <div style="display:flex;gap:4px;flex:1">
            <input type="number" step="5" class="modifier-num-input" id="mod-bool-rot-x" value="${Number(rot.x ?? 0)}" style="width:100%">
            <input type="number" step="5" class="modifier-num-input" id="mod-bool-rot-y" value="${Number(rot.y ?? 0)}" style="width:100%">
            <input type="number" step="5" class="modifier-num-input" id="mod-bool-rot-z" value="${Number(rot.z ?? 0)}" style="width:100%">
          </div>
        </div>
      </div>
    `;

    body.querySelector('#mod-bool-op').addEventListener('change', (e) => {
      onParamChange({ operation: e.target.value });
    });

    body.querySelector('#mod-bool-operand').addEventListener('change', (e) => {
      const nextOpType = e.target.value;
      const objBox = body.querySelector('#mod-bool-object-box');
      const primBox = body.querySelector('#mod-bool-prim-box');
      if (objBox) objBox.style.display = nextOpType === 'object' ? 'block' : 'none';
      if (primBox) primBox.style.display = nextOpType === 'object' ? 'none' : 'block';
      onParamChange({ operandType: nextOpType });
    });

    body.querySelector('#mod-bool-target').addEventListener('change', (e) => {
      const id = e.target.value;
      const chosen = candidates.find((o) => (o.userData?.id || o.uuid) === id);
      onParamChange({
        operandType: 'object',
        targetId: id,
        targetName: chosen?.name || ''
      });
    });

    body.querySelector('#mod-bool-display').addEventListener('change', (e) => {
      onParamChange({ cutterDisplay: e.target.value });
    });

    body.querySelector('#mod-bool-prim').addEventListener('change', (e) => {
      onParamChange({ cutterPrimitive: e.target.value });
    });

    body.querySelector('#mod-bool-size').addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      body.querySelector('#mod-bool-size-val').textContent = val.toFixed(2);
      onParamChange({ cutterSize: val });
    });

    const emitVecChange = (prefix, field) => {
      const vx = parseFloat(body.querySelector(`#${prefix}-x`)?.value || 0) || 0;
      const vy = parseFloat(body.querySelector(`#${prefix}-y`)?.value || 0) || 0;
      const vz = parseFloat(body.querySelector(`#${prefix}-z`)?.value || 0) || 0;
      onParamChange({ [field]: { x: vx, y: vy, z: vz } });
    };
    ['x', 'y', 'z'].forEach((ax) => {
      body.querySelector(`#mod-bool-off-${ax}`)?.addEventListener('change', () => emitVecChange('mod-bool-off', 'cutterOffset'));
      body.querySelector(`#mod-bool-rot-${ax}`)?.addEventListener('change', () => emitVecChange('mod-bool-rot', 'cutterRotation'));
    });
  }

  _renderDecimateModifierControls(body, mod, onParamChange) {
    const p = {
      mode: 'collapse',
      ratio: 0.5,
      angleLimit: 5.0,
      iterations: 1,
      ...(mod.params || {})
    };
    const mode = String(p.mode || 'collapse').toLowerCase();

    body.innerHTML = `
      <div class="modifier-param-row">
        <span class="modifier-param-label">Mode</span>
        <select class="modifier-select" id="mod-dec-mode">
          <option value="collapse" ${mode === 'collapse' ? 'selected' : ''}>Collapse</option>
          <option value="planar" ${mode === 'planar' ? 'selected' : ''}>Planar</option>
          <option value="unsubdivide" ${mode === 'unsubdivide' ? 'selected' : ''}>Un-Subdivide</option>
        </select>
      </div>
      <div class="modifier-param-row" id="mod-dec-collapse-row" style="display:${mode === 'collapse' ? 'flex' : 'none'}">
        <span class="modifier-param-label">Ratio</span>
        <input type="range" class="modifier-range" id="mod-dec-ratio" min="0.05" max="1.0" step="0.01" value="${Number(p.ratio ?? 0.5)}">
        <span class="modifier-param-val" id="mod-dec-ratio-val">${Number(p.ratio ?? 0.5).toFixed(2)}</span>
      </div>
      <div class="modifier-param-row" id="mod-dec-planar-row" style="display:${mode === 'planar' ? 'flex' : 'none'}">
        <span class="modifier-param-label">Angle Limit</span>
        <input type="range" class="modifier-range" id="mod-dec-angle" min="0.5" max="45" step="0.5" value="${Number(p.angleLimit ?? 5)}">
        <span class="modifier-param-val" id="mod-dec-angle-val">${Number(p.angleLimit ?? 5).toFixed(1)}°</span>
      </div>
      <div class="modifier-param-row" id="mod-dec-unsub-row" style="display:${mode === 'unsubdivide' ? 'flex' : 'none'}">
        <span class="modifier-param-label">Iterations</span>
        <input type="range" class="modifier-range" id="mod-dec-iter" min="1" max="5" step="1" value="${Number(p.iterations ?? 1)}">
        <span class="modifier-param-val" id="mod-dec-iter-val">${Number(p.iterations ?? 1)}</span>
      </div>
    `;

    body.querySelector('#mod-dec-mode').addEventListener('change', (e) => {
      const m = e.target.value;
      body.querySelector('#mod-dec-collapse-row').style.display = m === 'collapse' ? 'flex' : 'none';
      body.querySelector('#mod-dec-planar-row').style.display = m === 'planar' ? 'flex' : 'none';
      body.querySelector('#mod-dec-unsub-row').style.display = m === 'unsubdivide' ? 'flex' : 'none';
      onParamChange({ mode: m });
    });

    body.querySelector('#mod-dec-ratio').addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      body.querySelector('#mod-dec-ratio-val').textContent = val.toFixed(2);
      onParamChange({ ratio: val });
    });

    body.querySelector('#mod-dec-angle').addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      body.querySelector('#mod-dec-angle-val').textContent = `${val.toFixed(1)}°`;
      onParamChange({ angleLimit: val });
    });

    body.querySelector('#mod-dec-iter').addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      body.querySelector('#mod-dec-iter-val').textContent = val;
      onParamChange({ iterations: val });
    });
  }

  _renderScrewModifierControls(body, mod, onParamChange) {
    const p = {
      axis: 'Y',
      angleDeg: 360,
      steps: 16,
      screwOffset: 0.0,
      radiusOffset: 0.5,
      iterations: 1,
      flipNormals: false,
      ...(mod.params || {})
    };
    const axis = String(p.axis || 'Y').toUpperCase();

    body.innerHTML = `
      <div class="modifier-param-row">
        <span class="modifier-param-label">Axis</span>
        <select class="modifier-select" id="mod-screw-axis">
          <option value="Y" ${axis === 'Y' ? 'selected' : ''}>Y Axis</option>
          <option value="Z" ${axis === 'Z' ? 'selected' : ''}>Z Axis</option>
          <option value="X" ${axis === 'X' ? 'selected' : ''}>X Axis</option>
        </select>
      </div>
      <div class="modifier-param-row">
        <span class="modifier-param-label">Angle</span>
        <input type="range" class="modifier-range" id="mod-screw-angle" min="15" max="360" step="5" value="${Number(p.angleDeg ?? 360)}">
        <span class="modifier-param-val" id="mod-screw-angle-val">${Number(p.angleDeg ?? 360)}°</span>
      </div>
      <div class="modifier-param-row">
        <span class="modifier-param-label">Steps</span>
        <input type="range" class="modifier-range" id="mod-screw-steps" min="4" max="64" step="1" value="${Number(p.steps ?? 16)}">
        <span class="modifier-param-val" id="mod-screw-steps-val">${Number(p.steps ?? 16)}</span>
      </div>
      <div class="modifier-param-row">
        <span class="modifier-param-label">Screw Offset</span>
        <input type="range" class="modifier-range" id="mod-screw-offset" min="-5" max="5" step="0.05" value="${Number(p.screwOffset ?? 0)}">
        <span class="modifier-param-val" id="mod-screw-offset-val">${Number(p.screwOffset ?? 0).toFixed(2)}</span>
      </div>
      <div class="modifier-param-row">
        <span class="modifier-param-label">Radial Offset</span>
        <input type="range" class="modifier-range" id="mod-screw-radius" min="0" max="3" step="0.05" value="${Number(p.radiusOffset ?? 0.5)}">
        <span class="modifier-param-val" id="mod-screw-radius-val">${Number(p.radiusOffset ?? 0.5).toFixed(2)}</span>
      </div>
      <div class="modifier-param-row">
        <span class="modifier-param-label">Iterations</span>
        <input type="range" class="modifier-range" id="mod-screw-iter" min="1" max="8" step="1" value="${Number(p.iterations ?? 1)}">
        <span class="modifier-param-val" id="mod-screw-iter-val">${Number(p.iterations ?? 1)}</span>
      </div>
      <label class="modifier-check-row">
        <input type="checkbox" id="mod-screw-flip" ${p.flipNormals ? 'checked' : ''}>
        <span>Flip Normals</span>
      </label>
    `;

    body.querySelector('#mod-screw-axis').addEventListener('change', (e) => onParamChange({ axis: e.target.value }));
    body.querySelector('#mod-screw-angle').addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      body.querySelector('#mod-screw-angle-val').textContent = `${val}°`;
      onParamChange({ angleDeg: val });
    });
    body.querySelector('#mod-screw-steps').addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      body.querySelector('#mod-screw-steps-val').textContent = val;
      onParamChange({ steps: val });
    });
    body.querySelector('#mod-screw-offset').addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      body.querySelector('#mod-screw-offset-val').textContent = val.toFixed(2);
      onParamChange({ screwOffset: val });
    });
    body.querySelector('#mod-screw-radius').addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      body.querySelector('#mod-screw-radius-val').textContent = val.toFixed(2);
      onParamChange({ radiusOffset: val });
    });
    body.querySelector('#mod-screw-iter').addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      body.querySelector('#mod-screw-iter-val').textContent = val;
      onParamChange({ iterations: val });
    });
    body.querySelector('#mod-screw-flip').addEventListener('change', (e) => {
      onParamChange({ flipNormals: Boolean(e.target.checked) });
    });
  }

  _renderWeightedNormalModifierControls(body, mod, onParamChange) {
    const p = {
      mode: 'face_area_and_angle',
      weight: 50,
      keepSharp: true,
      thresholdDeg: 45,
      ...(mod.params || {})
    };

    body.innerHTML = `
      <div class="modifier-param-row">
        <span class="modifier-param-label">Weighting Mode</span>
        <select class="modifier-select" id="mod-wn-mode">
          <option value="face_area_and_angle" ${p.mode === 'face_area_and_angle' ? 'selected' : ''}>Face Area &amp; Angle</option>
          <option value="face_area" ${p.mode === 'face_area' ? 'selected' : ''}>Face Area</option>
          <option value="corner_angle" ${p.mode === 'corner_angle' ? 'selected' : ''}>Corner Angle</option>
        </select>
      </div>
      <div class="modifier-param-row">
        <span class="modifier-param-label">Weight</span>
        <input type="range" class="modifier-range" id="mod-wn-weight" min="1" max="100" step="1" value="${Number(p.weight ?? 50)}">
        <span class="modifier-param-val" id="mod-wn-weight-val">${Number(p.weight ?? 50)}</span>
      </div>
      <div class="modifier-param-row">
        <span class="modifier-param-label">Sharp Threshold</span>
        <input type="range" class="modifier-range" id="mod-wn-thresh" min="0" max="89" step="1" value="${Number(p.thresholdDeg ?? 45)}">
        <span class="modifier-param-val" id="mod-wn-thresh-val">${Number(p.thresholdDeg ?? 45)}°</span>
      </div>
      <label class="modifier-check-row">
        <input type="checkbox" id="mod-wn-keepsharp" ${p.keepSharp !== false ? 'checked' : ''}>
        <span>Keep Sharp Edges</span>
      </label>
    `;

    body.querySelector('#mod-wn-mode').addEventListener('change', (e) => onParamChange({ mode: e.target.value }));
    body.querySelector('#mod-wn-weight').addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      body.querySelector('#mod-wn-weight-val').textContent = val;
      onParamChange({ weight: val });
    });
    body.querySelector('#mod-wn-thresh').addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      body.querySelector('#mod-wn-thresh-val').textContent = `${val}°`;
      onParamChange({ thresholdDeg: val });
    });
    body.querySelector('#mod-wn-keepsharp').addEventListener('change', (e) => {
      onParamChange({ keepSharp: Boolean(e.target.checked) });
    });
  }

  _renderProModifierControls(body, mod, hostMesh, onParamChange) {
    const p = { ...(mod.params || {}) };
    const t = (mod.type || '').toLowerCase();
    const allObjs = typeof this.sceneManager?.getAllObjects === 'function'
      ? this.sceneManager.getAllObjects()
      : Array.from(this.sceneManager?.objects?.values() || []);
    const targetCandidates = allObjs.filter((o) =>
      o && o !== hostMesh && o.isMesh && !o.userData?.isHelper && !o.userData?.isSystemObject
    );

    const addSelectRow = (label, key, opts) => {
      const row = document.createElement('div');
      row.className = 'modifier-param-row';
      row.innerHTML = `<span class="modifier-param-label">${label}</span><select class="modifier-select">${opts.map(([val, text]) => `<option value="${val}" ${String(p[key]) === String(val) ? 'selected' : ''}>${text}</option>`).join('')}</select>`;
      row.querySelector('select').addEventListener('change', (e) => onParamChange({ [key]: e.target.value }));
      body.appendChild(row);
    };

    const addRangeRow = (label, key, min, max, step, suf = '') => {
      const val = Number(p[key] ?? min);
      const row = document.createElement('div');
      row.className = 'modifier-param-row';
      row.innerHTML = `<span class="modifier-param-label">${label}</span><input type="range" class="modifier-range" min="${min}" max="${max}" step="${step}" value="${val}"><span class="modifier-param-val">${val}${suf}</span>`;
      const inp = row.querySelector('input');
      const disp = row.querySelector('.modifier-param-val');
      inp.addEventListener('input', (e) => {
        const next = step >= 1 ? parseInt(e.target.value, 10) : parseFloat(e.target.value);
        disp.textContent = `${next}${suf}`;
        onParamChange({ [key]: next });
      });
      body.appendChild(row);
    };

    const addCheckRow = (label, key) => {
      const row = document.createElement('label');
      row.className = 'modifier-check-row';
      row.innerHTML = `<input type="checkbox" ${p[key] ? 'checked' : ''}><span>${escapeHtml(label)}</span>`;
      row.querySelector('input').addEventListener('change', (e) => onParamChange({ [key]: Boolean(e.target.checked) }));
      body.appendChild(row);
    };

    const addTargetPicker = (filterFn = () => true) => {
      const list = targetCandidates.filter(filterFn);
      const row = document.createElement('div');
      row.className = 'modifier-param-row';
      row.innerHTML = `<span class="modifier-param-label">Target</span><select class="modifier-select"><option value="">-- Pick Object --</option>${list.map((o) => {
        const id = o.userData?.id || o.uuid;
        return `<option value="${escapeHtml(id)}" ${(p.targetId === id || p.targetName === o.name) ? 'selected' : ''}>${escapeHtml(o.name || id)}</option>`;
      }).join('')}</select>`;
      row.querySelector('select').addEventListener('change', (e) => {
        const id = e.target.value;
        const chosen = list.find((o) => (o.userData?.id || o.uuid) === id);
        onParamChange({ targetId: id, targetName: chosen?.name || '' });
      });
      body.appendChild(row);
    };

    body.innerHTML = '';
    if (t === 'shrinkwrap') {
      addTargetPicker();
      addSelectRow('Wrap Mode', 'mode', [['nearest_surface', 'Nearest Surface'], ['project_normal', 'Project Normal'], ['project_axis', 'Project Axis']]);
      addRangeRow('Offset', 'offset', -0.5, 0.5, 0.01, 'm');
    } else if (t === 'curve') {
      addTargetPicker((o) => Boolean(o.userData?.curveData));
      addSelectRow('Deform Axis', 'deformAxis', [['x', 'X'], ['y', 'Y'], ['z', 'Z']]);
      addCheckRow('Stretch to Curve Bounds', 'stretch');
    } else if (t === 'lattice') {
      addSelectRow('Deform Preset', 'preset', [['taper_top', 'Taper Top'], ['shear_x', 'Shear X'], ['arch_y', 'Arch Y'], ['none', 'Neutral Cage']]);
      addRangeRow('Strength', 'strength', -1.5, 1.5, 0.05);
      addRangeRow('Res U', 'resU', 2, 5, 1);
      addRangeRow('Res V', 'resV', 2, 5, 1);
    } else if (t === 'skin') {
      addRangeRow('Thickness', 'thickness', 0.02, 0.8, 0.01, 'm');
      addRangeRow('Radial Segs', 'radialSegments', 4, 16, 1);
    } else if (t === 'remesh') {
      addSelectRow('Mode', 'mode', [['voxel', 'Voxel (Surface-Nets)'], ['blocks', 'Blocks (Minecraft)'], ['sharp', 'Sharp Voxel']]);
      addRangeRow('Voxel Size', 'voxelSize', 0.03, 0.8, 0.01, 'm');
      addRangeRow('Smooth Iter', 'smoothIterations', 0, 6, 1);
    } else if (t === 'weld') {
      addRangeRow('Distance', 'distance', 0.0005, 0.25, 0.001, 'm');
    } else if (t === 'simple_deform' || t === 'simpledeform') {
      addSelectRow('Mode', 'mode', [['twist', 'Twist'], ['bend', 'Bend'], ['taper', 'Taper'], ['stretch', 'Stretch']]);
      addSelectRow('Axis', 'axis', [['x', 'X'], ['y', 'Y'], ['z', 'Z']]);
      addRangeRow('Angle', 'angleDeg', -360, 360, 5, '°');
      addRangeRow('Factor', 'factor', -1.5, 2.0, 0.05);
    } else if (t === 'cast') {
      addSelectRow('Shape', 'shape', [['sphere', 'Sphere'], ['cylinder', 'Cylinder'], ['cuboid', 'Cuboid']]);
      addRangeRow('Factor', 'factor', 0.0, 1.5, 0.05);
      addRangeRow('Radius (0=Auto)', 'radius', 0.0, 5.0, 0.05, 'm');
    } else if (t === 'wave') {
      addRangeRow('Height', 'height', -1.0, 1.0, 0.02, 'm');
      addRangeRow('Width', 'width', 0.2, 4.0, 0.05, 'm');
      addRangeRow('Phase', 'phase', -6.28, 6.28, 0.1);
      addCheckRow('Motion X', 'motionX');
      addCheckRow('Motion Z', 'motionZ');
    } else if (t === 'data_transfer' || t === 'datatransfer') {
      addTargetPicker();
      addCheckRow('Transfer Normals', 'transferNormals');
      addCheckRow('Transfer UVs', 'transferUVs');
      addCheckRow('Transfer Vertex Colors', 'transferColors');
      addRangeRow('Mix Factor', 'mixFactor', 0.0, 1.0, 0.05);
    } else if (t === 'multires') {
      addRangeRow('Levels Viewport', 'levels', 0, 4, 1);
      addRangeRow('Render', 'renderLevels', 0, 4, 1);
    }
  }

  renderCurveSection() {
    const obj = this.targetObject;
    const c = obj?.userData?.curveData;
    if (!c) return;
    const isText = c.kind === 'text';
    const card = this.createCard(isText ? '3D Text Properties' : 'Curve / Spline Properties', true);
    const addPropertyRow = (label, input, valueId) => {
      const row = document.createElement('div');
      row.className = 'prop-row';

      const labelEl = document.createElement('span');
      labelEl.className = 'prop-label';
      labelEl.textContent = label;
      row.appendChild(labelEl);

      if (input.type === 'text') {
        Object.assign(input.style, {
          flex: '1',
          background: 'var(--b-bg-input)',
          color: 'var(--b-text-primary)',
          border: '1px solid var(--b-border-dark)',
          borderRadius: '3px',
          padding: '2px 5px',
          fontSize: '11px',
        });
      } else {
        input.classList.add('prop-slider');
        const value = document.createElement('span');
        value.className = 'prop-slider-val';
        value.id = valueId;
        value.textContent = input.value;
        row.appendChild(value);
      }
      row.appendChild(input);
      card.body.appendChild(row);
    };

    const addRange = (id, label, value, min, max, step) => {
      const input = document.createElement('input');
      input.type = 'range';
      input.id = id;
      input.min = String(min);
      input.max = String(max);
      input.step = String(step);
      input.value = String(value);
      addPropertyRow(label, input, `${id}-val`);
      return input;
    };

    if (isText) {
      const textInput = document.createElement('input');
      textInput.type = 'text';
      textInput.id = 'curv-text-val';
      textInput.value = String(c.text || '');
      addPropertyRow('Text', textInput);
      addRange('curv-text-depth', 'Extrude', c.depth ?? 0.16, 0.02, 1.0, 0.02);
      addRange('curv-text-size', 'Size', c.size ?? 0.8, 0.2, 2.5, 0.05);
    } else {
      addRange('curv-bevel-depth', 'Bevel Depth', c.bevelDepth ?? 0.06, 0.01, 0.4, 0.01);
      addRange('curv-resolution', 'Resolution', c.resolution ?? 16, 4, 32, 1);
      const closedRow = document.createElement('label');
      closedRow.className = 'prop-checkbox-wrap';
      closedRow.style.marginTop = '4px';
      const closedInput = document.createElement('input');
      closedInput.type = 'checkbox';
      closedInput.id = 'curv-closed';
      closedInput.checked = Boolean(c.closed);
      const closedLabel = document.createElement('span');
      closedLabel.textContent = 'Cyclic (Closed)';
      closedRow.append(closedInput, closedLabel);
      card.body.appendChild(closedRow);
    }

    const convertButton = document.createElement('button');
    convertButton.type = 'button';
    convertButton.id = 'btn-curve-to-mesh';
    convertButton.className = 'edit-action-btn';
    convertButton.style.width = '100%';
    convertButton.style.marginTop = '6px';
    convertButton.textContent = 'Convert to Editable Mesh (Alt+C)';
    card.body.appendChild(convertButton);

    if (isText) {
      card.body.querySelector('#curv-text-val')?.addEventListener('change', (e) => {
        rebuildCurveMesh(obj, { text: e.target.value });
        this.sceneManager?.requestRender?.();
      });
      card.body.querySelector('#curv-text-depth')?.addEventListener('input', (e) => {
        const value = Number.parseFloat(e.target.value);
        if (!Number.isFinite(value)) return;
        rebuildCurveMesh(obj, { depth: value });
        const display = card.body.querySelector('#curv-text-depth-val');
        if (display) display.textContent = e.target.value;
        this.sceneManager?.requestRender?.();
      });
      card.body.querySelector('#curv-text-size')?.addEventListener('input', (e) => {
        const value = Number.parseFloat(e.target.value);
        if (!Number.isFinite(value)) return;
        rebuildCurveMesh(obj, { size: value });
        const display = card.body.querySelector('#curv-text-size-val');
        if (display) display.textContent = e.target.value;
        this.sceneManager?.requestRender?.();
      });
    } else {
      card.body.querySelector('#curv-bevel-depth')?.addEventListener('input', (e) => {
        const value = Number.parseFloat(e.target.value);
        if (!Number.isFinite(value)) return;
        rebuildCurveMesh(obj, { bevelDepth: value });
        const display = card.body.querySelector('#curv-bevel-depth-val');
        if (display) display.textContent = e.target.value;
        this.sceneManager?.requestRender?.();
      });
      card.body.querySelector('#curv-resolution')?.addEventListener('input', (e) => {
        const value = Number.parseInt(e.target.value, 10);
        if (!Number.isFinite(value)) return;
        rebuildCurveMesh(obj, { resolution: value });
        const display = card.body.querySelector('#curv-resolution-val');
        if (display) display.textContent = e.target.value;
        this.sceneManager?.requestRender?.();
      });
      card.body.querySelector('#curv-closed')?.addEventListener('change', (e) => {
        rebuildCurveMesh(obj, { closed: Boolean(e.target.checked) });
        this.sceneManager?.requestRender?.();
      });
    }
    card.body.querySelector('#btn-curve-to-mesh')?.addEventListener('click', () => {
      convertCurveToMesh(obj, this.sceneManager);
      this.render();
    });
    this.contentBody.appendChild(card.card);
  }

  renderPerformanceLodScatterSection() {
    const obj = this.targetObject;
    if (!obj) return;
    const lodMgr = typeof window !== 'undefined' ? (window.lodManager || window.engine?.lodManager) : null;
    const instSys = typeof window !== 'undefined' ? (window.instancingSystem || window.engine?.instancingSystem) : null;
    const isScatter = Boolean(obj.userData?.isScatterGroup);

    const card = this.createCard(
      isScatter ? '🌿 GPU Scatter Group & Foliage Brush' : '⚡ Performance, Auto-LOD & GPU Scatter',
      isScatter
    );

    if (isScatter) {
      const spec = obj.userData.scatterSpec || {};
      const total = Number(obj.userData.instanceCount ?? 0);
      const [c0, c1, c2] = obj.userData._activeTierCounts || [total, 0, 0];
      const d1 = spec.lodDistances?.[1] ?? 18;
      const d2 = spec.lodDistances?.[2] ?? 42;
      const maxD = spec.maxDistance ?? 140;
      const brushActive = Boolean(instSys?.brushState?.active && instSys?.brushState?.group === obj);
      const brushMode = instSys?.brushState?.mode || 'paint';
      const brushRadius = instSys?.brushState?.radius ?? 1.4;

      card.body.innerHTML = `
        <div style="font-size:11px; color:var(--b-text-secondary); margin-bottom:8px; display:flex; justify-content:space-between;">
          <span>Total GPU Instances: <strong style="color:#55efc4;">${total.toLocaleString()}</strong></span>
          <span>LOD0: ${c0} · LOD1: ${c1} · LOD2: ${c2}</span>
        </div>
        <div class="prop-row" style="margin-bottom:6px;">
          <span class="prop-label">Wind Sway (GPU)</span>
          <input type="checkbox" id="insp-scatter-wind" ${spec.windSway ? 'checked' : ''} style="cursor:pointer;" />
        </div>
        <div class="prop-row" style="margin-bottom:6px;">
          <span class="prop-label">LOD1 / LOD2 (m)</span>
          <div style="display:flex; gap:4px; flex:1;">
            <input type="number" id="insp-scatter-d1" value="${d1}" min="1" max="500" step="1" style="width:50%; background:var(--b-bg-input); color:var(--b-text-primary); border:1px solid var(--b-border-dark); border-radius:3px; padding:2px 4px; font-size:11px;" />
            <input type="number" id="insp-scatter-d2" value="${d2}" min="2" max="800" step="1" style="width:50%; background:var(--b-bg-input); color:var(--b-text-primary); border:1px solid var(--b-border-dark); border-radius:3px; padding:2px 4px; font-size:11px;" />
          </div>
        </div>
        <div class="prop-row" style="margin-bottom:8px;">
          <span class="prop-label">Max Cull Dist</span>
          <input type="number" id="insp-scatter-maxd" value="${maxD}" min="10" max="2000" step="5" style="flex:1; background:var(--b-bg-input); color:var(--b-text-primary); border:1px solid var(--b-border-dark); border-radius:3px; padding:2px 6px; font-size:11px;" />
        </div>
        <div style="padding:7px; background:rgba(85,239,196,0.06); border:1px solid rgba(85,239,196,0.24); border-radius:4px; margin-bottom:6px;">
          <div style="font-size:10px; font-weight:600; color:#55efc4; margin-bottom:5px;">🖌️ FOLIAGE PAINT / ERASE BRUSH (Shift = Erase)</div>
          <div style="display:grid; grid-template-columns:1fr 1fr; gap:5px; margin-bottom:6px;">
            <button class="blender-btn" id="btn-insp-foliage-paint" style="padding:4px 6px; font-size:11px; background:${brushActive && brushMode === 'paint' ? '#00b894' : 'var(--b-bg-input)'}; color:${brushActive && brushMode === 'paint' ? '#081512' : 'var(--b-text-primary)'}; border:1px solid var(--b-border-dark); border-radius:3px; cursor:pointer; font-weight:600;">
              ${brushActive && brushMode === 'paint' ? '⏹ Stop Paint' : '🖌️ Paint Brush'}
            </button>
            <button class="blender-btn" id="btn-insp-foliage-erase" style="padding:4px 6px; font-size:11px; background:${brushActive && brushMode === 'erase' ? '#e17055' : 'var(--b-bg-input)'}; color:${brushActive && brushMode === 'erase' ? '#fff' : 'var(--b-text-primary)'}; border:1px solid var(--b-border-dark); border-radius:3px; cursor:pointer; font-weight:600;">
              ${brushActive && brushMode === 'erase' ? '⏹ Stop Erase' : '🧹 Erase Brush'}
            </button>
          </div>
          <div class="prop-row">
            <span class="prop-label">Brush Radius</span>
            <div style="flex:1; display:flex; align-items:center; gap:6px;">
              <input type="range" id="insp-foliage-radius" min="0.2" max="6.0" step="0.1" value="${brushRadius}" style="flex:1;" />
              <span id="insp-foliage-radius-val" style="width:32px; text-align:right; font-size:10px;">${Number(brushRadius).toFixed(1)}m</span>
            </div>
          </div>
        </div>
      `;

      card.body.querySelector('#insp-scatter-wind')?.addEventListener('change', (e) => {
        instSys?.setGroupWindSway?.(obj, e.target.checked);
      });
      const syncDists = () => {
        const nd1 = Math.max(1, parseFloat(card.body.querySelector('#insp-scatter-d1')?.value) || 18);
        const nd2 = Math.max(nd1 + 1, parseFloat(card.body.querySelector('#insp-scatter-d2')?.value) || 42);
        const nmax = Math.max(nd2 + 2, parseFloat(card.body.querySelector('#insp-scatter-maxd')?.value) || 140);
        obj.userData.scatterSpec.lodDistances = [0, nd1, nd2];
        obj.userData.scatterSpec.maxDistance = nmax;
        obj.userData._lastCullKey = '';
        if (window.engine?.camera) instSys?.updateGroup?.(obj, window.engine.camera, 1.0, true);
        window.engine?.requestRender?.();
      };
      card.body.querySelector('#insp-scatter-d1')?.addEventListener('change', syncDists);
      card.body.querySelector('#insp-scatter-d2')?.addEventListener('change', syncDists);
      card.body.querySelector('#insp-scatter-maxd')?.addEventListener('change', syncDists);

      card.body.querySelector('#btn-insp-foliage-paint')?.addEventListener('click', () => {
        if (!instSys) return;
        if (instSys.brushState.active && instSys.brushState.group === obj && instSys.brushState.mode === 'paint') {
          instSys.stopFoliageBrush();
        } else {
          instSys.startFoliageBrush(obj, null, { mode: 'paint' });
        }
        this.render();
      });
      card.body.querySelector('#btn-insp-foliage-erase')?.addEventListener('click', () => {
        if (!instSys) return;
        if (instSys.brushState.active && instSys.brushState.group === obj && instSys.brushState.mode === 'erase') {
          instSys.stopFoliageBrush();
        } else {
          instSys.startFoliageBrush(obj, null, { mode: 'erase' });
        }
        this.render();
      });
      card.body.querySelector('#insp-foliage-radius')?.addEventListener('input', (e) => {
        const r = parseFloat(e.target.value) || 1.4;
        if (instSys) instSys.brushState.radius = r;
        const lbl = card.body.querySelector('#insp-foliage-radius-val');
        if (lbl) lbl.textContent = `${r.toFixed(1)}m`;
      });

      this.contentBody.appendChild(card.card);
      return;
    }

    // Standard Mesh or Group: Mesh Detail Slider (QEM / Subdiv), 3-Tier Auto-LOD, and Quick Foliage Scatter
    const curFactor = Number(obj.userData?.meshDetailFactor ?? 1.0);
    const curPct = Math.round(Math.min(1.0, curFactor) * 100);
    const autoCfg = obj.userData?.autoLOD;
    const autoOn = Boolean(autoCfg?.enabled);
    let curTris = 0;
    obj.traverse((n) => {
      if (n.isMesh && n.geometry?.attributes?.position) {
        const g = n.geometry;
        curTris += g.index ? Math.floor(g.index.count / 3) : Math.floor(g.attributes.position.count / 3);
      }
    });

    const hasEditableDetailMeshes = Boolean(obj.isMesh || this._collectEditableMeshes(obj).length > 0);
    card.body.innerHTML = `
      ${hasEditableDetailMeshes ? `
      <div class="prop-row" style="margin-bottom:6px;">
        <span class="prop-label" title="Non-destructive Rust WASM QEM mesh simplification (preserves 100% base geometry)">Detail (%)</span>
        <div style="flex:1; display:flex; align-items:center; gap:6px;">
          <input type="range" id="insp-mesh-detail-slider" min="5" max="100" step="5" value="${curPct}" style="flex:1;" />
          <span id="insp-mesh-detail-val" style="width:38px; text-align:right; font-family:monospace; font-size:10px;">${curPct}%</span>
        </div>
      </div>
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; font-size:10px; color:var(--b-text-secondary);">
        <span id="insp-mesh-detail-tris">Active Tris: ${curTris.toLocaleString()}</span>
        <div style="display:flex; gap:4px;">
          <button class="blender-btn" id="btn-insp-detail-reset" style="padding:2px 6px; font-size:10px; background:var(--b-bg-input); border:1px solid var(--b-border-dark); color:var(--b-text-primary); border-radius:3px; cursor:pointer;">100%</button>
          <button class="blender-btn" id="btn-insp-detail-sub1" title="Subdivide +1 (preserves UVs)" style="padding:2px 6px; font-size:10px; background:var(--b-bg-input); border:1px solid var(--b-border-dark); color:var(--b-text-primary); border-radius:3px; cursor:pointer;">+Subdiv</button>
        </div>
      </div>
      ` : ''}

      <div style="padding:7px; background:rgba(0,184,148,0.06); border:1px solid rgba(0,184,148,0.25); border-radius:4px; margin-bottom:8px;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
          <span style="font-size:11px; font-weight:600; color:#55efc4;">⚡ Auto-LOD (3 Tiers · Rust QEM)</span>
          <input type="checkbox" id="insp-autolod-toggle" ${autoOn ? 'checked' : ''} style="cursor:pointer;" />
        </div>
        <div style="font-size:10px; color:var(--b-text-secondary);">
          ${autoOn
            ? `LOD0: ${autoCfg.lod0Tris.toLocaleString()} → LOD1: ${autoCfg.lod1Tris.toLocaleString()} → LOD2: ${autoCfg.lod2Tris.toLocaleString()} tris`
            : 'Automatically lowers distant & Fast-Orbit polygon count'}
        </div>
      </div>

      <div style="padding:7px; background:rgba(255,255,255,0.03); border:1px solid var(--b-border-dark); border-radius:4px;">
        <div style="font-size:10px; font-weight:600; color:var(--b-text-secondary); margin-bottom:6px;">🌿 SCATTER / BATCH GPU INSTANCES:</div>
        <div class="prop-row" style="margin-bottom:5px;">
          <span class="prop-label">Preset</span>
          <select id="insp-scatter-preset" style="flex:1; background:var(--b-bg-input); color:var(--b-text-primary); border:1px solid var(--b-border-dark); border-radius:3px; padding:2px 4px; font-size:11px;">
            <option value="grass">🌿 Grass Tuft (15 tris · Wind)</option>
            <option value="tree">🌲 Stylized Tree (3-LOD · Wind)</option>
            <option value="rock">🪨 Low-Poly Boulder</option>
            <option value="self">📦 Scatter Selected Object</option>
          </select>
        </div>
        <div class="prop-row" style="margin-bottom:6px;">
          <span class="prop-label">Count</span>
          <input type="number" id="insp-scatter-count" value="5000" min="10" max="80000" step="100" style="flex:1; background:var(--b-bg-input); color:var(--b-text-primary); border:1px solid var(--b-border-dark); border-radius:3px; padding:2px 6px; font-size:11px;" />
        </div>
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:5px;">
          <button class="blender-btn" id="btn-insp-run-scatter" style="padding:4px 6px; font-size:10px; background:#00b894; color:#081512; border:none; border-radius:3px; cursor:pointer; font-weight:600;">
            🌿 Scatter on Surface
          </button>
          <button class="blender-btn" id="btn-insp-batch-instances" title="Convert selected meshes into 1 GPU InstancedGroup (Alt+Shift+D)" style="padding:4px 6px; font-size:10px; background:var(--b-bg-input); color:var(--b-text-primary); border:1px solid var(--b-border-dark); border-radius:3px; cursor:pointer;">
            ⚡ Batch Selected
          </button>
        </div>
      </div>
    `;

    card.body.querySelector('#insp-mesh-detail-slider')?.addEventListener('change', async (e) => {
      const pct = Math.max(5, Math.min(100, parseInt(e.target.value, 10) || 100));
      const lbl = card.body.querySelector('#insp-mesh-detail-val');
      if (lbl) lbl.textContent = `${pct}%`;
      if (lodMgr && hasEditableDetailMeshes) {
        const res = await lodMgr.setMeshDetailLevel(obj, pct / 100);
        const triEl = card.body.querySelector('#insp-mesh-detail-tris');
        if (res && triEl) triEl.textContent = `Active Tris: ${res.currentTriangles.toLocaleString()} / ${res.baseTriangles.toLocaleString()}`;
      }
    });
    card.body.querySelector('#insp-mesh-detail-slider')?.addEventListener('input', (e) => {
      const lbl = card.body.querySelector('#insp-mesh-detail-val');
      if (lbl) lbl.textContent = `${e.target.value}%`;
    });
    card.body.querySelector('#btn-insp-detail-reset')?.addEventListener('click', async () => {
      if (lodMgr && hasEditableDetailMeshes) {
        await lodMgr.setMeshDetailLevel(obj, 1.0);
        this.render();
      }
    });
    card.body.querySelector('#btn-insp-detail-sub1')?.addEventListener('click', async () => {
      if (lodMgr && hasEditableDetailMeshes) {
        await lodMgr.setMeshDetailLevel(obj, 2.0);
        this.render();
      }
    });

    card.body.querySelector('#insp-autolod-toggle')?.addEventListener('change', async (e) => {
      if (!lodMgr) return;
      if (e.target.checked) {
        await lodMgr.enableAutoLOD(obj);
      } else {
        lodMgr.disableAutoLOD(obj);
      }
      this.render();
    });

    card.body.querySelector('#btn-insp-run-scatter')?.addEventListener('click', async () => {
      if (!instSys) return;
      const presetVal = card.body.querySelector('#insp-scatter-preset')?.value || 'grass';
      const countVal = Math.max(1, parseInt(card.body.querySelector('#insp-scatter-count')?.value, 10) || 2000);
      const source = presetVal === 'self' ? obj : presetVal;
      const surface = (presetVal !== 'self' && obj.isMesh) ? obj : null;
      const grp = await instSys.scatterOnSurface(source, surface, {
        count: countVal,
        sceneManager: this.sceneManager,
      });
      if (grp) {
        window.outliner?.render?.();
        this.setTargetObject(grp);
      }
    });

    card.body.querySelector('#btn-insp-batch-instances')?.addEventListener('click', async () => {
      if (!instSys) return;
      const selected = this.sceneManager?.getSelectedObjects?.() || [obj];
      const grp = await instSys.batchMeshesToInstanceGroup(selected, { sceneManager: this.sceneManager });
      if (grp) {
        window.outliner?.render?.();
        this.setTargetObject(grp);
      }
    });

    this.contentBody.appendChild(card.card);
  }

  renderWorldSection() {
    const env = typeof window !== 'undefined' ? window.environmentStudio : null;
    const engine = this.engine || (typeof window !== 'undefined' ? window.engine : null) || this.sceneManager?.engine || null;
    const scene = engine?.scene || this.sceneManager?.scene || null;
    const card = this.createCard('World Background & Lighting', true);

    const bgHex = scene?.background?.isColor
      ? `#${scene.background.getHexString()}`
      : (env?.skyBgColor || '#282828');
    const hdriEnabled = Boolean(env?.hdriEnabled);
    const hdriPreset = env?.currentHdriPreset || 'studio-softbox';
    const envIntensity = Number(env?.envIntensity ?? scene?.environmentIntensity ?? 1.0);
    const envRotDeg = Math.round(THREE.MathUtils.radToDeg(env?.envRotationRad ?? 0));
    const fogEnabled = Boolean(env?.fogEnabled);
    const fogDensity = Number(env?.fogDensity ?? 0.025);
    const skyEnabled = Boolean(env?.skyEnabled);
    const exposure = Number(engine?.renderer?.toneMappingExposure ?? 1.0);

    const presets = env?.getAvailableHdriPresets?.() || [
      { key: 'studio-softbox', label: 'Studio Softbox' },
      { key: 'golden-sunset', label: 'Golden Sunset' },
      { key: 'cyberpunk-neon', label: 'Cyberpunk Neon' },
      { key: 'industrial-warehouse', label: 'Industrial Warehouse' },
    ];

    card.body.innerHTML = `
      <div class="prop-row">
        <span class="prop-label">Background</span>
        <div class="prop-color-wrap">
          <input type="color" class="prop-color-input" id="world-bg-color" value="${bgHex}" />
          <span class="prop-color-hex" id="world-bg-hex">${bgHex.toUpperCase()}</span>
        </div>
      </div>
      <div class="prop-row">
        <span class="prop-label">HDRI / IBL</span>
        <label class="prop-checkbox-wrap" style="font-size:11px; flex:1;">
          <input type="checkbox" class="prop-checkbox" id="world-hdri-enable" ${hdriEnabled ? 'checked' : ''} />
          Enable HDRI Environment
        </label>
      </div>
      <div class="prop-row">
        <span class="prop-label">HDRI Preset</span>
        <select id="world-hdri-preset" style="flex:1; background: var(--b-bg-input); color: var(--b-text-primary); border: 1px solid var(--b-border-dark); padding: 2px 6px; font-size: 11px; border-radius: 3px;">
          ${presets.map((p) => `<option value="${escapeHtml(p.key)}" ${p.key === hdriPreset ? 'selected' : ''}>${escapeHtml(p.label)}</option>`).join('')}
        </select>
      </div>
      <div class="prop-row">
        <span class="prop-label">Strength</span>
        <div class="prop-slider-wrap">
          <input type="range" class="prop-slider" id="world-env-intensity" min="0" max="5" step="0.05" value="${envIntensity.toFixed(2)}" />
          <span class="prop-slider-val" id="world-env-intensity-val">${envIntensity.toFixed(2)}</span>
        </div>
      </div>
      <div class="prop-row">
        <span class="prop-label">Rotation</span>
        <div class="prop-slider-wrap">
          <input type="range" class="prop-slider" id="world-env-rotation" min="-180" max="180" step="1" value="${envRotDeg}" />
          <span class="prop-slider-val" id="world-env-rotation-val">${envRotDeg}°</span>
        </div>
      </div>
      <div class="prop-row">
        <span class="prop-label">Sky Dome</span>
        <label class="prop-checkbox-wrap" style="font-size:11px; flex:1;">
          <input type="checkbox" class="prop-checkbox" id="world-sky-enable" ${skyEnabled ? 'checked' : ''} />
          Procedural Sky
        </label>
      </div>
      <div class="prop-row">
        <span class="prop-label">Atmos Fog</span>
        <div style="display:flex; align-items:center; gap:6px; flex:1;">
          <input type="checkbox" class="prop-checkbox" id="world-fog-enable" ${fogEnabled ? 'checked' : ''} />
          <input type="range" class="prop-slider" id="world-fog-density" min="0.002" max="0.15" step="0.002" value="${fogDensity.toFixed(3)}" style="flex:1;" />
        </div>
      </div>
      <div class="prop-row">
        <span class="prop-label">Exposure</span>
        <div class="prop-slider-wrap">
          <input type="range" class="prop-slider" id="world-exposure" min="0.2" max="3.0" step="0.05" value="${exposure.toFixed(2)}" />
          <span class="prop-slider-val" id="world-exposure-val">${exposure.toFixed(2)}</span>
        </div>
      </div>
    `;
    this.contentBody.appendChild(card.card);

    card.body.querySelector('#world-bg-color')?.addEventListener('input', (e) => {
      const hex = e.target.value;
      const hexLabel = card.body.querySelector('#world-bg-hex');
      if (hexLabel) hexLabel.textContent = hex.toUpperCase();
      if (env?.toggleHdriBackground) env.toggleHdriBackground(false);
      if (scene) scene.background = new THREE.Color(hex);
      engine?.requestRender?.();
    });

    card.body.querySelector('#world-hdri-enable')?.addEventListener('change', (e) => {
      env?.enableHdri?.(e.target.checked);
      engine?.requestRender?.();
    });

    card.body.querySelector('#world-hdri-preset')?.addEventListener('change', (e) => {
      if (env) {
        if (!env.hdriEnabled) env.enableHdri?.(true);
        env.setHdriPreset?.(e.target.value);
      }
      engine?.requestRender?.();
    });

    card.body.querySelector('#world-env-intensity')?.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      if (!Number.isFinite(val)) return;
      const span = card.body.querySelector('#world-env-intensity-val');
      if (span) span.textContent = val.toFixed(2);
      if (env?.setEnvironmentIntensity) env.setEnvironmentIntensity(val);
      else if (scene) scene.environmentIntensity = val;
      engine?.requestRender?.();
    });

    card.body.querySelector('#world-env-rotation')?.addEventListener('input', (e) => {
      const deg = parseFloat(e.target.value);
      if (!Number.isFinite(deg)) return;
      const span = card.body.querySelector('#world-env-rotation-val');
      if (span) span.textContent = `${deg}°`;
      env?.setEnvironmentRotation?.(deg);
      engine?.requestRender?.();
    });

    card.body.querySelector('#world-sky-enable')?.addEventListener('change', (e) => {
      env?.enableSky?.(e.target.checked);
      engine?.requestRender?.();
    });

    card.body.querySelector('#world-fog-enable')?.addEventListener('change', (e) => {
      const d = parseFloat(card.body.querySelector('#world-fog-density')?.value || '0.025');
      env?.enableFog?.(e.target.checked, { density: d });
      engine?.requestRender?.();
    });

    card.body.querySelector('#world-fog-density')?.addEventListener('input', (e) => {
      const d = parseFloat(e.target.value);
      if (env && Number.isFinite(d)) {
        if (!env.fogEnabled) env.enableFog?.(true, { density: d });
        else env.updateFog?.({ density: d });
      }
      engine?.requestRender?.();
    });

    card.body.querySelector('#world-exposure')?.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      if (!Number.isFinite(val)) return;
      const span = card.body.querySelector('#world-exposure-val');
      if (span) span.textContent = val.toFixed(2);
      if (engine?.renderer) engine.renderer.toneMappingExposure = val;
      engine?.requestRender?.();
    });
  }

  createCard(title, defaultOpen = true) {
    const card = document.createElement('div');
    card.className = `prop-card ${defaultOpen ? '' : 'collapsed'}`;

    const header = document.createElement('div');
    header.className = 'prop-card-header';
    header.innerHTML = `
      <div class="prop-card-title">
        <span class="prop-card-arrow">&#9662;</span>
        <span>${title}</span>
      </div>
    `;

    const body = document.createElement('div');
    body.className = 'prop-card-body';

    header.addEventListener('click', () => {
      card.classList.toggle('collapsed');
    });

    card.appendChild(header);
    card.appendChild(body);

    return { card, header, body };
  }
}
