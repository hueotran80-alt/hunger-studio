/**
 * @file blender-modeling-suite.js
 * @description Authentic Blender 4.x Modeling Workflow & UI Suite for Web Blender Studio.
 *
 * Implements the core tools and interfaces that make 3D modeling feel like real Blender:
 * 1. Raw Unmaterialed Clay Blocks by Default (#d2d5da neutral clay, Flat/Smooth shading,
 *    optional Wireframe-on-Solid overlay, and 1-click reset to raw clay).
 * 2. 12 Blender Mesh Primitives (Plane, Cube, Circle, UV Sphere, Ico Sphere, Cylinder,
 *    Cone, Torus, Grid, Capsule, Pipe/Tube, Monkey/Suzanne).
 * 3. "Adjust Last Operation" (F9) Floating Bottom-Left Viewport Panel with live parametric
 *    geometry regeneration for both Primitives and Mesh Operations.
 * 4. 3D Cursor System (Shift+RightClick or Cursor Tool to place, Shift+C to reset; new
 *    objects spawn at the 3D Cursor).
 * 5. Context-Sensitive Left Toolbar (switches tools automatically between Object Mode,
 *    Edit Mode, and Sculpt Mode) + 3D Measure Tool.
 * 6. Full Viewport Header Menus (View, Select, Add, Object / Mesh) + Viewport Header
 *    Gizmo Bar (Global/Local Orientation, Snap 🧲, Wireframe Overlay ⊞, X-Ray ⧉).
 * 7. Right-Click Viewport Context Menu (Object Context Menu & Edit Mode Mesh Context Menu).
 * 8. Viewport N-Panel Sidebar (Item Transform & Metric Dimensions, Edit/Boolean/Origin Tools, View).
 */

import * as THREE from 'three';
import {
  mergeBufferGeometries,
  recomputeModifiers
} from '../core/modifiers.js';
import { dataBlockRegistry } from '../core/data-blocks.js';
import * as ModifierStack from '../core/modifier-stack.js';
import { MeshEditCommand } from '../core/edit-mode.js';
import { Command } from '../core/scene-manager.js';
import { shouldBlockViewportShortcut } from '../core/interaction-guard.js';
import { setMeshShading, flipMeshNormals, recalculateMeshNormals } from '../core/shading.js';
import { createImageObject } from '../core/image-objects.js';
import { createBezierCurveObject, createText3DObject } from '../core/curve-objects.js';
import { resolveEditableMesh } from '../core/mode-resolver.js';
import { escapeHtml } from '../core/escape-html.js';

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

export class BlenderModelingSuite {
  /**
   * @param {Object} app Main BlenderApp instance
   */
  constructor(app) {
    this.app = app;
    this.engine = app.engine;
    this.sceneManager = app.sceneManager;
    this.editMode = app.editMode;
    this.sculptMode = app.sculptMode;
    this.studio = typeof window !== 'undefined' ? window.studio : null;

    // Viewport state
    this.cursorPosition = new THREE.Vector3(0, 0, 0);
    this.cursorHelper = null;
    this.activeTool = 'select'; // 'select' | 'cursor' | 'move' | 'rotate' | 'scale' | 'measure'
    this.wireframeOverlayEnabled = false;
    this.xrayEnabled = false;
    this.snapEnabled = false;
    this.transformSpace = 'world'; // 'world' | 'local'

    // Measure tool state
    this.measureGroup = null;
    this.measureStart = null;
    this.measureEnd = null;
    this.measureLabelEl = null;

    // Last operation state for F9 "Adjust Last Operation" panel (expanded so adjustments are immediately visible)
    this.lastOp = null;
    this.lastOpCollapsed = false;

    // N-Panel state
    this.nPanelOpen = false;
    this.nPanelTab = 'item'; // 'item' | 'tool' | 'view'

    this.init();
  }

  _notify(message, type = 'warning') {
    const exporter = this.app?.exporter || (typeof window !== 'undefined' ? window.exporter : null);
    if (exporter?.showToast) exporter.showToast(message, type);
    const logKind = type === 'warning' ? 'warn' : type;
    this.app?.codeEditor?.log?.(logKind, message);
  }

  init() {
    if (!this.engine || !this.sceneManager || typeof document === 'undefined') return;

    this._create3DCursor();
    this._createMeasureGroup();
    this._injectViewportHeaderControls();
    this._upgradeAddMenus();
    this._upgradeLeftToolbar();
    this._createAdjustLastOpPanel();
    this._createViewportNPanel();
    this._createContextMenu();
    this._createViewportDropdownMenus();
    this._bindEvents();
  }

  // =========================================================================
  // 1. 3D CURSOR & MEASURE HELPER
  // =========================================================================

  _create3DCursor() {
    const group = new THREE.Group();
    group.name = 'Blender_3D_Cursor';
    group.userData.isSystemObject = true;
    group.userData.selectable = false;

    // Create canvas sprite with Blender's iconic red/white dashed ring + crosshair
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    const ctx = canvas.getContext('2d');
    const cx = 64, cy = 64, r = 34;

    // Outer dark shadow ring for contrast
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(0,0,0,0.65)';
    ctx.lineWidth = 7;
    ctx.stroke();

    // Alternating red & white segments (12 segments)
    for (let i = 0; i < 12; i++) {
      const a0 = (i / 12) * Math.PI * 2;
      const a1 = ((i + 0.85) / 12) * Math.PI * 2;
      ctx.beginPath();
      ctx.arc(cx, cy, r, a0, a1);
      ctx.strokeStyle = i % 2 === 0 ? '#ff3b30' : '#ffffff';
      ctx.lineWidth = 4.5;
      ctx.stroke();
    }

    // Inner black/white crosshair ticks
    ctx.strokeStyle = '#111111';
    ctx.lineWidth = 3.5;
    const drawCross = () => {
      ctx.beginPath();
      ctx.moveTo(cx - r - 12, cy); ctx.lineTo(cx - r + 10, cy);
      ctx.moveTo(cx + r - 10, cy); ctx.lineTo(cx + r + 12, cy);
      ctx.moveTo(cx, cy - r - 12); ctx.lineTo(cx, cy - r + 10);
      ctx.moveTo(cx, cy + r - 10); ctx.lineTo(cx, cy + r + 12);
      ctx.stroke();
    };
    drawCross();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    drawCross();

    // Center dot
    ctx.beginPath();
    ctx.arc(cx, cy, 3, 0, Math.PI * 2);
    ctx.fillStyle = '#ff9500';
    ctx.fill();

    const tex = new THREE.CanvasTexture(canvas);
    const mat = new THREE.SpriteMaterial({
      map: tex,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      sizeAttenuation: false
    });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(0.055, 0.055, 1);
    sprite.renderOrder = 998;
    sprite.userData.isSystemObject = true;
    sprite.userData.selectable = false;

    group.add(sprite);
    this.engine.scene.add(group);
    this.cursorHelper = group;
  }

  setCursorPosition(x, y, z) {
    this.cursorPosition.set(x, y, z);
    if (this.cursorHelper) {
      this.cursorHelper.position.copy(this.cursorPosition);
    }
    this._syncNPanelFields();
    this.sceneManager.requestRender();
  }

  _createMeasureGroup() {
    this.measureGroup = new THREE.Group();
    this.measureGroup.name = 'Blender_Measure_Helper';
    this.measureGroup.userData.isSystemObject = true;
    this.measureGroup.userData.selectable = false;
    this.engine.scene.add(this.measureGroup);
  }

  _clearMeasure() {
    if (!this.measureGroup) return;
    while (this.measureGroup.children.length > 0) {
      const c = this.measureGroup.children[0];
      c.geometry?.dispose?.();
      c.material?.dispose?.();
      this.measureGroup.remove(c);
    }
    if (this.measureLabelEl) {
      this.measureLabelEl.style.display = 'none';
    }
    this.measureStart = null;
    this.measureEnd = null;
  }

  _updateMeasureLine(p1, p2) {
    if (!this.measureGroup) return;
    while (this.measureGroup.children.length > 0) {
      const c = this.measureGroup.children[0];
      c.geometry?.dispose?.();
      c.material?.dispose?.();
      this.measureGroup.remove(c);
    }
    const geom = new THREE.BufferGeometry().setFromPoints([p1, p2]);
    const mat = new THREE.LineBasicMaterial({ color: 0xffd60a, depthTest: false, linewidth: 2 });
    const line = new THREE.Line(geom, mat);
    line.renderOrder = 999;
    line.userData.isSystemObject = true;
    this.measureGroup.add(line);

    const dist = p1.distanceTo(p2);
    if (!this.measureLabelEl) {
      this.measureLabelEl = document.createElement('div');
      this.measureLabelEl.className = 'b-measure-label';
      document.getElementById('viewport-canvas-host')?.appendChild(this.measureLabelEl);
    }
    const mid = new THREE.Vector3().addVectors(p1, p2).multiplyScalar(0.5);
    mid.project(this.engine.camera);
    const host = document.getElementById('viewport-canvas-host');
    if (host) {
      const hostRect = host.getBoundingClientRect();
      const vpRect = this.engine.getViewportRect ? this.engine.getViewportRect() : hostRect;
      const sx = (vpRect.left - hostRect.left) + (mid.x * 0.5 + 0.5) * vpRect.width;
      const sy = (vpRect.top - hostRect.top) + (-mid.y * 0.5 + 0.5) * vpRect.height;
      this.measureLabelEl.style.display = 'block';
      this.measureLabelEl.style.left = `${sx}px`;
      this.measureLabelEl.style.top = `${sy}px`;
      this.measureLabelEl.textContent = `📏 ${dist.toFixed(3)} m`;
    }
  }

  // =========================================================================
  // 2. COMPLETE 12 BLENDER MESH PRIMITIVES (UNMATERIALED CLAY BLOCKS)
  // =========================================================================

  /**
   * Builds a BufferGeometry for any of the 12 Blender primitives from params.
   */
  _buildPrimitiveGeometry(type, p) {
    switch (type) {
      case 'cube':
        return new THREE.BoxGeometry(
          p.width ?? 2, p.height ?? 2, p.depth ?? 2,
          Math.max(1, Math.round(p.subdivisionsX ?? 1)),
          Math.max(1, Math.round(p.subdivisionsY ?? 1)),
          Math.max(1, Math.round(p.subdivisionsZ ?? 1))
        );
      case 'plane': {
        const g = new THREE.PlaneGeometry(
          p.width ?? 2, p.height ?? 2,
          Math.max(1, Math.round(p.subdivisionsX ?? 1)),
          Math.max(1, Math.round(p.subdivisionsY ?? 1))
        );
        g.rotateX(-Math.PI / 2);
        return g;
      }
      case 'grid': {
        const g = new THREE.PlaneGeometry(
          p.width ?? 4, p.height ?? 4,
          Math.max(2, Math.round(p.subdivisionsX ?? 10)),
          Math.max(2, Math.round(p.subdivisionsY ?? 10))
        );
        g.rotateX(-Math.PI / 2);
        return g;
      }
      case 'circle': {
        const segs = Math.max(3, Math.round(p.vertices ?? 32));
        const r = p.radius ?? 1.0;
        if (p.fillType === 'nothing') {
          // Ring of edges / thin hollow rim
          const g = new THREE.RingGeometry(Math.max(0.01, r * 0.92), r, segs, 1);
          g.rotateX(-Math.PI / 2);
          return g;
        }
        const g = new THREE.CircleGeometry(r, segs);
        g.rotateX(-Math.PI / 2);
        return g;
      }
      case 'uv_sphere':
        return new THREE.SphereGeometry(
          p.radius ?? 1.0,
          Math.max(3, Math.round(p.segments ?? 32)),
          Math.max(2, Math.round(p.rings ?? 16))
        );
      case 'ico_sphere':
        return new THREE.IcosahedronGeometry(
          p.radius ?? 1.0,
          Math.max(0, Math.min(5, Math.round(p.subdivisions ?? 2)))
        );
      case 'cylinder':
        return new THREE.CylinderGeometry(
          p.radiusTop ?? (p.radius ?? 1.0),
          p.radiusBottom ?? (p.radius ?? 1.0),
          p.depth ?? 2.0,
          Math.max(3, Math.round(p.vertices ?? 32)),
          Math.max(1, Math.round(p.heightSegments ?? 1)),
          !!p.openEnded
        );
      case 'cone':
        return new THREE.ConeGeometry(
          p.radius1 ?? 1.0,
          p.depth ?? 2.0,
          Math.max(3, Math.round(p.vertices ?? 32)),
          Math.max(1, Math.round(p.heightSegments ?? 1)),
          !!p.openEnded
        );
      case 'torus': {
        const g = new THREE.TorusGeometry(
          p.majorRadius ?? 1.0,
          p.minorRadius ?? 0.25,
          Math.max(3, Math.round(p.minorSegments ?? 16)),
          Math.max(3, Math.round(p.majorSegments ?? 48))
        );
        g.rotateX(Math.PI / 2);
        return g;
      }
      case 'capsule':
        return new THREE.CapsuleGeometry(
          p.radius ?? 0.6,
          p.length ?? 1.2,
          Math.max(2, Math.round(p.capSegments ?? 12)),
          Math.max(4, Math.round(p.radialSegments ?? 24))
        );
      case 'pipe': {
        // Thick-walled hollow cylinder / pipe using LatheGeometry
        const outerR = Math.max(0.1, p.outerRadius ?? 1.0);
        const innerR = Math.max(0.02, Math.min(outerR - 0.02, p.innerRadius ?? 0.72));
        const h = Math.max(0.1, p.depth ?? 2.0);
        const halfH = h / 2;
        const pts = [
          new THREE.Vector2(innerR, -halfH),
          new THREE.Vector2(outerR, -halfH),
          new THREE.Vector2(outerR, halfH),
          new THREE.Vector2(innerR, halfH),
          new THREE.Vector2(innerR, -halfH)
        ];
        return new THREE.LatheGeometry(pts, Math.max(3, Math.round(p.vertices ?? 32)));
      }
      case 'monkey': {
        return this._buildSuzanneGeometry(p.radius ?? 1.0, Math.max(1, Math.min(3, Math.round(p.detail ?? 2))));
      }
      default:
        return new THREE.BoxGeometry(2, 2, 2);
    }
  }

  /**
   * Generates a procedural Stylized Suzanne (Blender Monkey Head) mesh
   * by merging sculpted anatomical parts (cranium, muzzle, brow ridge, eye sockets, eyeballs, ears).
   */
  _buildSuzanneGeometry(scale = 1.0, detail = 2) {
    const segs = detail === 1 ? 12 : (detail === 2 ? 20 : 28);
    const parts = [];

    const addPart = (geom, sx, sy, sz, px, py, pz, rx = 0, ry = 0, rz = 0) => {
      geom.scale(sx * scale, sy * scale, sz * scale);
      if (rx) geom.rotateX(rx);
      if (ry) geom.rotateY(ry);
      if (rz) geom.rotateZ(rz);
      geom.translate(px * scale, py * scale, pz * scale);
      parts.push(geom);
    };

    // 1. Cranium (skull)
    addPart(new THREE.SphereGeometry(0.78, segs, segs), 1.0, 0.95, 0.92, 0, 0.18, -0.08);
    // 2. Simian Muzzle / Snout
    addPart(new THREE.SphereGeometry(0.55, segs, Math.round(segs * 0.8)), 0.96, 0.68, 0.85, 0, -0.25, 0.45, 0.18, 0, 0);
    // 3. Chin / Lower Jaw
    addPart(new THREE.BoxGeometry(0.68, 0.34, 0.65, 2, 2, 2), 1.0, 1.0, 1.0, 0, -0.52, 0.36, 0.12, 0, 0);
    // 4. Prominent Brow Ridge
    addPart(new THREE.BoxGeometry(1.18, 0.22, 0.45, 4, 2, 2), 1.0, 1.0, 1.0, 0, 0.38, 0.48, 0.15, 0, 0);
    // 5. Left & Right Eye Sockets + Eyeballs
    addPart(new THREE.TorusGeometry(0.22, 0.06, 10, 18), 1.0, 1.0, 1.0, -0.30, 0.18, 0.58, 0, -0.18, 0);
    addPart(new THREE.TorusGeometry(0.22, 0.06, 10, 18), 1.0, 1.0, 1.0,  0.30, 0.18, 0.58, 0,  0.18, 0);
    addPart(new THREE.SphereGeometry(0.16, 14, 12), 1.0, 1.0, 0.85, -0.30, 0.18, 0.57);
    addPart(new THREE.SphereGeometry(0.16, 14, 12), 1.0, 1.0, 0.85,  0.30, 0.18, 0.57);
    // 6. Iconic Monkey Ears (Left & Right)
    addPart(new THREE.CylinderGeometry(0.36, 0.32, 0.14, 16), 1.0, 1.0, 0.85, -0.88, 0.08, -0.05, Math.PI / 2, 0.32, 0.22);
    addPart(new THREE.CylinderGeometry(0.36, 0.32, 0.14, 16), 1.0, 1.0, 0.85,  0.88, 0.08, -0.05, Math.PI / 2, -0.32, -0.22);

    return mergeBufferGeometries(parts);
  }

  /**
   * Default parameters for each primitive type
   */
  _getDefaultPrimitiveParams(type) {
    const cx = this.cursorPosition.x;
    const cy = this.cursorPosition.y;
    const cz = this.cursorPosition.z;
    switch (type) {
      case 'cube':
        return { name: 'Cube', width: 2.0, height: 2.0, depth: 2.0, subdivisionsX: 1, subdivisionsY: 1, subdivisionsZ: 1, x: cx, y: cy + 1.0, z: cz, rx: 0, ry: 0, rz: 0, flatShading: true };
      case 'plane':
        return { name: 'Plane', width: 2.0, height: 2.0, subdivisionsX: 1, subdivisionsY: 1, x: cx, y: cy, z: cz, rx: 0, ry: 0, rz: 0, flatShading: true };
      case 'grid':
        return { name: 'Grid', width: 4.0, height: 4.0, subdivisionsX: 10, subdivisionsY: 10, x: cx, y: cy, z: cz, rx: 0, ry: 0, rz: 0, flatShading: true };
      case 'circle':
        return { name: 'Circle', radius: 1.0, vertices: 32, fillType: 'ngon', x: cx, y: cy + 0.01, z: cz, rx: 0, ry: 0, rz: 0, flatShading: true };
      case 'uv_sphere':
        return { name: 'Sphere', radius: 1.0, segments: 32, rings: 16, x: cx, y: cy + 1.0, z: cz, rx: 0, ry: 0, rz: 0, flatShading: true };
      case 'ico_sphere':
        return { name: 'Icosphere', radius: 1.0, subdivisions: 2, x: cx, y: cy + 1.0, z: cz, rx: 0, ry: 0, rz: 0, flatShading: true };
      case 'cylinder':
        return { name: 'Cylinder', radius: 1.0, depth: 2.0, vertices: 32, heightSegments: 1, openEnded: false, x: cx, y: cy + 1.0, z: cz, rx: 0, ry: 0, rz: 0, flatShading: true };
      case 'cone':
        return { name: 'Cone', radius1: 1.0, depth: 2.0, vertices: 32, heightSegments: 1, openEnded: false, x: cx, y: cy + 1.0, z: cz, rx: 0, ry: 0, rz: 0, flatShading: true };
      case 'torus':
        return { name: 'Torus', majorRadius: 1.0, minorRadius: 0.25, majorSegments: 48, minorSegments: 16, x: cx, y: cy + 0.25, z: cz, rx: 0, ry: 0, rz: 0, flatShading: true };
      case 'capsule':
        return { name: 'Capsule', radius: 0.5, length: 1.0, capSegments: 12, radialSegments: 24, x: cx, y: cy + 1.0, z: cz, rx: 0, ry: 0, rz: 0, flatShading: true };
      case 'pipe':
        return { name: 'Pipe', outerRadius: 1.0, innerRadius: 0.72, depth: 2.0, vertices: 32, x: cx, y: cy + 1.0, z: cz, rx: 0, ry: 0, rz: 0, flatShading: true };
      case 'monkey':
        return { name: 'Suzanne', radius: 1.0, detail: 2, x: cx, y: cy + 1.0, z: cz, rx: 0, ry: 0, rz: 0, flatShading: true };
      default:
        return { name: 'Cube', width: 2.0, height: 2.0, depth: 2.0, x: cx, y: cy + 1.0, z: cz, rx: 0, ry: 0, rz: 0, flatShading: true };
    }
  }

  /**
   * Creates a raw unmaterialed Blender clay primitive and opens the F9 "Adjust Last Operation" panel.
   */
  spawnPrimitive(type, customParams = {}) {
    // If currently in Edit Mode or Sculpt Mode, exit to Object Mode first (or add safely)
    if (this.editMode?.isActive) {
      this.editMode.exit();
    }
    if (this.sculptMode?.isActive) {
      this.sculptMode.exit();
    }

    const params = { ...this._getDefaultPrimitiveParams(type), ...customParams };
    const geom = this._buildPrimitiveGeometry(type, params);

    // Raw Blender Clay Material (unmaterialed block)
    const mat = new THREE.MeshStandardMaterial({
      name: 'Default Clay',
      color: new THREE.Color(0xd2d5da),
      roughness: 0.65,
      metalness: 0.0,
      flatShading: !!params.flatShading,
      side: (type === 'plane' || type === 'grid' || type === 'circle' || params.openEnded) ? THREE.DoubleSide : THREE.FrontSide
    });
    mat.userData.isDefaultClay = true;

    if (this.xrayEnabled) {
      mat.transparent = true;
      mat.opacity = 0.55;
    }

    const mesh = new THREE.Mesh(geom, mat);
    mesh.position.set(params.x, params.y, params.z);
    mesh.rotation.set(
      (params.rx || 0) * DEG2RAD,
      (params.ry || 0) * DEG2RAD,
      (params.rz || 0) * DEG2RAD
    );
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.primitiveType = type;
    mesh.userData.primitiveParams = { ...params };

    this.sceneManager.addObject(mesh, null, true, true);

    if (this.wireframeOverlayEnabled) {
      this._setMeshWireframeOverlay(mesh, true);
    }

    // Show F9 "Adjust Last Operation" panel for this newly created primitive
    this._showAdjustPrimitiveOp(mesh, type, params);
    this._syncNPanelFields();
    return mesh;
  }

  // =========================================================================
  // 3. "ADJUST LAST OPERATION" (F9) FLOATING PANEL (BOTTOM-LEFT OF VIEWPORT)
  // =========================================================================

  _createAdjustLastOpPanel() {
    const host = document.getElementById('viewport-canvas-host');
    if (!host) return;

    const panel = document.createElement('div');
    panel.id = 'blender-last-op-panel';
    panel.className = 'b-last-op-panel';
    panel.style.display = 'none';
    host.appendChild(panel);
    this.lastOpPanel = panel;
  }

  _showAdjustPrimitiveOp(mesh, type, params) {
    if (!this.lastOpPanel || !mesh) return;

    const titles = {
      cube: 'Add Cube',
      plane: 'Add Plane',
      grid: 'Add Grid',
      circle: 'Add Circle',
      uv_sphere: 'Add UV Sphere',
      ico_sphere: 'Add Ico Sphere',
      cylinder: 'Add Cylinder',
      cone: 'Add Cone',
      torus: 'Add Torus',
      capsule: 'Add Capsule',
      pipe: 'Add Pipe',
      monkey: 'Add Monkey'
    };

    const fieldsByType = {
      cube: [
        { key: 'width', label: 'Size X (m)', min: 0.1, max: 20, step: 0.1 },
        { key: 'height', label: 'Size Y (m)', min: 0.1, max: 20, step: 0.1 },
        { key: 'depth', label: 'Size Z (m)', min: 0.1, max: 20, step: 0.1 },
        { key: 'subdivisionsX', label: 'Cuts X', min: 1, max: 24, step: 1 },
        { key: 'subdivisionsY', label: 'Cuts Y', min: 1, max: 24, step: 1 },
        { key: 'subdivisionsZ', label: 'Cuts Z', min: 1, max: 24, step: 1 }
      ],
      plane: [
        { key: 'width', label: 'Size X (m)', min: 0.1, max: 50, step: 0.5 },
        { key: 'height', label: 'Size Z (m)', min: 0.1, max: 50, step: 0.5 },
        { key: 'subdivisionsX', label: 'Subdivisions X', min: 1, max: 64, step: 1 },
        { key: 'subdivisionsY', label: 'Subdivisions Z', min: 1, max: 64, step: 1 }
      ],
      grid: [
        { key: 'width', label: 'Size X (m)', min: 0.5, max: 50, step: 0.5 },
        { key: 'height', label: 'Size Z (m)', min: 0.5, max: 50, step: 0.5 },
        { key: 'subdivisionsX', label: 'X Subdivisions', min: 2, max: 100, step: 1 },
        { key: 'subdivisionsY', label: 'Y Subdivisions', min: 2, max: 100, step: 1 }
      ],
      circle: [
        { key: 'vertices', label: 'Vertices', min: 3, max: 128, step: 1 },
        { key: 'radius', label: 'Radius (m)', min: 0.1, max: 20, step: 0.1 }
      ],
      uv_sphere: [
        { key: 'segments', label: 'Segments', min: 3, max: 128, step: 1 },
        { key: 'rings', label: 'Rings', min: 2, max: 64, step: 1 },
        { key: 'radius', label: 'Radius (m)', min: 0.1, max: 20, step: 0.1 }
      ],
      ico_sphere: [
        { key: 'subdivisions', label: 'Subdivisions (1..5)', min: 0, max: 5, step: 1 },
        { key: 'radius', label: 'Radius (m)', min: 0.1, max: 20, step: 0.1 }
      ],
      cylinder: [
        { key: 'vertices', label: 'Vertices', min: 3, max: 128, step: 1 },
        { key: 'radius', label: 'Radius (m)', min: 0.05, max: 20, step: 0.05 },
        { key: 'depth', label: 'Depth / Height (m)', min: 0.1, max: 20, step: 0.1 },
        { key: 'heightSegments', label: 'Height Cuts', min: 1, max: 32, step: 1 }
      ],
      cone: [
        { key: 'vertices', label: 'Vertices', min: 3, max: 128, step: 1 },
        { key: 'radius1', label: 'Radius 1 (m)', min: 0.05, max: 20, step: 0.05 },
        { key: 'depth', label: 'Depth / Height (m)', min: 0.1, max: 20, step: 0.1 },
        { key: 'heightSegments', label: 'Height Cuts', min: 1, max: 32, step: 1 }
      ],
      torus: [
        { key: 'majorSegments', label: 'Major Segments', min: 3, max: 128, step: 1 },
        { key: 'minorSegments', label: 'Minor Segments', min: 3, max: 64, step: 1 },
        { key: 'majorRadius', label: 'Major Radius (m)', min: 0.1, max: 15, step: 0.05 },
        { key: 'minorRadius', label: 'Minor Radius (m)', min: 0.02, max: 5, step: 0.02 }
      ],
      capsule: [
        { key: 'radius', label: 'Radius (m)', min: 0.05, max: 10, step: 0.05 },
        { key: 'length', label: 'Length (m)', min: 0.1, max: 20, step: 0.1 },
        { key: 'radialSegments', label: 'Radial Segments', min: 4, max: 64, step: 1 },
        { key: 'capSegments', label: 'Cap Rings', min: 2, max: 32, step: 1 }
      ],
      pipe: [
        { key: 'vertices', label: 'Vertices', min: 3, max: 128, step: 1 },
        { key: 'outerRadius', label: 'Outer Radius (m)', min: 0.1, max: 15, step: 0.05 },
        { key: 'innerRadius', label: 'Inner Radius (m)', min: 0.05, max: 14, step: 0.05 },
        { key: 'depth', label: 'Depth / Height (m)', min: 0.1, max: 20, step: 0.1 }
      ],
      monkey: [
        { key: 'radius', label: 'Size (m)', min: 0.2, max: 10, step: 0.1 },
        { key: 'detail', label: 'Resolution (1..3)', min: 1, max: 3, step: 1 }
      ]
    };

    const fields = fieldsByType[type] || fieldsByType.cube;
    this.lastOp = { kind: 'primitive', mesh, type, params };

    const renderPanel = () => {
      const title = titles[type] || 'Adjust Last Operation';
      const rowsHtml = fields.map((f) => {
        const val = params[f.key] ?? 1;
        return `
          <div class="b-op-row">
            <span class="b-op-label">${f.label}</span>
            <input type="range" class="b-op-slider" data-key="${f.key}" min="${f.min}" max="${f.max}" step="${f.step}" value="${val}">
            <input type="number" class="b-op-num" data-key="${f.key}" min="${f.min}" max="${f.max}" step="${f.step}" value="${val}">
          </div>
        `;
      }).join('');

      this.lastOpPanel.innerHTML = `
        <div class="b-op-header" id="b-op-header-toggle">
          <span class="b-op-caret">${this.lastOpCollapsed ? '▸' : '▾'}</span>
          <span class="b-op-title">${title}</span>
          <span class="b-op-shortcut" title="Press F9 to toggle">F9</span>
          <button type="button" class="b-op-close" id="b-op-close-btn" title="Close">✕</button>
        </div>
        <div class="b-op-body" style="display: ${this.lastOpCollapsed ? 'none' : 'flex'};">
          ${rowsHtml}
          <div class="b-op-row">
            <span class="b-op-label">Shading</span>
            <div class="b-op-btn-pair">
              <button type="button" class="b-op-mini-btn ${params.flatShading ? 'active' : ''}" id="b-op-flat">Flat</button>
              <button type="button" class="b-op-mini-btn ${!params.flatShading ? 'active' : ''}" id="b-op-smooth">Smooth</button>
            </div>
          </div>
          <div class="b-op-row">
            <span class="b-op-label">Location Y</span>
            <input type="range" class="b-op-slider" data-pos="y" min="-10" max="20" step="0.1" value="${mesh.position.y.toFixed(2)}">
            <input type="number" class="b-op-num" data-pos="y" step="0.1" value="${mesh.position.y.toFixed(2)}">
          </div>
        </div>
      `;

      this.lastOpPanel.style.display = 'block';

      this.lastOpPanel.querySelector('#b-op-header-toggle')?.addEventListener('click', (e) => {
        if (e.target.closest('#b-op-close-btn')) return;
        this.lastOpCollapsed = !this.lastOpCollapsed;
        renderPanel();
      });

      this.lastOpPanel.querySelector('#b-op-close-btn')?.addEventListener('click', () => {
        this.lastOpPanel.style.display = 'none';
      });

      const rebuild = () => {
        if (!mesh.parent) return;
        const newGeom = this._buildPrimitiveGeometry(type, params);
        mesh.geometry?.dispose?.();
        mesh.geometry = newGeom;
        if (mesh.material) {
          mesh.material.flatShading = !!params.flatShading;
          mesh.material.needsUpdate = true;
        }
        mesh.geometry.computeVertexNormals();
        mesh.userData.primitiveParams = { ...params };
        if (this.wireframeOverlayEnabled || mesh.userData.showWireframeOverlay) {
          this._setMeshWireframeOverlay(mesh, true);
        }
        this.engine.updateSelectionHelper();
        window.dispatchEvent(new CustomEvent('blender:geometryChanged', { detail: mesh }));
        this._syncNPanelFields();
        this.sceneManager.requestRender();
      };

      this.lastOpPanel.querySelectorAll('[data-key]').forEach((inp) => {
        inp.addEventListener('input', (e) => {
          const k = e.target.dataset.key;
          const v = parseFloat(e.target.value);
          if (!Number.isFinite(v)) return;
          params[k] = v;
          // Sync paired slider/number input
          this.lastOpPanel.querySelectorAll(`[data-key="${k}"]`).forEach((peer) => {
            if (peer !== e.target) peer.value = String(v);
          });
          rebuild();
        });
      });

      this.lastOpPanel.querySelectorAll('[data-pos="y"]').forEach((inp) => {
        inp.addEventListener('input', (e) => {
          const v = parseFloat(e.target.value);
          if (!Number.isFinite(v)) return;
          mesh.position.y = v;
          params.y = v;
          this.lastOpPanel.querySelectorAll('[data-pos="y"]').forEach((peer) => {
            if (peer !== e.target) peer.value = String(v);
          });
          this.engine.updateSelectionHelper();
          this.inspector?.updateTransformFields?.();
          this._syncNPanelFields();
          this.sceneManager.requestRender();
        });
      });

      this.lastOpPanel.querySelector('#b-op-flat')?.addEventListener('click', () => {
        params.flatShading = true;
        rebuild();
        renderPanel();
      });
      this.lastOpPanel.querySelector('#b-op-smooth')?.addEventListener('click', () => {
        params.flatShading = false;
        rebuild();
        renderPanel();
      });
    };

    renderPanel();
  }

  /**
   * Shows the F9 "Adjust Last Operation" panel for Edit Mode operations
   * (Extrude, Inset, Bevel, Subdivide, Loop Cut, Spin/Lathe, Solidify).
   */
  _showAdjustMeshEditOp(title, fields, currentParams, onUpdate) {
    if (!this.lastOpPanel) return;
    const params = { ...currentParams };
    this.lastOp = { kind: 'mesh_op', title, fields, params, onUpdate };

    const renderPanel = () => {
      const rowsHtml = fields.map((f) => {
        const val = params[f.key] ?? f.default ?? 0;
        return `
          <div class="b-op-row">
            <span class="b-op-label">${f.label}</span>
            <input type="range" class="b-op-slider" data-key="${f.key}" min="${f.min}" max="${f.max}" step="${f.step}" value="${val}">
            <input type="number" class="b-op-num" data-key="${f.key}" min="${f.min}" max="${f.max}" step="${f.step}" value="${val}">
          </div>
        `;
      }).join('');

      this.lastOpPanel.innerHTML = `
        <div class="b-op-header" id="b-op-header-toggle">
          <span class="b-op-caret">${this.lastOpCollapsed ? '▸' : '▾'}</span>
          <span class="b-op-title">${title}</span>
          <span class="b-op-shortcut">F9</span>
          <button type="button" class="b-op-close" id="b-op-close-btn">✕</button>
        </div>
        <div class="b-op-body" style="display: ${this.lastOpCollapsed ? 'none' : 'flex'};">
          ${rowsHtml}
        </div>
      `;
      this.lastOpPanel.style.display = 'block';

      this.lastOpPanel.querySelector('#b-op-header-toggle')?.addEventListener('click', (e) => {
        if (e.target.closest('#b-op-close-btn')) return;
        this.lastOpCollapsed = !this.lastOpCollapsed;
        renderPanel();
      });

      this.lastOpPanel.querySelector('#b-op-close-btn')?.addEventListener('click', (e) => {
        if (e.detail > 0) e.currentTarget?.blur?.();
        this.lastOpPanel.style.display = 'none';
      });

      this.lastOpPanel.querySelectorAll('[data-key]').forEach((inp) => {
        inp.addEventListener('input', (e) => {
          const k = e.target.dataset.key;
          const v = parseFloat(e.target.value);
          if (!Number.isFinite(v)) return;
          params[k] = v;
          this.lastOpPanel.querySelectorAll(`[data-key="${k}"]`).forEach((peer) => {
            if (peer !== e.target) peer.value = String(v);
          });
          onUpdate(params);
        });
        inp.addEventListener('change', (e) => {
          if (e.target.type === 'range') e.target.blur();
        });
      });
    };

    renderPanel();
  }

  // =========================================================================
  // 4. WIREFRAME ON SOLID & X-RAY OVERLAYS + ESSENTIAL OBJECT / MESH OPS
  // =========================================================================

  _setMeshWireframeOverlay(mesh, enabled) {
    if (!mesh || !mesh.isMesh) return;
    mesh.userData.showWireframeOverlay = !!enabled;

    // Remove existing wireframe overlay child if any
    const existing = mesh.children.find(c => c.userData?.isWireframeOverlayHelper);
    if (existing) {
      existing.geometry?.dispose?.();
      existing.material?.dispose?.();
      mesh.remove(existing);
    }

    if (enabled && mesh.geometry) {
      const edgesGeom = new THREE.EdgesGeometry(mesh.geometry, 1); // Show all polygon edges
      const edgesMat = new THREE.LineBasicMaterial({
        color: 0x1a1c20,
        transparent: true,
        opacity: 0.55,
        depthTest: true
      });
      const wire = new THREE.LineSegments(edgesGeom, edgesMat);
      wire.name = '_WireframeOverlay';
      wire.userData.isSystemObject = true;
      wire.userData.isHelper = true;
      wire.userData.selectable = false;
      wire.userData.isWireframeOverlayHelper = true;
      mesh.add(wire);
    }
    this.sceneManager.requestRender();
  }

  toggleGlobalWireframeOverlay(forceState = undefined) {
    this.wireframeOverlayEnabled = forceState !== undefined ? !!forceState : !this.wireframeOverlayEnabled;
    this.sceneManager.traverseObjects((obj) => {
      if (obj.isMesh && !obj.userData?.isSystemObject && !obj.userData?.isHelper) {
        this._setMeshWireframeOverlay(obj, this.wireframeOverlayEnabled);
      }
    });
    const btn = document.getElementById('btn-vp-wire-overlay');
    if (btn) btn.classList.toggle('active', this.wireframeOverlayEnabled);
    this.sceneManager.requestRender();
  }

  toggleXRayMode(forceState = undefined) {
    this.xrayEnabled = forceState !== undefined ? !!forceState : !this.xrayEnabled;
    this.sceneManager.traverseObjects((obj) => {
      if (obj.isMesh && obj.material && !obj.userData?.isSystemObject && !obj.userData?.isHelper) {
        if (this.xrayEnabled) {
          if (obj.userData.__xraySourceMaterial !== undefined) return;
          const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
          const hasShared = mats.some((m) => m?.userData?.isMatCapMaterial);
          if (hasShared) {
            obj.userData.__xraySourceMaterial = obj.material;
            const cloned = mats.map((m) => {
              if (!m) return m;
              const c = m.clone();
              c.userData = { ...(c.userData || {}), isXrayClone: true };
              c.transparent = true;
              c.opacity = 0.52;
              c.depthWrite = false;
              c.needsUpdate = true;
              return c;
            });
            obj.material = Array.isArray(obj.material) ? cloned : cloned[0];
          } else {
            mats.forEach((m) => {
              if (!m) return;
              if (m.userData._preXrayOpacity === undefined) {
                m.userData._preXrayOpacity = m.opacity ?? 1.0;
                m.userData._preXrayTransparent = !!m.transparent;
                m.userData._preXrayDepthWrite = m.depthWrite !== false;
              }
              m.transparent = true;
              m.opacity = 0.52;
              m.depthWrite = false;
              m.needsUpdate = true;
            });
          }
        } else if (obj.userData.__xraySourceMaterial !== undefined) {
          const prevMats = Array.isArray(obj.material) ? obj.material : [obj.material];
          obj.material = obj.userData.__xraySourceMaterial;
          delete obj.userData.__xraySourceMaterial;
          prevMats.forEach((m) => {
            if (m?.userData?.isXrayClone) {
              try { m.dispose(); } catch (_) {}
            }
          });
        } else {
          const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
          mats.forEach((m) => {
            if (!m) return;
            m.opacity = m.userData._preXrayOpacity ?? 1.0;
            m.transparent = m.userData._preXrayTransparent ?? (m.opacity < 1.0);
            m.depthWrite = m.userData._preXrayDepthWrite ?? true;
            delete m.userData._preXrayOpacity;
            delete m.userData._preXrayTransparent;
            delete m.userData._preXrayDepthWrite;
            m.needsUpdate = true;
          });
        }
      }
    });
    const btn = document.getElementById('btn-vp-xray');
    if (btn) btn.classList.toggle('active', this.xrayEnabled);
    this.sceneManager.requestRender();
  }

  shadeObject(smooth = true, angleDeg = 30) {
    const selected = this.sceneManager.getSelectedObjects();
    if (selected.length === 0) return;
    const mode = typeof smooth === 'string' ? smooth : (smooth ? 'smooth' : 'flat');
    selected.forEach((obj) => {
      obj.traverse?.((child) => {
        if (child.isMesh) {
          setMeshShading(child, mode, { angleDeg, sceneManager: this.sceneManager });
        }
      });
    });
    window.inspector?.render?.();
    this.sceneManager.requestRender();
  }

  shadeObjectAuto(angleDeg = 30) {
    this.shadeObject('auto', angleDeg);
  }

  recalculateSelectedNormals(inside = false) {
    const selected = this.sceneManager.getSelectedObjects();
    if (selected.length === 0) return;
    selected.forEach((obj) => {
      obj.traverse?.((child) => {
        if (child.isMesh) {
          recalculateMeshNormals(child, inside);
        }
      });
    });
    window.inspector?.render?.();
    this.sceneManager.requestRender();
  }

  flipSelectedNormals() {
    // Edit Mode: flip the mesh being edited and resync its topology/markers.
    const em = this.editMode;
    if (em?.isActive && em.targetMesh?.isMesh) {
      flipMeshNormals(em.targetMesh);
      em._buildTopology(em.targetMesh);
      em.updateVisuals();
      window.inspector?.render?.();
      this.sceneManager.requestRender();
      return;
    }

    const selected = this.sceneManager.getSelectedObjects();
    if (selected.length === 0) return;
    selected.forEach((obj) => {
      obj.traverse?.((child) => {
        if (child.isMesh) {
          flipMeshNormals(child);
        }
      });
    });
    window.inspector?.render?.();
    this.sceneManager.requestRender();
  }

  resetObjectToRawClay() {
    const selected = this.sceneManager.getSelectedObjects();
    if (selected.length === 0) return;
    const changes = [];
    selected.forEach((obj) => {
      obj.traverse?.((child) => {
        if (child.isMesh && child.material && !child.userData?.isHelper && !child.userData?.isSystemObject) {
          child.userData = child.userData || {};
          const prevMat = child.material;
          const mats = Array.isArray(prevMat) ? prevMat : [prevMat];
          if (!child.userData.__importedMaterial && mats.some((m) => m && !m.userData?.isDefaultClay)) {
            child.userData.__importedMaterial = Array.isArray(prevMat)
              ? prevMat.map((m) => m?.clone?.() || m)
              : (prevMat.clone?.() || prevMat);
          }
          const clayMat = new THREE.MeshStandardMaterial({
            name: 'Default Clay',
            color: 0xd2d5da,
            roughness: 0.65,
            metalness: 0.0,
            flatShading: true,
          });
          clayMat.userData = { isDefaultClay: true };
          changes.push({ mesh: child, oldMat: prevMat, newMat: clayMat });
        }
      });
    });
    if (changes.length === 0) return;
    const applyChanges = (useNew) => {
      for (const item of changes) {
        item.mesh.material = useNew ? item.newMat : item.oldMat;
        item.mesh.geometry?.computeVertexNormals?.();
      }
      window.inspector?.render?.();
      this.sceneManager.requestRender();
    };
    const cmd = new Command('Reset Material to Clay');
    cmd.execute = () => applyChanges(true);
    cmd.undo = () => applyChanges(false);
    applyChanges(true);
    this.sceneManager.executeCommand?.(cmd);
  }

  /**
   * Blender Set Origin: 'geometry' | 'bottom' | 'cursor'
   */
  setOrigin(mode = 'geometry') {
    const active = this.sceneManager.getActiveObject();
    if (!active || !active.isMesh || !active.geometry) return;

    active.updateMatrixWorld(true);
    active.geometry.computeBoundingBox();
    const bb = active.geometry.boundingBox;
    if (!bb) return;

    const targetLocal = new THREE.Vector3();
    if (mode === 'geometry') {
      bb.getCenter(targetLocal);
    } else if (mode === 'bottom') {
      bb.getCenter(targetLocal);
      targetLocal.y = bb.min.y;
    } else if (mode === 'cursor') {
      targetLocal.copy(this.cursorPosition);
      active.worldToLocal(targetLocal);
    }

    if (targetLocal.lengthSq() < 1e-8) return;

    // Shift vertices by -targetLocal and move object in world space to compensate
    const worldOffset = targetLocal.clone().applyMatrix4(active.matrixWorld).sub(active.getWorldPosition(new THREE.Vector3()));
    active.geometry.translate(-targetLocal.x, -targetLocal.y, -targetLocal.z);
    active.geometry.computeBoundingBox();
    active.geometry.computeBoundingSphere();
    active.position.add(worldOffset);
    active.updateMatrixWorld(true);

    if (active.userData.showWireframeOverlay || this.wireframeOverlayEnabled) {
      this._setMeshWireframeOverlay(active, true);
    }
    this.engine.updateSelectionHelper();
    window.inspector?.updateTransformFields?.();
    this._syncNPanelFields();
    this.sceneManager.requestRender();
  }

  snapObjectToFloor() {
    const active = this.sceneManager.getActiveObject();
    if (!active) return;
    const box = new THREE.Box3().setFromObject(active);
    if (!box.isEmpty()) {
      active.position.y -= box.min.y;
      active.updateMatrixWorld(true);
      this.engine.updateSelectionHelper();
      window.inspector?.updateTransformFields?.();
      this._syncNPanelFields();
      this.sceneManager.requestRender();
    }
  }

  /**
   * Blender Ctrl+A: Apply Scale / Rotation / Location cleanly into mesh vertices
   * (modifier-stack aware + multi-select + single atomic Undo step).
   */
  applyAllTransforms(applyLocation = false, applyRotation = true, applyScale = true) {
    const selected = typeof this.sceneManager?.getSelectedObjects === 'function'
      ? this.sceneManager.getSelectedObjects().filter((o) => o?.isMesh && o.geometry)
      : [];
    const active = this.sceneManager.getActiveObject();
    const targets = selected.length > 0 ? selected : (active?.isMesh ? [active] : []);
    if (targets.length === 0) return false;

    const snapshots = targets.map((obj) => {
      const hasStack = Array.isArray(obj.userData?.modifierStack) && obj.userData.modifierStack.length > 0 && Boolean(obj.userData?.baseGeometry);
      const targetGeo = hasStack ? obj.userData.baseGeometry : obj.geometry;
      return {
        obj,
        hasStack,
        prevPos: obj.position.clone(),
        prevQuat: obj.quaternion.clone(),
        prevScale: obj.scale.clone(),
        prevGeoPositions: targetGeo?.attributes?.position ? new Float32Array(targetGeo.attributes.position.array) : null,
        prevGeoNormals: targetGeo?.attributes?.normal ? new Float32Array(targetGeo.attributes.normal.array) : null,
      };
    });

    const applyFn = () => {
      for (const s of snapshots) {
        const obj = s.obj;
        const pos = applyLocation ? obj.position.clone() : new THREE.Vector3();
        const quat = applyRotation ? obj.quaternion.clone() : new THREE.Quaternion();
        const scl = applyScale ? obj.scale.clone() : new THREE.Vector3(1, 1, 1);
        const mat = new THREE.Matrix4().compose(pos, quat, scl);

        if (s.hasStack && obj.userData.baseGeometry) {
          obj.userData.baseGeometry.applyMatrix4(mat);
          obj.userData.baseGeometry.computeVertexNormals();
          obj.userData.baseGeometry.computeBoundingBox();
          obj.userData.baseGeometry.computeBoundingSphere();
          if (applyLocation) obj.position.set(0, 0, 0);
          if (applyRotation) obj.rotation.set(0, 0, 0);
          if (applyScale) obj.scale.set(1, 1, 1);
          obj.updateMatrixWorld(true);
          recomputeModifiers(obj);
        } else {
          obj.geometry.applyMatrix4(mat);
          obj.geometry.computeVertexNormals();
          obj.geometry.computeBoundingBox();
          obj.geometry.computeBoundingSphere();
          if (applyLocation) obj.position.set(0, 0, 0);
          if (applyRotation) obj.rotation.set(0, 0, 0);
          if (applyScale) obj.scale.set(1, 1, 1);
          obj.updateMatrixWorld(true);
          dataBlockRegistry.propagateMeshData?.(obj, this.sceneManager?.rootContainer || this.engine?.scene);
        }
        if (obj.userData.showWireframeOverlay || this.wireframeOverlayEnabled) {
          this._setMeshWireframeOverlay(obj, true);
        }
      }
      this.engine?.updateSelectionHelper?.();
      globalThis.window?.inspector?.updateTransformFields?.();
      this._syncNPanelFields?.();
      this.sceneManager?.requestRender?.();
    };

    const undoFn = () => {
      for (const s of snapshots) {
        const obj = s.obj;
        const targetGeo = s.hasStack ? obj.userData.baseGeometry : obj.geometry;
        if (targetGeo?.attributes?.position && s.prevGeoPositions) {
          targetGeo.attributes.position.array.set(s.prevGeoPositions);
          targetGeo.attributes.position.needsUpdate = true;
          if (targetGeo.attributes.normal && s.prevGeoNormals) {
            targetGeo.attributes.normal.array.set(s.prevGeoNormals);
            targetGeo.attributes.normal.needsUpdate = true;
          }
          targetGeo.computeBoundingBox();
          targetGeo.computeBoundingSphere();
        }
        obj.position.copy(s.prevPos);
        obj.quaternion.copy(s.prevQuat);
        obj.scale.copy(s.prevScale);
        obj.updateMatrixWorld(true);
        if (s.hasStack) recomputeModifiers(obj);
      }
      this.engine?.updateSelectionHelper?.();
      globalThis.window?.inspector?.updateTransformFields?.();
      this._syncNPanelFields?.();
      this.sceneManager?.requestRender?.();
    };

    applyFn();
    if (typeof this.sceneManager?.recordExecutedCommand === 'function') {
      this.sceneManager.recordExecutedCommand({
        name: 'Apply Transforms (Ctrl+A)',
        description: 'Apply Transforms (Ctrl+A)',
        execute: applyFn,
        undo: undoFn,
      });
    } else if (Array.isArray(this.sceneManager?.undoStack)) {
      this.sceneManager.undoStack.push({ execute: applyFn, undo: undoFn, description: 'Apply Transforms (Ctrl+A)' });
      if (Array.isArray(this.sceneManager.redoStack)) this.sceneManager.redoStack.length = 0;
    }
    return true;
  }

  /**
   * Blender Ctrl+J: Join all selected meshes into the active mesh
   */
  joinSelectedMeshes() {
    const selected = this.sceneManager.getSelectedObjects().filter(o => o.isMesh && o.geometry);
    if (selected.length < 2) {
      this._notify('Shift-select at least 2 Mesh objects to Join (Ctrl+J).', 'warning');
      return;
    }
    let active = this.sceneManager.getActiveObject();
    if (!active || !active.isMesh || !selected.includes(active)) active = selected[selected.length - 1];
    active.updateMatrixWorld(true);
    const invActive = active.matrixWorld.clone().invert();

    // Snapshot every source so Join is a single atomic undo step and no
    // geometry/material/modifier state is lost when the meshes are merged.
    const snapshots = selected.map((m) => ({
      mesh: m,
      parent: m.parent,
      childIndex: m.parent ? m.parent.children.indexOf(m) : -1,
      geometry: m.geometry,
      baseGeometry: m.userData.baseGeometry || null,
      material: m.material,
      stack: ModifierStack.getStack(m).map((d) => ({ ...d, params: { ...(d.params || {}) } })),
      revision: m.userData.stackRevision || 0,
      visible: m.visible
    }));

    const buildJoin = () => {
      const materials = [];
      const matIndex = new Map();
      const pieces = [];
      const pieceMats = [];
      for (const s of snapshots) {
        const m = s.mesh;
        m.updateMatrixWorld(true);
        const rel = new THREE.Matrix4().multiplyMatrices(invActive, m.matrixWorld);
        const base = s.baseGeometry || s.geometry;
        const ni = base.index ? base.toNonIndexed() : base.clone();
        const mats = Array.isArray(s.material) ? s.material : [s.material];
        const groups = (base.groups && base.groups.length)
          ? base.groups
          : [{ start: 0, count: ni.attributes.position.count, materialIndex: 0 }];
        for (const g of groups) {
          const sub = new THREE.BufferGeometry();
          for (const name of Object.keys(ni.attributes)) {
            const attr = ni.attributes[name];
            const count = Math.max(0, Math.min(g.count, attr.count - g.start));
            const arr = new attr.array.constructor(count * attr.itemSize);
            for (let i = 0; i < count; i++) {
              for (let c = 0; c < attr.itemSize; c++) {
                arr[i * attr.itemSize + c] = attr.array[(g.start + i) * attr.itemSize + c];
              }
            }
            sub.setAttribute(name, new THREE.BufferAttribute(arr, attr.itemSize));
          }
          sub.applyMatrix4(rel);
          const mat = mats[g.materialIndex] || mats[0];
          let mi = matIndex.get(mat.uuid);
          if (mi === undefined) {
            mi = materials.length;
            materials.push(mat);
            matIndex.set(mat.uuid, mi);
          }
          pieces.push(sub);
          pieceMats.push(mi);
        }
        ni.dispose();
      }
      const merged = mergeBufferGeometries(pieces, true);
      merged.groups.forEach((g, i) => { g.materialIndex = pieceMats[i]; });
      return { merged, materials };
    };

    const applyJoin = () => {
      const { merged, materials } = buildJoin();
      active.geometry = merged;
      active.userData.baseGeometry = merged;
      active.material = materials.length > 1 ? materials : materials[0];
      for (const s of snapshots) {
        if (s.mesh !== active) this.sceneManager.removeObject(s.mesh, false, false);
      }
      if (ModifierStack.getStack(active).length > 0) {
        ModifierStack.evaluateStack(active, { sceneManager: this.sceneManager })
          .then((geom) => {
            if (geom && active.parent) {
              active.geometry = geom;
              this.sceneManager.requestRender();
            }
          })
          .catch((err) => {
            if (!err?.cancelled) console.warn('[Join] modifier stack evaluation failed:', err);
          });
      }
      this.sceneManager.select(active, false);
      if (active.userData.showWireframeOverlay || this.wireframeOverlayEnabled) {
        this._setMeshWireframeOverlay(active, true);
      }
      this.engine.updateSelectionHelper();
      window.dispatchEvent(new CustomEvent('blender:geometryChanged', { detail: active }));
      this.sceneManager.requestRender();
    };

    const restoreJoin = () => {
      for (const s of snapshots) {
        const m = s.mesh;
        if (m !== active && !m.parent) {
          this.sceneManager.addObject(m, s.parent, false, false);
          if (s.parent && s.childIndex >= 0) {
            const curr = s.parent.children.indexOf(m);
            if (curr !== -1 && curr !== s.childIndex) {
              s.parent.children.splice(curr, 1);
              s.parent.children.splice(s.childIndex, 0, m);
            }
          }
        }
        m.geometry = s.geometry;
        m.userData.baseGeometry = s.baseGeometry;
        m.material = s.material;
        m.userData.modifierStack = s.stack.map((d) => ({ ...d, params: { ...(d.params || {}) } }));
        m.userData.stackRevision = s.revision;
        m.visible = s.visible;
      }
      if (ModifierStack.getStack(active).length > 0) {
        ModifierStack.evaluateStack(active, { sceneManager: this.sceneManager })
          .then((geom) => {
            if (geom && active.parent) {
              active.geometry = geom;
              this.sceneManager.requestRender();
            }
          })
          .catch((err) => {
            if (!err?.cancelled) console.warn('[Join] modifier stack evaluation failed:', err);
          });
      }
      this.sceneManager.select(active, false);
      this.engine.updateSelectionHelper();
      window.dispatchEvent(new CustomEvent('blender:geometryChanged', { detail: active }));
      this.sceneManager.requestRender();
    };

    applyJoin();
    this.sceneManager.executeCommand({
      description: 'Join Meshes',
      bytes: active.geometry.attributes.position.array.byteLength,
      execute: applyJoin,
      undo: restoreJoin
    });
  }

  /**
   * Solidify Mesh (Blender Solidify Modifier / Shell Thickness)
   */
  solidifyActiveMesh(thickness = 0.15) {
    const active = resolveEditableMesh(this.sceneManager.getActiveObject(), this.sceneManager);
    if (!active || !active.isMesh || !active.geometry) return;

    const baseGeom = (active.userData._preSolidifyGeom || active.geometry).clone();
    if (!active.userData._preSolidifyGeom) {
      active.userData._preSolidifyGeom = baseGeom.clone();
    }

    const applyThickness = (t) => {
      const outer = baseGeom.index ? baseGeom.toNonIndexed() : baseGeom.clone();
      outer.computeVertexNormals();
      const inner = outer.clone();

      const pos = inner.attributes.position;
      const norm = inner.attributes.normal;
      for (let i = 0; i < pos.count; i++) {
        pos.setXYZ(
          i,
          pos.getX(i) - norm.getX(i) * t,
          pos.getY(i) - norm.getY(i) * t,
          pos.getZ(i) - norm.getZ(i) * t
        );
      }
      // Flip inner triangle winding & normals
      for (let i = 0; i < pos.count; i += 3) {
        const x1 = pos.getX(i + 1), y1 = pos.getY(i + 1), z1 = pos.getZ(i + 1);
        const x2 = pos.getX(i + 2), y2 = pos.getY(i + 2), z2 = pos.getZ(i + 2);
        pos.setXYZ(i + 1, x2, y2, z2);
        pos.setXYZ(i + 2, x1, y1, z1);
      }
      inner.computeVertexNormals();

      const combined = mergeBufferGeometries([outer, inner]);
      active.geometry.dispose();
      active.geometry = combined;
      if (active.userData.showWireframeOverlay || this.wireframeOverlayEnabled) {
        this._setMeshWireframeOverlay(active, true);
      }
      window.dispatchEvent(new CustomEvent('blender:geometryChanged', { detail: active }));
      this.sceneManager.requestRender();
    };

    applyThickness(thickness);
    this._showAdjustMeshEditOp(
      'Solidify (Shell Thickness)',
      [{ key: 'thickness', label: 'Thickness (m)', min: -1.0, max: 1.0, step: 0.02, default: thickness }],
      { thickness },
      (p) => applyThickness(p.thickness)
    );
  }

  /**
   * Orient spin profile edges into consistent connected chains facing outward
   * (or opposing existing boundary faces when attached) so all spun quads share
   * uniform manifold winding.
   * @private
   */
  _orientSpinProfileEdges(em, profileEdges, pivotLocal, stepAngle, detachStep0) {
    if (!profileEdges || profileEdges.length === 0) return [];
    const vertToEdges = new Map();
    for (let i = 0; i < profileEdges.length; i++) {
      const [a, b] = profileEdges[i];
      if (!vertToEdges.has(a)) vertToEdges.set(a, []);
      if (!vertToEdges.has(b)) vertToEdges.set(b, []);
      vertToEdges.get(a).push(i);
      vertToEdges.get(b).push(i);
    }

    const visited = new Uint8Array(profileEdges.length);
    const oriented = new Array(profileEdges.length);
    const cosS = Math.cos(stepAngle);
    const sinS = Math.sin(stepAngle);

    for (let startIdx = 0; startIdx < profileEdges.length; startIdx++) {
      if (visited[startIdx]) continue;
      visited[startIdx] = 1;
      oriented[startIdx] = [profileEdges[startIdx][0], profileEdges[startIdx][1]];
      const queue = [startIdx];
      const compIndices = [];

      while (queue.length > 0) {
        const cur = queue.shift();
        compIndices.push(cur);
        const [cu, cv] = oriented[cur];
        for (const nextIdx of (vertToEdges.get(cv) || [])) {
          if (visited[nextIdx]) continue;
          const [na, nb] = profileEdges[nextIdx];
          oriented[nextIdx] = na === cv ? [na, nb] : [nb, na];
          visited[nextIdx] = 1;
          queue.push(nextIdx);
        }
        for (const prevIdx of (vertToEdges.get(cu) || [])) {
          if (visited[prevIdx]) continue;
          const [pa, pb] = profileEdges[prevIdx];
          oriented[prevIdx] = pb === cu ? [pa, pb] : [pb, pa];
          visited[prevIdx] = 1;
          queue.push(prevIdx);
        }
      }

      let boundaryVote = 0;
      if (!detachStep0) {
        for (const idx of compIndices) {
          const [u, v] = oriented[idx];
          const e = em.edgeMap.get(`${Math.min(u, v)}_${Math.max(u, v)}`);
          if (!e || e.faces.length !== 1) continue;
          const f = em.faces[e.faces[0]];
          if (!f) continue;
          for (let k = 0; k < f.verts.length; k++) {
            const fa = f.verts[k];
            const fb = f.verts[(k + 1) % f.verts.length];
            if (fa === u && fb === v) boundaryVote -= 1;
            else if (fa === v && fb === u) boundaryVote += 1;
          }
        }
      }

      let shouldFlip = boundaryVote < 0;
      if (boundaryVote === 0) {
        const compVerts = new Set();
        for (const idx of compIndices) {
          compVerts.add(oriented[idx][0]);
          compVerts.add(oriented[idx][1]);
        }
        let cx = 0; let cy = 0; let cz = 0;
        for (const vi of compVerts) {
          const p = em.vertices[vi];
          if (p) { cx += p.x; cy += p.y; cz += p.z; }
        }
        const invN = compVerts.size > 0 ? 1 / compVerts.size : 1;
        cx *= invN; cy *= invN; cz *= invN;

        let profileDot = 0; let radialDot = 0; let upDot = 0;
        for (const idx of compIndices) {
          const [u, v] = oriented[idx];
          const p0 = em.vertices[u];
          const p1 = em.vertices[v];
          if (!p0 || !p1) continue;
          const ex = p1.x - p0.x;
          const ey = p1.y - p0.y;
          const ez = p1.z - p0.z;
          let rx = p0.x - pivotLocal.x;
          let rz = p0.z - pivotLocal.z;
          let tx = (rx * cosS + rz * sinS) - rx;
          let tz = (-rx * sinS + rz * cosS) - rz;
          if (tx * tx + tz * tz < 1e-10) {
            rx = p1.x - pivotLocal.x;
            rz = p1.z - pivotLocal.z;
            tx = (rx * cosS + rz * sinS) - rx;
            tz = (-rx * sinS + rz * cosS) - rz;
          }
          const nx = ey * tz;
          const ny = ez * tx - ex * tz;
          const nz = -ey * tx;
          const mx = 0.5 * (p0.x + p1.x);
          const my = 0.5 * (p0.y + p1.y);
          const mz = 0.5 * (p0.z + p1.z);
          profileDot += nx * (mx - cx) + ny * (my - cy) + nz * (mz - cz);
          radialDot += nx * (mx - pivotLocal.x) + nz * (mz - pivotLocal.z);
          upDot += ny;
        }
        const vote = Math.abs(profileDot) > 1e-6
          ? profileDot
          : (Math.abs(radialDot) > 1e-6 ? radialDot : upDot);
        shouldFlip = vote < 0;
      }

      if (shouldFlip) {
        for (const idx of compIndices) {
          oriented[idx] = [oriented[idx][1], oriented[idx][0]];
        }
      }
    }

    return oriented;
  }

  /**
   * Spin / Lathe Mesh (Blender Spin Tool in Edit Mode or Object Mode)
   * Revolves selected vertices/edges/boundary (or half-profile if unselected) around
   * the 3D Cursor's Y-axis, welding the 360° closing seam and axis poles cleanly.
   */
  spinActiveMesh(steps = 16, angleDeg = 360) {
    const inEdit = Boolean(this.editMode?.isActive && this.editMode.targetMesh);
    const active = inEdit
      ? this.editMode.targetMesh
      : resolveEditableMesh(this.sceneManager.getActiveObject(), this.sceneManager);
    if (!active || !active.isMesh || !active.geometry) return;

    if (inEdit) {
      const em = this.editMode;
      const oldGeom = em.targetMesh.geometry.clone();
      const baseSnap = em._captureTopologySnapshot();
      const pivotLocal = this.cursorPosition
        ? active.worldToLocal(this.cursorPosition.clone())
        : new THREE.Vector3();

      const applyEditSpin = (s, deg, pushUndo) => {
        em._restoreTopologySnapshot(baseSnap);
        const nSteps = Math.max(3, Math.min(48, Math.round(Number(s) || 16)));
        const clampedDeg = Math.max(15, Math.min(360, Number(deg) || 360));
        const rad = clampedDeg * DEG2RAD;
        const isClosed = Math.abs(rad - Math.PI * 2) < 1e-4;

        // Gather profile edges + vertices from selection, else open boundary, else positive-X half profile
        let profileEdges = [];
        const profileVerts = new Set();

        if (em.selectionMode === 'edge' && em.selectedEdges.size > 0) {
          for (const eid of em.selectedEdges) {
            const e = em.edges[eid];
            if (e) {
              profileEdges.push([e.v0, e.v1]);
              profileVerts.add(e.v0);
              profileVerts.add(e.v1);
            }
          }
        } else if (em.selectionMode === 'face' && em.selectedFaces.size > 0) {
          const dirEdge = new Map();
          for (const fid of em.selectedFaces) {
            const f = em.faces[fid];
            if (!f) continue;
            for (let k = 0; k < f.verts.length; k++) {
              const u = f.verts[k];
              const v = f.verts[(k + 1) % f.verts.length];
              dirEdge.set(`${u}_${v}`, [u, v]);
            }
          }
          for (const [u, v] of dirEdge.values()) {
            if (!dirEdge.has(`${v}_${u}`)) {
              profileEdges.push([u, v]);
              profileVerts.add(u);
              profileVerts.add(v);
            }
          }
          if (profileEdges.length === 0) {
            for (const [u, v] of dirEdge.values()) {
              if (u < v) {
                profileEdges.push([u, v]);
                profileVerts.add(u);
                profileVerts.add(v);
              }
            }
          }
        } else if (em.selectionMode === 'vertex' && em.selectedVertices.size > 0) {
          em.selectedVertices.forEach(vi => profileVerts.add(vi));
          for (const e of em.edges) {
            if (profileVerts.has(e.v0) && profileVerts.has(e.v1)) {
              profileEdges.push([e.v0, e.v1]);
            }
          }
        }

        if (profileVerts.size === 0) {
          const openEdges = em.edges.filter(e => e.faces.length <= 1);
          const candidateEdges = openEdges.length > 0
            ? openEdges
            : em.edges.filter(e => {
                const p0 = em.vertices[e.v0];
                const p1 = em.vertices[e.v1];
                return p0 && p1 && (p0.x - pivotLocal.x >= -1e-4) && (p1.x - pivotLocal.x >= -1e-4);
              });
          for (const e of candidateEdges) {
            profileEdges.push([e.v0, e.v1]);
            profileVerts.add(e.v0);
            profileVerts.add(e.v1);
          }
        }

        if (profileVerts.size === 0) return;

        // Check radial distance to spin axis (Y through pivotLocal) so on-axis poles share 1 vertex
        const isPole = new Set();
        for (const vi of profileVerts) {
          const p = em.vertices[vi];
          const dx = p.x - pivotLocal.x;
          const dz = p.z - pivotLocal.z;
          if (dx * dx + dz * dz < 1e-8) isPole.add(vi);
        }

        // Only weld step 0 directly onto existing geometry when spinning open/loose
        // boundary edges (not 360° closed rings onto boundary edges, which would T-junction).
        const detachStep0 = profileEdges.length > 0 && profileEdges.every(([u, v]) => {
          const e = em.edgeMap.get(`${Math.min(u, v)}_${Math.max(u, v)}`);
          return e && e.faces.length >= (isClosed ? 1 : 2);
        });
        profileEdges = this._orientSpinProfileEdges(em, profileEdges, pivotLocal, rad / nSteps, detachStep0);
        const poleRingVert = new Map();
        const stepRings = [];
        for (let stepIdx = 0; stepIdx <= nSteps; stepIdx++) {
          if (stepIdx === 0 && !detachStep0) {
            const m0 = new Map();
            profileVerts.forEach(vi => {
              m0.set(vi, vi);
              if (isPole.has(vi)) poleRingVert.set(vi, vi);
            });
            stepRings.push(m0);
            continue;
          }
          if (isClosed && stepIdx === nSteps) {
            stepRings.push(stepRings[0]);
            continue;
          }
          const angle = stepIdx === 0 ? 0 : (stepIdx / nSteps) * rad;
          const cosA = Math.cos(angle);
          const sinA = Math.sin(angle);
          const m = new Map();
          for (const vi of profileVerts) {
            if (isPole.has(vi)) {
              if (!poleRingVert.has(vi)) {
                const pPole = em.vertices[vi];
                const poleIdx = em.vertices.length;
                em.vertices.push(pPole.clone());
                em.vertexUVs.push(em.vertexUVs[vi] ? em.vertexUVs[vi].clone() : null);
                poleRingVert.set(vi, poleIdx);
              }
              m.set(vi, poleRingVert.get(vi));
              continue;
            }
            const p = em.vertices[vi];
            const rx = p.x - pivotLocal.x;
            const rz = p.z - pivotLocal.z;
            const nx = pivotLocal.x + rx * cosA + rz * sinA;
            const nz = pivotLocal.z - rx * sinA + rz * cosA;
            const newIdx = em.vertices.length;
            em.vertices.push(new THREE.Vector3(nx, p.y, nz));
            em.vertexUVs.push(em.vertexUVs[vi] ? em.vertexUVs[vi].clone() : null);
            m.set(vi, newIdx);
          }
          stepRings.push(m);
        }

        const generatedVerts = new Set();
        const generatedFaceIds = [];
        if (profileEdges.length > 0) {
          for (let stepIdx = 0; stepIdx < nSteps; stepIdx++) {
            const r0 = stepRings[stepIdx];
            const r1 = stepRings[stepIdx + 1];
            for (const [u, v] of profileEdges) {
              const u0 = r0.get(u);
              const v0 = r0.get(v);
              const v1 = r1.get(v);
              const u1 = r1.get(u);
              let verts = null;
              if (u0 === u1 && v0 !== v1) {
                verts = [u0, v0, v1];
              } else if (v0 === v1 && u0 !== u1) {
                verts = [u0, v0, u1];
              } else if (new Set([u0, v0, v1, u1]).size >= 3) {
                verts = [u0, v0, v1, u1];
              }
              if (verts) {
                generatedFaceIds.push(em.faces.length);
                em.faces.push(em._createFaceRecord(em.faces.length, verts));
                verts.forEach(vi => generatedVerts.add(vi));
              }
            }
          }
        } else {
          // Pure vertex selection -> spin into loose edge curves
          for (let stepIdx = 0; stepIdx < nSteps; stepIdx++) {
            const r0 = stepRings[stepIdx];
            const r1 = stepRings[stepIdx + 1];
            for (const vi of profileVerts) {
              const a = r0.get(vi);
              const b = r1.get(vi);
              if (a !== b) {
                em.looseEdges.push([Math.min(a, b), Math.max(a, b)]);
                generatedVerts.add(a);
                generatedVerts.add(b);
              }
            }
          }
        }

        if (em.selectionMode === 'face' && generatedFaceIds.length > 0) {
          em.selectedFaces = new Set(generatedFaceIds);
        } else if (em.selectionMode === 'vertex') {
          em.selectedVertices = generatedVerts;
        }

        const prevSuppress = em._suppressUndo;
        em._suppressUndo = !pushUndo;
        em._commitMeshEdit(oldGeom, 'Spin / Lathe', true, baseSnap);
        em._suppressUndo = prevSuppress;
        if (!pushUndo) em._updateTopUndoCommand();
        this.sceneManager.requestRender();
      };

      applyEditSpin(steps, angleDeg, true);
      this._showAdjustMeshEditOp(
        'Spin / Lathe',
        [
          { key: 'steps', label: 'Steps', min: 3, max: 48, step: 1, default: steps },
          { key: 'angle', label: 'Angle (°)', min: 15, max: 360, step: 15, default: angleDeg }
        ],
        { steps, angle: angleDeg },
        (p) => applyEditSpin(p.steps, p.angle, false)
      );
      return;
    }

    const baseGeom = active.geometry.clone();
    const runObjectSpin = (s, deg) => {
      const nSteps = Math.max(3, Math.min(48, Math.round(Number(s) || 16)));
      const rad = ((Number(deg) || 360) * Math.PI) / 180;
      const clones = [];
      for (let i = 0; i < nSteps; i++) {
        const g = baseGeom.clone();
        g.rotateY((i / nSteps) * rad);
        clones.push(g);
      }
      const merged = mergeBufferGeometries(clones);
      active.geometry.dispose();
      active.geometry = merged;
      window.dispatchEvent(new CustomEvent('blender:geometryChanged', { detail: active }));
      this.sceneManager.requestRender();
    };

    runObjectSpin(steps, angleDeg);
    this._showAdjustMeshEditOp(
      'Spin / Lathe',
      [
        { key: 'steps', label: 'Steps', min: 3, max: 48, step: 1, default: steps },
        { key: 'angle', label: 'Angle (°)', min: 30, max: 360, step: 15, default: angleDeg }
      ],
      { steps, angle: angleDeg },
      (p) => runObjectSpin(p.steps, p.angle)
    );
  }

  /**
   * Smooth / Relax Vertices in Edit Mode (Blender Smooth Vertices)
   */
  smoothSelectedVertices(iterations = 2, factor = 0.5) {
    if (!this.editMode?.isActive || !this.editMode.targetMesh) return;
    const em = this.editMode;
    const oldGeom = em.targetMesh.geometry.clone();
    const oldSnap = em._captureTopologySnapshot();
    const baseVerts = em.vertices.map(v => v.clone());

    const runSmooth = (iters, fac, updateUndo = false) => {
      for (let i = 0; i < em.vertices.length; i++) {
        em.vertices[i].copy(baseVerts[i]);
      }
      const activeVerts = em.getActiveVertexIndices();
      const targetSet = activeVerts.size > 0 ? activeVerts : new Set(em.vertices.map((_, i) => i));

      const adj = new Map();
      for (const e of em.edges) {
        if (!adj.has(e.v0)) adj.set(e.v0, []);
        if (!adj.has(e.v1)) adj.set(e.v1, []);
        adj.get(e.v0).push(e.v1);
        adj.get(e.v1).push(e.v0);
      }

      for (let step = 0; step < Math.round(iters); step++) {
        const nextPos = new Map();
        for (const vIdx of targetSet) {
          const neighbors = adj.get(vIdx);
          if (!neighbors || neighbors.length === 0) continue;
          const avg = new THREE.Vector3();
          neighbors.forEach(n => avg.add(em.vertices[n]));
          avg.divideScalar(neighbors.length);
          nextPos.set(vIdx, new THREE.Vector3().lerpVectors(em.vertices[vIdx], avg, fac));
        }
        nextPos.forEach((pos, idx) => em.vertices[idx].copy(pos));
      }

      em.commitChanges(updateUndo);
      em.updateVisuals();
      this.sceneManager.requestRender();
    };

    runSmooth(iterations, factor, false);
    if (this.sceneManager) {
      const newGeom = em.targetMesh.geometry.clone();
      const newSnap = em._captureTopologySnapshot();
      this.sceneManager.executeCommand(new MeshEditCommand(
        em.targetMesh,
        oldGeom,
        newGeom,
        'Smooth Vertices',
        (mesh) => {
          if (!mesh || !em.isActive) return;
          em._buildTopology(mesh);
          em.updateVisuals();
        },
        {
          skipFirstUpdate: true,
          oldSnapshot: oldSnap,
          newSnapshot: newSnap,
          onRestoreSnapshot: (snap) => em._restoreTopologySnapshot(snap)
        }
      ));
    }

    this._showAdjustMeshEditOp(
      'Smooth Vertices',
      [
        { key: 'factor', label: 'Smoothing', min: 0.0, max: 1.0, step: 0.05, default: factor },
        { key: 'iterations', label: 'Repeat', min: 1, max: 15, step: 1, default: iterations }
      ],
      { factor, iterations },
      (p) => runSmooth(p.iterations, p.factor, true)
    );
  }

  /**
   * Boolean CSG Approximation (Union / Difference / Intersect) between 2 selected meshes
   */
  performBooleanOp(opType = 'difference') {
    const selected = this.sceneManager.getSelectedObjects().filter(o => o.isMesh && o.geometry);
    if (selected.length < 2) {
      this._notify('Shift-select 2 overlapping Mesh objects first (1st = Base, 2nd = Cutter) before running Boolean!', 'warning');
      return;
    }
    const target = selected[0];
    const cutter = selected[1];

    if (opType === 'union') {
      this.joinSelectedMeshes();
      return;
    }

    // Volumetric vertex-clipping & cavity stamping Boolean for interactive web modeling
    target.updateMatrixWorld(true);
    cutter.updateMatrixWorld(true);
    const cutterBoxWorld = new THREE.Box3().setFromObject(cutter);
    const cutterCenterWorld = cutterBoxWorld.getCenter(new THREE.Vector3());
    const cutterHalfSize = cutterBoxWorld.getSize(new THREE.Vector3()).multiplyScalar(0.5);

    // Ensure target has enough subdivisions so boolean cutout is clean
    let geom = target.geometry.index ? target.geometry.toNonIndexed() : target.geometry.clone();
    const pos = geom.attributes.position;
    const vWorld = new THREE.Vector3();

    for (let i = 0; i < pos.count; i++) {
      vWorld.fromBufferAttribute(pos, i).applyMatrix4(target.matrixWorld);
      const dx = vWorld.x - cutterCenterWorld.x;
      const dy = vWorld.y - cutterCenterWorld.y;
      const dz = vWorld.z - cutterCenterWorld.z;

      const inside = Math.abs(dx) <= cutterHalfSize.x &&
                     Math.abs(dy) <= cutterHalfSize.y &&
                     Math.abs(dz) <= cutterHalfSize.z;

      if (opType === 'difference' && inside) {
        // Push vertex onto the nearest interior face of the cutter volume
        const penX = cutterHalfSize.x - Math.abs(dx);
        const penY = cutterHalfSize.y - Math.abs(dy);
        const penZ = cutterHalfSize.z - Math.abs(dz);
        if (penX <= penY && penX <= penZ) {
          vWorld.x = cutterCenterWorld.x + Math.sign(dx || 1) * cutterHalfSize.x;
        } else if (penY <= penX && penY <= penZ) {
          vWorld.y = cutterCenterWorld.y + Math.sign(dy || 1) * cutterHalfSize.y;
        } else {
          vWorld.z = cutterCenterWorld.z + Math.sign(dz || 1) * cutterHalfSize.z;
        }
        target.worldToLocal(vWorld);
        pos.setXYZ(i, vWorld.x, vWorld.y, vWorld.z);
      } else if (opType === 'intersect' && !inside) {
        vWorld.x = THREE.MathUtils.clamp(vWorld.x, cutterBoxWorld.min.x, cutterBoxWorld.max.x);
        vWorld.y = THREE.MathUtils.clamp(vWorld.y, cutterBoxWorld.min.y, cutterBoxWorld.max.y);
        vWorld.z = THREE.MathUtils.clamp(vWorld.z, cutterBoxWorld.min.z, cutterBoxWorld.max.z);
        target.worldToLocal(vWorld);
        pos.setXYZ(i, vWorld.x, vWorld.y, vWorld.z);
      }
    }

    pos.needsUpdate = true;
    geom.computeVertexNormals();
    geom.computeBoundingBox();
    geom.computeBoundingSphere();

    target.geometry.dispose();
    target.geometry = geom;
    this.sceneManager.removeObject(cutter, true, true);
    this.sceneManager.select(target, false);

    if (target.userData.showWireframeOverlay || this.wireframeOverlayEnabled) {
      this._setMeshWireframeOverlay(target, true);
    }
    this.engine.updateSelectionHelper();
    this.sceneManager.requestRender();
  }

  // =========================================================================
  // 5. UPGRADE ADD MENU & CONTEXT-SENSITIVE LEFT TOOLBAR
  // =========================================================================

  _upgradeAddMenus() {
    const addDropdown = document.querySelector('#menu-add .menu-dropdown');
    if (!addDropdown) return;
    if (addDropdown.dataset.suiteBound === '1') return;
    addDropdown.dataset.suiteBound = '1';

    // Only inject fallback HTML when loaded against a non-canonical page without index.html's hierarchy.
    if (addDropdown.dataset.canonicalDom !== '1') {
      const primitiveListHtml = `
      <div class="dropdown-submenu">
        <div class="dropdown-item">
          <span>Mesh</span>
        </div>
        <div class="submenu-flyout">
          <div class="dropdown-item" data-spawn-prim="plane"><span>Plane</span></div>
          <div class="dropdown-item" data-spawn-prim="cube"><span>Cube</span></div>
          <div class="dropdown-item" data-spawn-prim="circle"><span>Circle</span></div>
          <div class="dropdown-item" data-spawn-prim="uv_sphere"><span>UV Sphere</span></div>
          <div class="dropdown-item" data-spawn-prim="ico_sphere"><span>Ico Sphere</span></div>
          <div class="dropdown-item" data-spawn-prim="cylinder"><span>Cylinder</span></div>
          <div class="dropdown-item" data-spawn-prim="cone"><span>Cone</span></div>
          <div class="dropdown-item" data-spawn-prim="torus"><span>Torus</span></div>
          <div class="dropdown-divider"></div>
          <div class="dropdown-item" data-spawn-prim="grid"><span>Grid</span></div>
          <div class="dropdown-item" data-spawn-prim="capsule"><span>Capsule</span></div>
          <div class="dropdown-item" data-spawn-prim="pipe"><span>Pipe / Tube</span></div>
          <div class="dropdown-item" data-spawn-prim="monkey"><span>Monkey (Suzanne)</span></div>
        </div>
      </div>

      <div class="dropdown-submenu">
        <div class="dropdown-item">
          <span>Curve</span>
        </div>
        <div class="submenu-flyout">
          <div class="dropdown-item" id="btn-add-curve-bezier"><span>Bezier Curve</span></div>
          <div class="dropdown-item" id="btn-add-curve-circle"><span>Bezier Circle</span></div>
          <div class="dropdown-item" id="btn-add-curve-path"><span>NURBS Path</span></div>
        </div>
      </div>

      <div class="dropdown-item" id="btn-add-text3d">
        <span>Text (3D)</span>
      </div>

      <div class="dropdown-submenu">
        <div class="dropdown-item">
          <span>Light</span>
        </div>
        <div class="submenu-flyout">
          <div class="dropdown-item" id="btn-add-point-light"><span>Point Light</span></div>
          <div class="dropdown-item" id="btn-add-dir-light"><span>Sun Light</span></div>
          <div class="dropdown-item" id="btn-add-spot-light"><span>Spot Light</span></div>
          <div class="dropdown-item" id="btn-add-area-light"><span>Area Light</span></div>
        </div>
      </div>

      <div class="dropdown-item" id="btn-add-camera">
        <span>Camera</span>
        <span class="shortcut">0 / Numpad 0</span>
      </div>

      <div class="dropdown-submenu">
        <div class="dropdown-item">
          <span>Image</span>
        </div>
        <div class="submenu-flyout">
          <div class="dropdown-item" id="btn-add-image-reference"><span>Reference</span></div>
          <div class="dropdown-item" id="btn-add-image-background"><span>Background</span></div>
          <div class="dropdown-item" id="btn-add-image-plane"><span>Mesh Plane</span></div>
        </div>
      </div>

      <div class="dropdown-divider"></div>

      <div class="dropdown-submenu">
        <div class="dropdown-item">
          <span>Character & Armature</span>
        </div>
        <div class="submenu-flyout">
          <div class="dropdown-item" id="btn-add-head-bust"><span>Human Head Bust</span></div>
          <div class="dropdown-item" id="btn-add-michelle"><span>Studio Athlete (CC0)</span></div>
          <div class="dropdown-item" id="btn-add-soldier"><span>Cyber Droid (CC0)</span></div>
          <div class="dropdown-item" id="btn-add-horse"><span>Mustang Horse — Gallop (CC0)</span></div>
          <div class="dropdown-item" id="btn-add-mannequin"><span>Articulated Mannequin</span></div>
          <div class="dropdown-divider"></div>
          <div class="dropdown-item" id="btn-add-armature"><span>Humanoid Standard Rig (22 Bones)</span></div>
          <div class="dropdown-item" id="btn-add-rig-humanoid-pro" data-skeleton-template="humanoid_pro"><span>Humanoid Pro Rig (56 Bones)</span></div>
          <div class="dropdown-item" id="btn-add-rig-quadruped" data-skeleton-template="quadruped"><span>Quadruped Animal Rig (Dog/Cat/Horse)</span></div>
          <div class="dropdown-item" id="btn-add-rig-bird" data-skeleton-template="bird"><span>Bird / Winged Creature Rig</span></div>
          <div class="dropdown-item" id="btn-add-rig-fish" data-skeleton-template="fish"><span>Fish / Aquatic Swimmer Rig</span></div>
          <div class="dropdown-item" id="btn-add-rig-serpent" data-skeleton-template="serpent"><span>Snake / Dragon Spine Rig</span></div>
          <div class="dropdown-item" id="btn-add-rig-arachnid" data-skeleton-template="arachnid"><span>Spider / Multi-Legged Mech Rig</span></div>
          <div class="dropdown-item" id="btn-add-rig-vehicle" data-skeleton-template="vehicle"><span>Vehicle / Rover &amp; Turret Rig</span></div>
          <div class="dropdown-divider"></div>
          <div class="dropdown-item" id="btn-bind-armature"><span>Auto-Rig / Bind Armature to Mesh</span></div>
        </div>
      </div>

      <div class="dropdown-divider"></div>
      <div class="dropdown-item" id="btn-add-hunyuan3d"><span>🖼️ Image to 3D (Bảo trì / Blueprint)...</span></div>
    `;
      addDropdown.innerHTML = primitiveListHtml;
    }

    const closeTopMenus = () => {
      document.querySelectorAll('.menu-item.open').forEach(m => m.classList.remove('open'));
    };

    const promptAndAddImage = (mode) => {
      closeTopMenus();
      let fileInput = document.getElementById('wbs-add-image-file-input');
      if (!fileInput) {
        fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.id = 'wbs-add-image-file-input';
        fileInput.accept = 'image/*';
        fileInput.multiple = true;
        fileInput.style.display = 'none';
        document.body.appendChild(fileInput);
      }
      fileInput.dataset.pendingMode = mode;
      fileInput.onchange = async () => {
        const selectedMode = fileInput.dataset.pendingMode || 'reference';
        const files = Array.from(fileInput.files || []);
        fileInput.value = '';
        for (let i = 0; i < files.length; i++) {
          try {
            const c = this.cursorPosition;
            const hasCursorOffset = c && (Math.abs(c.x) > 1e-4 || Math.abs(c.y) > 1e-4 || Math.abs(c.z) > 1e-4);
            await createImageObject({
              file: files[i],
              mode: selectedMode,
              align: selectedMode === 'background' ? 'front' : 'view',
              camera: this.engine?.camera || null,
              position: hasCursorOffset ? { x: c.x + i * 0.25, y: c.y + 1.5, z: c.z } : (i > 0 ? { x: i * 0.4, y: 1.5, z: -i * 0.1 } : null),
              sceneManager: this.sceneManager,
              scene: this.engine?.scene || null,
            });
            this.app?.codeEditor?.log?.('success', `✓ Added ${selectedMode} image: ${files[i].name}`);
          } catch (err) {
            console.error('[AddImage] Failed:', err);
            this.app?.codeEditor?.log?.('error', `Failed to load image ${files[i].name}: ${err.message}`);
          }
        }
      };
      fileInput.click();
    };

    addDropdown.querySelectorAll('[data-spawn-prim]').forEach((item) => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        const type = item.getAttribute('data-spawn-prim');
        closeTopMenus();
        this.spawnPrimitive(type);
      });
    });

    const addCurveOrText = (obj) => {
      closeTopMenus();
      if (!obj) return;
      if (this.cursorPosition && (Math.abs(this.cursorPosition.x) > 1e-4 || Math.abs(this.cursorPosition.y) > 1e-4 || Math.abs(this.cursorPosition.z) > 1e-4)) {
        obj.position.copy(this.cursorPosition);
      }
      this.sceneManager?.addObject(obj);
      this.sceneManager?.select(obj);
      this.engine?.render?.();
    };
    const bindCurveBtn = (id, factory) => {
      const btn = document.getElementById(id);
      if (!btn || btn.dataset.curveBound) return;
      btn.dataset.curveBound = '1';
      btn.addEventListener('click', () => addCurveOrText(factory()));
    };
    bindCurveBtn('btn-add-curve-bezier', () => createBezierCurveObject('bezier'));
    bindCurveBtn('btn-add-curve-circle', () => createBezierCurveObject('circle'));
    bindCurveBtn('btn-add-curve-path', () => createBezierCurveObject('path'));
    bindCurveBtn('btn-add-text3d', () => createText3DObject('STUDIO'));

    // Re-bind light/camera/image/character buttons in #menu-add
    document.getElementById('btn-add-point-light')?.addEventListener('click', () => { closeTopMenus(); this.studio?.addLight({ type: 'point', x: 2, y: 5, z: 2 }); });
    document.getElementById('btn-add-dir-light')?.addEventListener('click', () => { closeTopMenus(); this.studio?.addLight({ type: 'directional', x: 5, y: 10, z: 5 }); });
    document.getElementById('btn-add-spot-light')?.addEventListener('click', () => { closeTopMenus(); this.studio?.addLight({ type: 'spot', x: 0, y: 8, z: 0 }); });
    document.getElementById('btn-add-area-light')?.addEventListener('click', () => { closeTopMenus(); this.studio?.addLight({ type: 'area', x: 0, y: 6, z: 4, intensity: 4 }); });
    document.getElementById('btn-add-camera')?.addEventListener('click', () => {
      closeTopMenus();
      const cam = this.app.cameraManager?.createCamera({ position: { x: 6, y: 4, z: 8 }, target: { x: 0, y: 1, z: 0 } });
      if (cam) {
        this.app.inspector?.setTargetObject?.(cam);
        this.app.codeEditor?.log?.('info', `📷 Added camera [${cam.name}]. Press 0 (or Numpad 0) to view through camera.`);
      }
    });
    document.getElementById('btn-add-image-reference')?.addEventListener('click', () => promptAndAddImage('reference'));
    document.getElementById('btn-add-image-background')?.addEventListener('click', () => promptAndAddImage('background'));
    document.getElementById('btn-add-image-plane')?.addEventListener('click', () => promptAndAddImage('plane'));
    document.getElementById('btn-add-armature')?.addEventListener('click', () => { closeTopMenus(); this.studio?.createSkeletonTemplate?.('humanoid_standard', { height: 1.72, y: 0 }) || this.studio?.createHumanoidArmature({ height: 1.8, y: 0 }); });
    addDropdown.querySelectorAll('[data-skeleton-template]').forEach((item) => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        const tplId = item.getAttribute('data-skeleton-template');
        closeTopMenus();
        const res = this.studio?.createSkeletonTemplate?.(tplId, { y: 0 });
        if (res?.armatureGroup) {
          this.sceneManager?.select(res.armatureGroup);
          this.engine?.focusOn?.(res.armatureGroup);
          this.app?.codeEditor?.log?.('info', `Added skeleton template [${res.template?.name || tplId}] (${res.bones?.length || 0} bones).`);
        }
      });
    });
    document.getElementById('btn-add-mannequin')?.addEventListener('click', () => { closeTopMenus(); this.studio?.createRiggedMannequin({ height: 1.8, y: 0 }); });
    document.getElementById('btn-add-head-bust')?.addEventListener('click', async () => {
      closeTopMenus();
      const head = await this.studio?.createRealisticHuman({ type: 'head_scan', y: 0.2, scale: 1.0 });
      if (head) {
        let headMesh = null;
        head.traverse((c) => { if (c.isMesh && !headMesh) headMesh = c; });
        this.sceneManager.select(headMesh || head);
        if (headMesh) this.engine?.focusOn?.(headMesh);
      }
    });
    document.getElementById('btn-add-michelle')?.addEventListener('click', async () => {
      closeTopMenus();
      const char = await this.studio?.createRealisticHuman({ type: 'female', y: 0.1 });
      if (char) this.sceneManager.select(char);
    });
    document.getElementById('btn-add-soldier')?.addEventListener('click', async () => {
      closeTopMenus();
      const soldier = await this.studio?.loadGLTF('/models/Bot_CC0.glb', { y: 0.0, scale: 1.0, name: 'Bot_Character' });
      if (soldier) this.sceneManager.select(soldier);
    });
    document.getElementById('btn-add-horse')?.addEventListener('click', async () => {
      closeTopMenus();
      const horse = await this.studio?.loadGLTF('/models/Horse_CC0.glb', { y: 0.0, scale: 1.0, name: 'Mustang_Horse_CC0' });
      if (horse) {
        this.sceneManager.select(horse);
        const clip = horse.animations?.find((c) => /gallop/i.test(c.name)) || horse.animations?.[0];
        const timeline = this.app?.timelineEngine || (typeof window !== 'undefined' ? window.timelineEngine : null);
        if (clip && timeline?.attachClip) {
          timeline.attachClip(horse, clip, { loop: true });
          timeline.play?.();
        }
      }
    });
    document.getElementById('btn-bind-armature')?.addEventListener('click', () => {
      closeTopMenus();
      const active = this.sceneManager.getActiveObject();
      if (!active) {
        this._notify('Select a Mesh or Character Group before Auto-Rigging / Binding.', 'warning');
        return;
      }
      // If a standalone armature already exists in scene and user selected a single Mesh, bind to it;
      // otherwise run silhouette-fitted Auto-Rig Character cleanly.
      const mesh = resolveEditableMesh(active, this.sceneManager);
      const hasActiveSkel = Boolean(window.rigSystem?.activeSkeleton?.bones?.length);
      if (mesh && hasActiveSkel && active.isMesh) {
        const skinned = this.studio?.autoSkinMesh(mesh);
        if (skinned) this.sceneManager.select(skinned);
        return;
      }
      const rigged = this.studio?.autoRigCharacter?.(active, { templateId: 'humanoid_pro', mode: 'heat' });
      if (rigged?.character) {
        this.sceneManager.select(rigged.character);
        this.app?.codeEditor?.log?.('success', `Auto-Rigged "${rigged.character.name}" (${rigged.quality?.boneCount || 56} bones, ${rigged.silhouette?.detectedPose || 'Standard'}).`);
      } else if (mesh) {
        const skinned = this.studio?.autoSkinMesh(mesh);
        if (skinned) this.sceneManager.select(skinned);
      } else {
        this._notify('Select a Mesh object before binding an Armature.', 'warning');
      }
    });
    document.getElementById('btn-add-hunyuan3d')?.addEventListener('click', () => {
      closeTopMenus();
      const tab = document.querySelector('.dock-tab[data-pane="dock-hunyuan3d"]');
      if (tab) tab.click();
      this.app?.codeEditor?.log?.('info', '🖼️ Opening Image to 3D panel...');
    });
  }

  _upgradeLeftToolbar() {
    const toolbar = document.querySelector('aside.blender-toolbar');
    if (!toolbar) return;
    if (toolbar.dataset.suiteBound === '1') return;
    toolbar.dataset.suiteBound = '1';

    if (toolbar.dataset.canonicalDom !== '1') {
      toolbar.innerHTML = `
      <!-- Core Transform & Cursor Tools (Always visible) -->
      <div class="tool-group">
        <button class="tool-btn active" id="tool-select" data-tooltip="Select Box (W)">
          <svg viewBox="0 0 24 24"><path d="M7 2l12 11.2-5.8.5 3.3 7.3-2.2 1-3.2-7.4L7 18.5V2z"/></svg>
        </button>
        <button class="tool-btn" id="tool-cursor" data-tooltip="3D Cursor (Click to place • Shift+C reset to Origin)">
          <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="3 2"/><circle cx="12" cy="12" r="2"/><path d="M12 1v4M12 19v4M1 12h4M19 12h4" stroke="currentColor" stroke-width="1.8"/></svg>
        </button>
      </div>

      <div class="tool-group-divider"></div>

      <div class="tool-group">
        <button class="tool-btn" id="tool-move" data-tooltip="Move (G)">
          <svg viewBox="0 0 24 24"><path d="M12 2l4 4h-3v5h5V8l4 4-4 4v-3h-5v5h3l-4 4-4-4h3v-5H6v3l-4-4 4-4v3h5V6H8l4-4z"/></svg>
        </button>
        <button class="tool-btn" id="tool-rotate" data-tooltip="Rotate (R)">
          <svg viewBox="0 0 24 24"><path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"/></svg>
        </button>
        <button class="tool-btn" id="tool-scale" data-tooltip="Scale (S)">
          <svg viewBox="0 0 24 24"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V5h14v14zM7 7h4v4H7zm6 6h4v4h-4z"/></svg>
        </button>
        <button class="tool-btn" id="tool-measure" data-tooltip="Measure (Drag to measure distance in meters)">
          <svg viewBox="0 0 24 24"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1.003 1.003 0 0 0 0-1.42l-2.34-2.34a1.003 1.003 0 0 0-1.42 0l-1.83 1.83 3.75 3.75 1.84-1.82z"/></svg>
        </button>
      </div>

      <!-- EDIT MODE TOOLS: Shown only when in Edit Mode -->
      <div class="tool-group" id="toolbar-group-edit" style="display: none;">
        <div class="tool-group-divider"></div>
        <button class="tool-btn" id="tb-edit-extrude" data-tooltip="Extrude Region (E)">
          <svg viewBox="0 0 24 24"><path d="M12 2l5 5h-3v6h-4V7H7l5-5zm-7 13h14v6H5v-6z"/></svg>
        </button>
        <button class="tool-btn" id="tb-edit-inset" data-tooltip="Inset Faces (I)">
          <svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"/><rect x="7" y="7" width="10" height="10" fill="currentColor" opacity="0.7"/></svg>
        </button>
        <button class="tool-btn" id="tb-edit-bevel" data-tooltip="Bevel (Ctrl+B)">
          <svg viewBox="0 0 24 24"><polygon points="8 3 16 3 21 8 21 16 16 21 8 21 3 16 3 8" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>
        </button>
        <button class="tool-btn" id="tb-edit-loopcut" data-tooltip="Loop Cut (Ctrl+R)">
          <svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" fill="none" stroke="currentColor" stroke-width="1.6"/><line x1="12" y1="2" x2="12" y2="22" stroke="currentColor" stroke-width="2.2"/></svg>
        </button>
        <button class="tool-btn" id="tb-edit-subdivide" data-tooltip="Subdivide">
          <svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"/><line x1="12" y1="3" x2="12" y2="21" stroke="currentColor" stroke-width="1.5"/><line x1="3" y1="12" x2="21" y2="12" stroke="currentColor" stroke-width="1.5"/></svg>
        </button>
        <button class="tool-btn" id="tb-edit-spin" data-tooltip="Spin / Lathe 360°">
          <svg viewBox="0 0 24 24"><path d="M12 3a9 9 0 1 0 9 9h-2a7 7 0 1 1-7-7V3z"/></svg>
        </button>
        <button class="tool-btn" id="tb-edit-smooth" data-tooltip="Smooth Vertices">
          <svg viewBox="0 0 24 24"><path d="M3 17c4-8 14-8 18 0" fill="none" stroke="currentColor" stroke-width="2.2"/></svg>
        </button>
        <button class="tool-btn" id="tb-edit-merge" data-tooltip="Merge at Center (M)">
          <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M4 4l5 5M20 4l-5 5M4 20l5-5M20 20l-5-5" stroke="currentColor" stroke-width="1.8"/></svg>
        </button>
        <button class="tool-btn" id="tb-edit-delete" data-tooltip="Delete Geometry (X)">
          <svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
        </button>
      </div>

      <div class="tool-group" style="margin-top: auto;">
        <button class="tool-btn" id="tool-npanel-toggle" data-tooltip="Toggle Sidebar (N)">
          <span style="font-weight: 700; font-size: 11px;">N</span>
        </button>
        <button class="tool-btn" id="tool-ai-fab" data-tooltip="AI Copilot 3D (Ctrl+Space)">
          <svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 1010 10A10 10 0 0012 2zm1 14.5h-2v-2h2zm0-4h-2V7h2z"/></svg>
        </button>
      </div>
    `;
    }

    // Bind core tool buttons
    const setActiveToolBtn = (id) => {
      ['tool-select', 'tool-cursor', 'tool-move', 'tool-rotate', 'tool-scale', 'tool-measure'].forEach((btnId) => {
        document.getElementById(btnId)?.classList.toggle('active', btnId === id);
      });
    };

    document.getElementById('tool-select')?.addEventListener('click', () => {
      this.activeTool = 'select';
      this._clearMeasure();
      setActiveToolBtn('tool-select');
      this.engine.setTransformMode('translate');
    });

    document.getElementById('tool-cursor')?.addEventListener('click', () => {
      this.activeTool = 'cursor';
      this._clearMeasure();
      setActiveToolBtn('tool-cursor');
    });

    document.getElementById('tool-move')?.addEventListener('click', () => {
      this.activeTool = 'move';
      this._clearMeasure();
      setActiveToolBtn('tool-move');
      this.engine.setTransformMode('translate');
    });

    document.getElementById('tool-rotate')?.addEventListener('click', () => {
      this.activeTool = 'rotate';
      this._clearMeasure();
      setActiveToolBtn('tool-rotate');
      this.engine.setTransformMode('rotate');
    });

    document.getElementById('tool-scale')?.addEventListener('click', () => {
      this.activeTool = 'scale';
      this._clearMeasure();
      setActiveToolBtn('tool-scale');
      this.engine.setTransformMode('scale');
    });

    document.getElementById('tool-measure')?.addEventListener('click', () => {
      this.activeTool = 'measure';
      setActiveToolBtn('tool-measure');
    });

    // Bind primitive spawn buttons
    toolbar.querySelectorAll('[data-spawn-prim]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.spawnPrimitive(btn.getAttribute('data-spawn-prim'));
      });
    });

    // Blur mouse-clicked toolbar buttons immediately so viewport shortcuts (Tab, G/R/S) keep working
    toolbar.addEventListener('click', (e) => {
      const btn = e.target?.closest?.('button');
      if (btn && e.detail > 0) btn.blur();
    });

    // Bind Edit Mode toolbar buttons with F9 live parameter adjustment!
    document.getElementById('tb-edit-extrude')?.addEventListener('click', () => this.runExtrudeWithAdjust());
    document.getElementById('tb-edit-inset')?.addEventListener('click', () => this.runInsetWithAdjust());
    document.getElementById('tb-edit-bevel')?.addEventListener('click', () => this.runBevelWithAdjust());
    document.getElementById('tb-edit-loopcut')?.addEventListener('click', () => this.runLoopCutWithAdjust());
    document.getElementById('tb-edit-subdivide')?.addEventListener('click', () => {
      this.editMode?.subdivide();
    });
    document.getElementById('tb-edit-spin')?.addEventListener('click', () => this.spinActiveMesh(16, 360));
    document.getElementById('tb-edit-smooth')?.addEventListener('click', () => this.smoothSelectedVertices(2, 0.5));
    document.getElementById('tb-edit-merge')?.addEventListener('click', () => this.editMode?.merge('center'));
    document.getElementById('tb-edit-delete')?.addEventListener('click', () => this.editMode?.deleteSelection());

    document.getElementById('tool-npanel-toggle')?.addEventListener('click', () => this.toggleNPanel());
    document.getElementById('tool-ai-fab')?.addEventListener('click', () => this.app.aiCopilot?.toggle());
  }

  runExtrudeWithAdjust(initialAmount = 0.5) {
    if (!this.editMode?.isActive || !this.editMode.targetMesh) return;
    const em = this.editMode;
    const prePositions = new Map();
    const selBefore = Array.from(em.getActiveVertexIndices());
    if (selBefore.length === 0) return;

    // Extrude with a guaranteed non-zero probe step to record exact per-vertex direction
    const probeDist = Math.abs(initialAmount) > 1e-3 ? initialAmount : 0.5;
    const preSnap = em._captureTopologySnapshot();
    em._lastExtrudeData = null;
    em.extrude(probeDist);

    const selVerts = Array.from(em.getActiveVertexIndices());
    if (selVerts.length === 0) return;

    const fallbackNorm = new THREE.Vector3();
    for (const fIdx of em.selectedFaces) {
      const f = em.faces[fIdx];
      if (f?.normal) fallbackNorm.add(f.normal);
    }
    if (fallbackNorm.lengthSq() < 1e-6) fallbackNorm.set(0, 1, 0);
    else fallbackNorm.normalize();

    const exactMap = em._lastExtrudeData instanceof Map ? em._lastExtrudeData : null;
    const basePositions = new Map();
    const vertDirs = new Map();
    for (const vIdx of selVerts) {
      const pPost = em.vertices[vIdx];
      if (!pPost) continue;
      const exact = exactMap?.get(vIdx);
      if (exact?.base && exact?.dir) {
        basePositions.set(vIdx, exact.base.clone());
        vertDirs.set(vIdx, exact.dir.clone());
        if (probeDist !== initialAmount) {
          em.vertices[vIdx].copy(exact.base).addScaledVector(exact.dir, initialAmount);
        }
        continue;
      }
      // Match original vertex normal if radial extrude, else coherent face normal
      let dir = fallbackNorm.clone();
      if (vIdx < preSnap.vertices.length) {
        dir = new THREE.Vector3().subVectors(pPost, preSnap.vertices[vIdx]);
        if (dir.lengthSq() > 1e-8) dir.normalize();
        else dir = fallbackNorm.clone();
      } else {
        // Extruded vertex corresponds to nearest original vertex from selBefore
        let bestOrig = null;
        let bestD = Infinity;
        for (const ov of selBefore) {
          const d = pPost.distanceToSquared(preSnap.vertices[ov]);
          if (d < bestD) { bestD = d; bestOrig = preSnap.vertices[ov]; }
        }
        if (bestOrig) {
          const delta = new THREE.Vector3().subVectors(pPost, bestOrig);
          if (delta.lengthSq() > 1e-8) dir = delta.normalize();
        }
      }
      basePositions.set(vIdx, pPost.clone().addScaledVector(dir, -probeDist));
      vertDirs.set(vIdx, dir);
      if (probeDist !== initialAmount) {
        em.vertices[vIdx].copy(basePositions.get(vIdx)).addScaledVector(dir, initialAmount);
      }
    }
    if (probeDist !== initialAmount) {
      em.commitChanges(true);
      em.updateVisuals();
      this.sceneManager.requestRender();
    }

    this._showAdjustMeshEditOp(
      'Extrude Region',
      [{ key: 'offset', label: 'Offset Z (m)', min: -5.0, max: 5.0, step: 0.05, default: initialAmount }],
      { offset: initialAmount },
      (p) => {
        basePositions.forEach((basePos, vIdx) => {
          if (em.vertices[vIdx]) {
            em.vertices[vIdx].copy(basePos).addScaledVector(vertDirs.get(vIdx) || fallbackNorm, p.offset);
          }
        });
        em.commitChanges(true);
        em.updateVisuals();
        this.sceneManager.requestRender();
      }
    );
  }

  runInsetWithAdjust(initialThickness = 0.25) {
    if (!this.editMode?.isActive || !this.editMode.targetMesh) return;
    const em = this.editMode;
    const baseSnap = em._captureTopologySnapshot();

    em.inset(initialThickness);

    this._showAdjustMeshEditOp(
      'Inset Faces',
      [
        { key: 'thickness', label: 'Thickness', min: 0.02, max: 0.9, step: 0.02, default: initialThickness },
        { key: 'depth', label: 'Depth (m)', min: -2.0, max: 2.0, step: 0.05, default: 0.0 }
      ],
      { thickness: initialThickness, depth: 0.0 },
      (p) => {
        if (!em.isActive || !em.targetMesh) return;
        em._restoreTopologySnapshot(baseSnap);
        const prevSuppress = em._suppressUndo;
        em._suppressUndo = true;
        em.inset(p.thickness);
        em._suppressUndo = prevSuppress;

        if (Math.abs(p.depth) > 1e-4) {
          const avgN = new THREE.Vector3();
          const movedVerts = new Set();
          for (const fIdx of em.selectedFaces) {
            const f = em.faces[fIdx];
            if (!f) continue;
            avgN.add(f.normal);
            f.verts.forEach(vi => movedVerts.add(vi));
          }
          if (avgN.lengthSq() > 1e-6) {
            avgN.normalize();
            movedVerts.forEach(vi => {
              if (em.vertices[vi]) em.vertices[vi].addScaledVector(avgN, p.depth);
            });
          }
        }
        em.commitChanges(true);
        em.updateVisuals();
        this.sceneManager.requestRender();
      }
    );
  }

  runBevelWithAdjust(initialOffset = 0.08, initialSegments = 2) {
    if (!this.editMode?.isActive || !this.editMode.targetMesh) return;
    const em = this.editMode;
    const baseSnap = em._captureTopologySnapshot();

    em.bevel(initialOffset, initialSegments);

    this._showAdjustMeshEditOp(
      'Bevel Edges',
      [
        { key: 'width', label: 'Width (m)', min: 0.01, max: 0.6, step: 0.01, default: initialOffset },
        { key: 'segments', label: 'Segments', min: 1, max: 8, step: 1, default: initialSegments }
      ],
      { width: initialOffset, segments: initialSegments },
      (p) => {
        if (!em.isActive || !em.targetMesh) return;
        em._restoreTopologySnapshot(baseSnap);
        const prevSuppress = em._suppressUndo;
        em._suppressUndo = true;
        em.bevel(p.width, p.segments);
        em._suppressUndo = prevSuppress;
        em._updateTopUndoCommand();
        this.sceneManager.requestRender();
      }
    );
  }

  runLoopCutWithAdjust(edgeIndex = null, initialCuts = 1, initialSlide = 0) {
    if (!this.editMode?.isActive || !this.editMode.targetMesh) return;
    const em = this.editMode;
    let targetEdge = edgeIndex;
    if (targetEdge === null || targetEdge === undefined) {
      targetEdge = em.selectedEdges.size > 0
        ? em.selectedEdges.values().next().value
        : (em.edges.find(e => e.faces.some(fid => em.faces[fid]?.verts.length === 4))?.id ?? 0);
    }

    const baseSnap = em._captureTopologySnapshot();
    const ok = em.loopCut(targetEdge, initialCuts, initialSlide);
    if (!ok) return;

    this._showAdjustMeshEditOp(
      'Loop Cut & Slide',
      [
        { key: 'cuts', label: 'Number of Cuts', min: 1, max: 12, step: 1, default: initialCuts },
        { key: 'slide', label: 'Factor / Slide', min: -0.95, max: 0.95, step: 0.05, default: initialSlide }
      ],
      { cuts: initialCuts, slide: initialSlide },
      (p) => {
        if (!em.isActive || !em.targetMesh) return;
        em._restoreTopologySnapshot(baseSnap);
        const prevSuppress = em._suppressUndo;
        em._suppressUndo = true;
        em.loopCut(targetEdge, p.cuts, p.slide);
        em._suppressUndo = prevSuppress;
        em._updateTopUndoCommand();
        this.sceneManager.requestRender();
      }
    );
  }

  // =========================================================================
  // 6. VIEWPORT HEADER GIZMO CONTROLS & DROPDOWN MENUS (View, Select, Add, Object/Mesh)
  // =========================================================================

  _injectViewportHeaderControls() {
    const headerRight = document.querySelector('.viewport-header-right');
    if (!headerRight) return;

    const bar = document.createElement('div');
    bar.className = 'b-vp-tools-bar';
    bar.innerHTML = `
      <select id="vp-transform-space" class="b-vp-select" title="Transform Orientation (Global / Local / Normal / Gimbal / View / Cursor)">
        <option value="world" selected>Global</option>
        <option value="local">Local</option>
        <option value="normal">Normal</option>
        <option value="gimbal">Gimbal</option>
        <option value="view">View</option>
        <option value="cursor">Cursor</option>
      </select>
      <button type="button" class="viewport-nav-btn" id="btn-vp-snap" title="Snap to Grid / Rotation 15° (Shift+Tab)">Snap</button>
      <button type="button" class="viewport-nav-btn" id="btn-vp-wire-overlay" title="Wireframe Overlay on Solid">Wire</button>
      <button type="button" class="viewport-nav-btn" id="btn-vp-xray" title="Toggle X-Ray (Alt+Z)">X-Ray</button>
    `;
    headerRight.insertBefore(bar, headerRight.firstChild);

    document.getElementById('vp-transform-space')?.addEventListener('change', (e) => {
      this.transformSpace = e.target.value;
      const tcSpace = (this.transformSpace === 'world' || this.transformSpace === 'view') ? 'world' : 'local';
      this.engine.transformControls?.setSpace(tcSpace);
    });

    document.getElementById('btn-vp-snap')?.addEventListener('click', (e) => {
      this.snapEnabled = !this.snapEnabled;
      if (this.engine) this.engine.snapEnabled = this.snapEnabled;
      const tc = this.engine.transformControls;
      if (tc) {
        tc.setTranslationSnap(this.snapEnabled ? 0.5 : null);
        tc.setRotationSnap(this.snapEnabled ? THREE.MathUtils.degToRad(15) : null);
        tc.setScaleSnap(this.snapEnabled ? 0.1 : null);
      }
      e.currentTarget.classList.toggle('active', this.snapEnabled);
    });

    document.getElementById('btn-vp-wire-overlay')?.addEventListener('click', () => {
      this.toggleGlobalWireframeOverlay();
    });

    document.getElementById('btn-vp-xray')?.addEventListener('click', () => {
      this.toggleXRayMode();
    });

    // Update top shading popover active button to "Studio" so it matches our clean Solid Clay default
    document.querySelectorAll('#shading-lighting-type .popover-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.type === 'studio');
    });
    const activeMatcapName = document.getElementById('matcap-active-name');
    if (activeMatcapName) activeMatcapName.textContent = 'Blender Solid Gray';
  }

  _createViewportDropdownMenus() {
    // Floating menu container for View / Select / Add / Object-Mesh buttons in viewport header
    const popMenu = document.createElement('div');
    popMenu.id = 'b-vp-dropdown-menu';
    popMenu.className = 'b-context-menu';
    popMenu.style.display = 'none';
    document.body.appendChild(popMenu);
    this.vpDropdownEl = popMenu;

    const openMenuUnder = (btn, items) => {
      const rect = btn.getBoundingClientRect();
      this._populateMenu(this.vpDropdownEl, items);
      this.vpDropdownEl.style.display = 'block';
      this.vpDropdownEl.style.left = `${rect.left}px`;
      this.vpDropdownEl.style.top = `${rect.bottom + 4}px`;
    };

    document.getElementById('btn-vp-view')?.addEventListener('click', (e) => {
      e.stopPropagation();
      openMenuUnder(e.currentTarget, this._getViewMenuItems());
    });

    document.getElementById('btn-vp-select')?.addEventListener('click', (e) => {
      e.stopPropagation();
      openMenuUnder(e.currentTarget, this._getSelectMenuItems());
    });

    document.getElementById('btn-vp-add')?.addEventListener('click', (e) => {
      e.stopPropagation();
      openMenuUnder(e.currentTarget, this._getAddMenuItems());
    });

    document.getElementById('btn-vp-object')?.addEventListener('click', (e) => {
      e.stopPropagation();
      openMenuUnder(e.currentTarget, this.editMode?.isActive ? this._getEditMeshMenuItems() : this._getObjectMenuItems());
    });
  }

  _getViewMenuItems() {
    return [
      { label: 'Frame Selected', shortcut: 'Numpad .', action: () => this.engine.focusSelection() },
      { label: 'Frame All', shortcut: 'Home', action: () => this.engine.setCameraPreset('isometric') },
      { label: 'Perspective / Orthographic', shortcut: 'Numpad 5', action: () => this.engine.toggleProjection() },
      { divider: true },
      {
        label: 'Viewpoint',
        children: [
          { label: 'Top', shortcut: 'Numpad 7', action: () => this.engine.setCameraPreset('top') },
          { label: 'Bottom', shortcut: 'Ctrl+Num 7', action: () => this.engine.setCameraPreset('bottom') },
          { label: 'Front', shortcut: 'Numpad 1', action: () => this.engine.setCameraPreset('front') },
          { label: 'Back', shortcut: 'Ctrl+Num 1', action: () => this.engine.setCameraPreset('back') },
          { label: 'Right', shortcut: 'Numpad 3', action: () => this.engine.setCameraPreset('right') },
          { label: 'Left', shortcut: 'Ctrl+Num 3', action: () => this.engine.setCameraPreset('left') },
          { divider: true },
          { label: 'Active Camera', shortcut: 'Numpad 0', action: () => document.getElementById('btn-toggle-camera-view')?.click() }
        ]
      },
      { divider: true },
      {
        label: 'Area (Split / Join / Quad)',
        children: [
          { label: 'Vertical Split (Left | Right)', action: () => this.app?.areaManager?.splitLeaf?.(this.app.areaManager.getActiveLeafId(), 'vertical', 0.5) },
          { label: 'Horizontal Split (Top / Bottom)', action: () => this.app?.areaManager?.splitLeaf?.(this.app.areaManager.getActiveLeafId(), 'horizontal', 0.5) },
          { label: 'Toggle Quad View', shortcut: 'Ctrl+Alt+Q', action: () => this.app?.areaManager?.toggleQuadView?.() },
          { label: 'Reset Single Viewport', action: () => this.app?.areaManager?.resetToSingleViewport?.() }
        ]
      },
      { divider: true },
      { label: 'Toggle Sidebar', shortcut: 'N', action: () => this.toggleNPanel() },
      { label: 'Toggle Toolbar', shortcut: 'T', action: () => {
        const tb = document.querySelector('.blender-toolbar');
        if (tb) tb.style.display = tb.style.display === 'none' ? 'flex' : 'none';
      }},
      { label: 'Center 3D Cursor', shortcut: 'Shift+C', action: () => this.setCursorPosition(0, 0, 0) }
    ];
  }

  _getSelectMenuItems() {
    if (this.editMode?.isActive) {
      return [
        { label: 'All', shortcut: 'A', action: () => this.editMode.selectAll() },
        { label: 'None', shortcut: 'Alt+A', action: () => this.editMode.deselectAll() },
        { label: 'Select Linked', shortcut: 'Ctrl+L', action: () => this.editMode.selectLinked() },
        { divider: true },
        { label: 'Vertex Select', shortcut: '1', action: () => this.editMode.setMode('vertex') },
        { label: 'Edge Select', shortcut: '2', action: () => this.editMode.setMode('edge') },
        { label: 'Face Select', shortcut: '3', action: () => this.editMode.setMode('face') }
      ];
    }
    return [
      { label: 'All', shortcut: 'A', action: () => {
        const all = this.sceneManager.getSelectableObjects().filter(o => o.parent === this.sceneManager.rootContainer);
        this.sceneManager.setSelection(all);
      }},
      { label: 'None', shortcut: 'Alt+A', action: () => this.sceneManager.clearSelection() },
      { label: 'Invert', shortcut: 'Ctrl+I', action: () => {
        const cur = new Set(this.sceneManager.getSelectedObjects());
        const all = this.sceneManager.getSelectableObjects().filter(o => o.parent === this.sceneManager.rootContainer);
        this.sceneManager.setSelection(all.filter(o => !cur.has(o)));
      }},
      { divider: true },
      { label: 'Select All by Type (Mesh)', action: () => {
        const meshes = this.sceneManager.getSelectableObjects().filter(o => o.isMesh);
        this.sceneManager.setSelection(meshes);
      }}
    ];
  }

  _getAddMenuItems() {
    return [
      {
        label: 'Mesh',
        children: [
          { label: 'Plane', action: () => this.spawnPrimitive('plane') },
          { label: 'Cube', action: () => this.spawnPrimitive('cube') },
          { label: 'Circle', action: () => this.spawnPrimitive('circle') },
          { label: 'UV Sphere', action: () => this.spawnPrimitive('uv_sphere') },
          { label: 'Ico Sphere', action: () => this.spawnPrimitive('ico_sphere') },
          { label: 'Cylinder', action: () => this.spawnPrimitive('cylinder') },
          { label: 'Cone', action: () => this.spawnPrimitive('cone') },
          { label: 'Torus', action: () => this.spawnPrimitive('torus') },
          { divider: true },
          { label: 'Grid', action: () => this.spawnPrimitive('grid') },
          { label: 'Capsule', action: () => this.spawnPrimitive('capsule') },
          { label: 'Pipe / Tube', action: () => this.spawnPrimitive('pipe') },
          { label: 'Monkey (Suzanne)', action: () => this.spawnPrimitive('monkey') }
        ]
      },
      {
        label: 'Light',
        children: [
          { label: 'Point Light', action: () => this.studio?.addLight({ type: 'point', x: 2, y: 5, z: 2 }) },
          { label: 'Sun Light', action: () => this.studio?.addLight({ type: 'directional', x: 5, y: 10, z: 5 }) },
          { label: 'Spot Light', action: () => this.studio?.addLight({ type: 'spot', x: 0, y: 8, z: 0 }) },
          { label: 'Area Light', action: () => this.studio?.addLight({ type: 'area', x: 0, y: 6, z: 4, intensity: 4 }) }
        ]
      },
      { label: 'Camera', shortcut: 'Numpad 0', action: () => this.app.cameraManager?.createCamera({ position: { x: 6, y: 4, z: 8 }, target: { x: 0, y: 1, z: 0 } }) },
      { divider: true },
      {
        label: 'Character & Armature',
        children: [
          { label: 'Human Head Bust', action: async () => {
            const head = await this.studio?.createRealisticHuman({ type: 'head_scan', y: 0.2, scale: 1.0 });
            if (head) this.sceneManager.select(head);
          }},
          { label: 'Mannequin Character (CC0)', action: async () => {
            const char = await this.studio?.createRealisticHuman({ type: 'mannequin', y: 0.0 });
            if (char) this.sceneManager.select(char);
          }},
          { label: 'Bot Character (CC0)', action: async () => {
            const bot = await this.studio?.loadGLTF('/models/Bot_CC0.glb', { y: 0.0, scale: 1.0, name: 'Bot_Character' });
            if (bot) this.sceneManager.select(bot);
          }},
          { label: 'Articulated Mannequin', action: () => this.studio?.createRiggedMannequin({ height: 1.8, y: 0 }) },
          { divider: true },
          { label: 'Humanoid Armature', action: () => this.studio?.createHumanoidArmature({ height: 1.8, y: 0 }) },
          { label: 'Bind Armature to Mesh', action: () => {
            const active = this.sceneManager.getActiveObject();
            if (active && active.isMesh) this.studio?.autoSkinMesh(active);
          }}
        ]
      }
    ];
  }

  _getObjectMenuItems() {
    return [
      { label: 'Shade Smooth', action: () => this.shadeObject('smooth') },
      { label: 'Shade Flat', action: () => this.shadeObject('flat') },
      { label: 'Shade Auto Smooth (30°)', action: () => this.shadeObjectAuto(30) },
      { label: 'Reset to Raw Clay', action: () => this.resetObjectToRawClay() },
      { label: 'Toggle Wireframe Overlay', action: () => {
        const active = this.sceneManager.getActiveObject();
        if (active && active.isMesh) {
          this._setMeshWireframeOverlay(active, !active.userData.showWireframeOverlay);
        } else {
          this.toggleGlobalWireframeOverlay();
        }
      }},
      { divider: true },
      {
        label: 'Set Origin',
        children: [
          { label: 'Origin to Geometry', action: () => this.setOrigin('geometry') },
          { label: 'Origin to Bottom', action: () => this.setOrigin('bottom') },
          { label: 'Origin to 3D Cursor', action: () => this.setOrigin('cursor') }
        ]
      },
      {
        label: 'Apply & Align',
        children: [
          { label: 'Apply Rotation & Scale', shortcut: 'Ctrl+A', action: () => this.applyAllTransforms(false, true, true) },
          { label: 'Apply All Transforms', action: () => this.applyAllTransforms(true, true, true) },
          { label: 'Snap Bottom to Floor (Y=0)', action: () => this.snapObjectToFloor() }
        ]
      },
      {
        label: 'Boolean & Mesh Ops',
        children: [
          { label: 'Join Selected Meshes', shortcut: 'Ctrl+J', action: () => this.joinSelectedMeshes() },
          { label: 'Boolean Difference', action: () => this.performBooleanOp('difference') },
          { label: 'Boolean Union', action: () => this.performBooleanOp('union') },
          { divider: true },
          { label: 'Solidify (Shell Thickness)', action: () => this.solidifyActiveMesh(0.15) },
          { label: 'Spin / Lathe 360°', action: () => this.spinActiveMesh(16, 360) }
        ]
      },
      { divider: true },
      { label: 'Duplicate Object', shortcut: 'Shift+D', action: () => {
        const a = this.sceneManager.getActiveObject();
        if (a) this.sceneManager.duplicateObject(a);
      }},
      { label: 'Delete', shortcut: 'X', danger: true, action: () => {
        const a = this.sceneManager.getActiveObject();
        if (a) this.sceneManager.removeObject(a);
      }}
    ];
  }

  _getEditMeshMenuItems() {
    return [
      { label: 'Extrude Region / Edge / Vert', shortcut: 'E', action: () => this.runExtrudeWithAdjust(0.5) },
      { label: 'Inset Faces', shortcut: 'I', action: () => this.runInsetWithAdjust(0.25) },
      { label: 'Bevel', shortcut: 'Ctrl+B', action: () => this.runBevelWithAdjust(0.08, 2) },
      { label: 'Make Edge / Face (Fill)', shortcut: 'F', action: () => this.editMode?.fillOrMakeFace() },
      { label: 'Knife Cut', shortcut: 'K', action: () => this.editMode?.knife() },
      { label: 'Loop Cut', shortcut: 'Ctrl+R', action: () => this.runLoopCutWithAdjust() },
      { label: 'Bridge Edge Loops', action: () => this.editMode?.bridgeEdgeLoops() },
      { label: 'Subdivide', action: () => this.editMode?.subdivide() },
      { label: 'Poke Faces', shortcut: 'Alt+P', action: () => this.editMode?.pokeFaces() },
      { label: 'Separate Selection', shortcut: 'P', action: () => this.editMode?.separateSelection() },
      { divider: true },
      {
        label: 'Deform & Normals',
        children: [
          { label: 'Spin / Lathe 360°', action: () => this.spinActiveMesh(16, 360) },
          { label: 'Smooth Vertices', action: () => this.smoothSelectedVertices(2, 0.5) },
          { label: 'Solidify Mesh', action: () => this.solidifyActiveMesh(0.15) },
          { label: 'Merge at Center', shortcut: 'M', action: () => this.editMode?.merge('center') },
          { divider: true },
          { label: 'Recalculate Outside', shortcut: 'Shift+N', action: () => this.recalculateSelectedNormals(false) },
          { label: 'Recalculate Inside', shortcut: 'Shift+Ctrl+N', action: () => this.recalculateSelectedNormals(true) },
          { label: 'Flip Normals', action: () => this.flipSelectedNormals() }
        ]
      },
      {
        label: 'UV Mapping',
        shortcut: 'U',
        children: [
          { label: 'Unwrap (LSCM)', action: () => this.editMode?.unwrap('lscm') },
          { label: 'Smart UV Project', action: () => this.editMode?.unwrap('smart') },
          { label: 'Cube Projection', action: () => this.editMode?.unwrap('cube') },
          { label: 'Cylinder Projection', action: () => this.editMode?.unwrap('cylinder') },
          { label: 'Sphere Projection', action: () => this.editMode?.unwrap('sphere') },
          { divider: true },
          { label: 'Pack Islands', action: () => this.editMode?.unwrap('pack') },
          { label: 'Average Islands Scale', action: () => this.editMode?.unwrap('average') },
          { label: 'Reset UVs', action: () => this.editMode?.unwrap('reset') },
          { divider: true },
          { label: 'Mark Seam', action: () => this.editMode?.markSeam(false) },
          { label: 'Clear Seam', action: () => this.editMode?.clearSeam() },
          { label: 'Select Seams', action: () => this.editMode?.selectSeams() }
        ]
      },
      { divider: true },
      { label: 'Dissolve Selection', shortcut: 'Ctrl+X', action: () => this.editMode?.dissolveSelection() },
      { label: 'Delete Geometry', shortcut: 'X', danger: true, action: () => this.editMode?.deleteSelection() }
    ];
  }

  // =========================================================================
  // 7. RIGHT-CLICK CONTEXT MENU IN 3D VIEWPORT
  // =========================================================================

  _createContextMenu() {
    const menu = document.createElement('div');
    menu.id = 'b-viewport-context-menu';
    menu.className = 'b-context-menu';
    menu.style.display = 'none';
    document.body.appendChild(menu);
    this.contextMenuEl = menu;
  }

  _populateMenu(container, items) {
    container.innerHTML = '';
    items.forEach((item) => {
      if (item.divider) {
        const div = document.createElement('div');
        div.className = 'b-cm-divider';
        container.appendChild(div);
        return;
      }
      if (item.header) {
        const hd = document.createElement('div');
        hd.className = 'b-cm-header';
        hd.textContent = item.header;
        container.appendChild(hd);
        return;
      }
      if (Array.isArray(item.children) && item.children.length > 0) {
        const wrap = document.createElement('div');
        wrap.className = 'b-cm-submenu';
        const trigger = document.createElement('div');
        trigger.className = 'b-cm-item';
        trigger.innerHTML = `<span>${item.label}</span><span class="b-cm-arrow">▸</span>`;
        const flyout = document.createElement('div');
        flyout.className = 'b-cm-flyout';
        this._populateMenu(flyout, item.children);
        wrap.appendChild(trigger);
        wrap.appendChild(flyout);
        container.appendChild(wrap);
        return;
      }
      const row = document.createElement('button');
      row.type = 'button';
      row.className = `b-cm-item ${item.danger ? 'b-cm-item--danger' : ''}`;
      row.innerHTML = `
        <span>${item.label}</span>
        ${item.shortcut ? `<span class="b-cm-shortcut">${item.shortcut}</span>` : ''}
      `;
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        this._hideMenus();
        item.action?.();
      });
      container.appendChild(row);
    });
  }

  _openViewportContextMenu(clientX, clientY) {
    if (!this.contextMenuEl) return;
    const items = this.editMode?.isActive ? this._getEditMeshMenuItems() : this._getObjectMenuItems();
    this._populateMenu(this.contextMenuEl, items);
    this.contextMenuEl.style.display = 'block';
    const maxLeft = Math.max(8, window.innerWidth - 250);
    const maxTop = Math.max(8, window.innerHeight - 380);
    this.contextMenuEl.style.left = `${Math.min(maxLeft, Math.max(8, clientX))}px`;
    this.contextMenuEl.style.top = `${Math.min(maxTop, Math.max(8, clientY))}px`;
  }

  _hideMenus() {
    if (this.contextMenuEl) this.contextMenuEl.style.display = 'none';
    if (this.vpDropdownEl) this.vpDropdownEl.style.display = 'none';
  }

  // =========================================================================
  // 8. BLENDER VIEWPORT N-PANEL SIDEBAR (Item / Tool / View)
  // =========================================================================

  _createViewportNPanel() {
    const host = document.getElementById('viewport-canvas-host');
    if (!host) return;

    // Small pull-tab `<` on the right edge of the 3D Viewport (just like Blender!)
    const pullBtn = document.createElement('button');
    pullBtn.id = 'b-npanel-pull-btn';
    pullBtn.className = 'b-npanel-pull';
    pullBtn.title = 'Toggle Sidebar (N)';
    pullBtn.textContent = '‹ N';
    pullBtn.addEventListener('click', () => this.toggleNPanel());
    host.appendChild(pullBtn);
    this.nPanelPullBtn = pullBtn;

    const panel = document.createElement('div');
    panel.id = 'b-viewport-npanel';
    panel.className = 'b-npanel';
    panel.style.display = 'none';
    panel.innerHTML = `
      <div class="b-npanel-tabs">
        <button type="button" class="b-npanel-tab active" data-ntab="item">Item</button>
        <button type="button" class="b-npanel-tab" data-ntab="tool">Tool</button>
        <button type="button" class="b-npanel-tab" data-ntab="view">View</button>
      </div>
      <div class="b-npanel-body" id="b-npanel-body"></div>
    `;
    host.appendChild(panel);
    this.nPanelEl = panel;
    this.nPanelBody = panel.querySelector('#b-npanel-body');

    panel.querySelectorAll('.b-npanel-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        panel.querySelectorAll('.b-npanel-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        this.nPanelTab = tab.dataset.ntab;
        this._renderNPanelContent();
      });
    });

    this._renderNPanelContent();
  }

  toggleNPanel(forceState = undefined) {
    this.nPanelOpen = forceState !== undefined ? !!forceState : !this.nPanelOpen;
    if (this.nPanelEl) {
      this.nPanelEl.style.display = this.nPanelOpen ? 'flex' : 'none';
    }
    if (this.nPanelPullBtn) {
      this.nPanelPullBtn.textContent = this.nPanelOpen ? '› N' : '‹ N';
      this.nPanelPullBtn.classList.toggle('open', this.nPanelOpen);
    }
    if (this.nPanelOpen) {
      this._renderNPanelContent();
    }
  }

  _syncNPanelFields() {
    if (!this.nPanelOpen) return;
    this._renderNPanelContent();
  }

  _renderNPanelContent() {
    if (!this.nPanelBody) return;
    const active = this.sceneManager.getActiveObject();

    if (this.nPanelTab === 'item') {
      if (!active) {
        this.nPanelBody.innerHTML = `<div class="b-np-empty">No active object.<br>Select an object or press <b>Shift+A</b> to add one.</div>`;
        return;
      }
      const pos = active.position;
      const rot = active.rotation;
      const scl = active.scale;

      // Compute exact metric bounding-box dimensions (like Blender Dimensions X/Y/Z)
      const box = new THREE.Box3().setFromObject(active);
      const dims = box.isEmpty() ? new THREE.Vector3(0, 0, 0) : box.getSize(new THREE.Vector3());

      this.nPanelBody.innerHTML = `
        <div class="b-np-section">
          <div class="b-np-head">Transform • ${escapeHtml(active.name || 'Object')}</div>
          <div class="b-np-sub">Location (m)</div>
          <div class="b-np-xyz">
            <label><span class="ax-x">X</span><input type="number" step="0.1" data-np-pos="x" value="${pos.x.toFixed(2)}"></label>
            <label><span class="ax-y">Y</span><input type="number" step="0.1" data-np-pos="y" value="${pos.y.toFixed(2)}"></label>
            <label><span class="ax-z">Z</span><input type="number" step="0.1" data-np-pos="z" value="${pos.z.toFixed(2)}"></label>
          </div>
          <div class="b-np-sub">Rotation (°)</div>
          <div class="b-np-xyz">
            <label><span class="ax-x">X</span><input type="number" step="5" data-np-rot="x" value="${(rot.x * RAD2DEG).toFixed(1)}"></label>
            <label><span class="ax-y">Y</span><input type="number" step="5" data-np-rot="y" value="${(rot.y * RAD2DEG).toFixed(1)}"></label>
            <label><span class="ax-z">Z</span><input type="number" step="5" data-np-rot="z" value="${(rot.z * RAD2DEG).toFixed(1)}"></label>
          </div>
          <div class="b-np-sub">Scale</div>
          <div class="b-np-xyz">
            <label><span class="ax-x">X</span><input type="number" step="0.1" data-np-scl="x" value="${scl.x.toFixed(2)}"></label>
            <label><span class="ax-y">Y</span><input type="number" step="0.1" data-np-scl="y" value="${scl.y.toFixed(2)}"></label>
            <label><span class="ax-z">Z</span><input type="number" step="0.1" data-np-scl="z" value="${scl.z.toFixed(2)}"></label>
          </div>
          <div class="b-np-sub">Dimensions (m)</div>
          <div class="b-np-xyz">
            <label><span class="ax-x">X</span><input type="number" step="0.1" min="0.01" data-np-dim="x" value="${dims.x.toFixed(2)}"></label>
            <label><span class="ax-y">Y</span><input type="number" step="0.1" min="0.01" data-np-dim="y" value="${dims.y.toFixed(2)}"></label>
            <label><span class="ax-z">Z</span><input type="number" step="0.1" min="0.01" data-np-dim="z" value="${dims.z.toFixed(2)}"></label>
          </div>
          <div class="b-np-btn-grid" style="margin-top: 8px;">
            <button type="button" class="b-np-btn" id="np-btn-floor">Snap to Floor</button>
            <button type="button" class="b-np-btn" id="np-btn-apply-scale">Apply Scale</button>
          </div>
        </div>
      `;

      this.nPanelBody.querySelectorAll('[data-np-pos]').forEach((inp) => {
        inp.addEventListener('change', (e) => {
          const ax = e.target.dataset.npPos;
          const v = parseFloat(e.target.value);
          if (Number.isFinite(v)) {
            active.position[ax] = v;
            active.updateMatrixWorld(true);
            this.engine.updateSelectionHelper();
            this.sceneManager.requestRender();
          }
        });
      });

      this.nPanelBody.querySelectorAll('[data-np-rot]').forEach((inp) => {
        inp.addEventListener('change', (e) => {
          const ax = e.target.dataset.npRot;
          const v = parseFloat(e.target.value);
          if (Number.isFinite(v)) {
            active.rotation[ax] = v * DEG2RAD;
            active.updateMatrixWorld(true);
            this.engine.updateSelectionHelper();
            this.sceneManager.requestRender();
          }
        });
      });

      this.nPanelBody.querySelectorAll('[data-np-scl]').forEach((inp) => {
        inp.addEventListener('change', (e) => {
          const ax = e.target.dataset.npScl;
          const v = parseFloat(e.target.value);
          if (Number.isFinite(v) && v !== 0) {
            active.scale[ax] = v;
            active.updateMatrixWorld(true);
            this.engine.updateSelectionHelper();
            this._renderNPanelContent();
            this.sceneManager.requestRender();
          }
        });
      });

      this.nPanelBody.querySelectorAll('[data-np-dim]').forEach((inp) => {
        inp.addEventListener('change', (e) => {
          const ax = e.target.dataset.npDim;
          const targetDim = parseFloat(e.target.value);
          if (Number.isFinite(targetDim) && targetDim > 0.001 && dims[ax] > 0.0001) {
            active.scale[ax] *= (targetDim / dims[ax]);
            active.updateMatrixWorld(true);
            this.engine.updateSelectionHelper();
            this._renderNPanelContent();
            this.sceneManager.requestRender();
          }
        });
      });

      this.nPanelBody.querySelector('#np-btn-floor')?.addEventListener('click', () => this.snapObjectToFloor());
      this.nPanelBody.querySelector('#np-btn-apply-scale')?.addEventListener('click', () => this.applyAllTransforms(false, true, true));

    } else if (this.nPanelTab === 'tool') {
      this.nPanelBody.innerHTML = `
        <div class="b-np-section">
          <div class="b-np-head">Shading & Clay</div>
          <div class="b-np-btn-grid">
            <button type="button" class="b-np-btn" id="np-shade-flat">Shade Flat</button>
            <button type="button" class="b-np-btn" id="np-shade-smooth">Shade Smooth</button>
            <button type="button" class="b-np-btn" id="np-raw-clay">Reset Clay</button>
            <button type="button" class="b-np-btn" id="np-wire-mesh">Wire Overlay</button>
          </div>
        </div>

        <div class="b-np-section">
          <div class="b-np-head">Set Origin</div>
          <div class="b-np-btn-grid">
            <button type="button" class="b-np-btn" id="np-orig-geom">To Geometry</button>
            <button type="button" class="b-np-btn" id="np-orig-btm">To Bottom</button>
            <button type="button" class="b-np-btn" id="np-orig-cur">To 3D Cursor</button>
            <button type="button" class="b-np-btn" id="np-snap-floor">Snap Floor</button>
          </div>
        </div>

        <div class="b-np-section">
          <div class="b-np-head">Mesh & Boolean</div>
          <div class="b-np-btn-grid">
            <button type="button" class="b-np-btn" id="np-join">Join (Ctrl+J)</button>
            <button type="button" class="b-np-btn" id="np-bool-diff">Boolean Diff</button>
            <button type="button" class="b-np-btn" id="np-solidify">Solidify</button>
            <button type="button" class="b-np-btn" id="np-spin">Spin 360°</button>
          </div>
        </div>

        <div class="b-np-section">
          <div class="b-np-head">Quick Modifiers</div>
          <div class="b-np-btn-grid">
            <button type="button" class="b-np-btn" data-np-mod="Mirror">+ Mirror</button>
            <button type="button" class="b-np-btn" data-np-mod="Subdivision">+ Subsurf</button>
            <button type="button" class="b-np-btn" data-np-mod="Bevel">+ Bevel</button>
            <button type="button" class="b-np-btn" data-np-mod="Array">+ Array</button>
            <button type="button" class="b-np-btn" data-np-mod="Wireframe">+ Wireframe</button>
            <button type="button" class="b-np-btn" id="np-bake-mods" style="color: #4ade80;">Apply All</button>
          </div>
        </div>
      `;

      this.nPanelBody.querySelector('#np-shade-flat')?.addEventListener('click', () => this.shadeObject(false));
      this.nPanelBody.querySelector('#np-shade-smooth')?.addEventListener('click', () => this.shadeObject(true));
      this.nPanelBody.querySelector('#np-raw-clay')?.addEventListener('click', () => this.resetObjectToRawClay());
      this.nPanelBody.querySelector('#np-wire-mesh')?.addEventListener('click', () => {
        if (active && active.isMesh) {
          this._setMeshWireframeOverlay(active, !active.userData.showWireframeOverlay);
        } else {
          this.toggleGlobalWireframeOverlay();
        }
      });

      this.nPanelBody.querySelector('#np-orig-geom')?.addEventListener('click', () => this.setOrigin('geometry'));
      this.nPanelBody.querySelector('#np-orig-btm')?.addEventListener('click', () => this.setOrigin('bottom'));
      this.nPanelBody.querySelector('#np-orig-cur')?.addEventListener('click', () => this.setOrigin('cursor'));
      this.nPanelBody.querySelector('#np-snap-floor')?.addEventListener('click', () => this.snapObjectToFloor());

      this.nPanelBody.querySelector('#np-join')?.addEventListener('click', () => this.joinSelectedMeshes());
      this.nPanelBody.querySelector('#np-bool-diff')?.addEventListener('click', () => this.performBooleanOp('difference'));
      this.nPanelBody.querySelector('#np-solidify')?.addEventListener('click', () => this.solidifyActiveMesh(0.15));
      this.nPanelBody.querySelector('#np-spin')?.addEventListener('click', () => this.spinActiveMesh(16, 360));

      this.nPanelBody.querySelectorAll('[data-np-mod]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const a = this.sceneManager.getActiveObject();
          if (!a || !a.isMesh) {
            this._notify('Select a Mesh object before adding a Modifier.', 'warning');
            return;
          }
          const modType = btn.dataset.npMod;
          ModifierStack.addModifier(a, modType, {}, { sceneManager: this.sceneManager })
            .then(() => { window.inspector?.render?.(); this.sceneManager.requestRender(); })
            .catch((err) => console.warn('[N-panel modifier]', err));
        });
      });

      this.nPanelBody.querySelector('#np-bake-mods')?.addEventListener('click', () => {
        const a = this.sceneManager.getActiveObject();
        if (a && a.isMesh) {
          ModifierStack.bakeModifiers(a, null, { sceneManager: this.sceneManager })
            .then(() => { window.inspector?.render?.(); this.sceneManager.requestRender(); })
            .catch((err) => console.warn('[N-panel bake]', err));
        }
      });

    } else if (this.nPanelTab === 'view') {
      const fov = this.engine.camera?.fov ?? this.engine.perspectiveCamera.fov;
      const orthographic = this.engine.camera.isOrthographicCamera;
      const cur = this.cursorPosition;
      this.nPanelBody.innerHTML = `
        <div class="b-np-section">
          <div class="b-np-head">3D Viewport Camera</div>
          <div class="b-op-row">
            <span class="b-op-label">Focal / FOV</span>
            <input type="range" class="b-op-slider" id="np-cam-fov" min="20" max="100" step="1" value="${fov}" ${orthographic ? 'disabled title="FOV applies to Perspective view only"' : ''}>
            <span style="font-size:11px; min-width:28px; text-align:right;">${orthographic ? 'Ortho' : `${Math.round(fov)}°`}</span>
          </div>
        </div>
        <div class="b-np-section">
          <div class="b-np-head">3D Cursor Location</div>
          <div class="b-np-xyz">
            <label><span class="ax-x">X</span><input type="number" step="0.5" data-np-cur="x" value="${cur.x.toFixed(2)}"></label>
            <label><span class="ax-y">Y</span><input type="number" step="0.5" data-np-cur="y" value="${cur.y.toFixed(2)}"></label>
            <label><span class="ax-z">Z</span><input type="number" step="0.5" data-np-cur="z" value="${cur.z.toFixed(2)}"></label>
          </div>
          <div class="b-np-btn-grid" style="margin-top: 8px;">
            <button type="button" class="b-np-btn" id="np-cur-reset">Reset (0,0,0)</button>
            <button type="button" class="b-np-btn" id="np-cur-to-sel">To Selected</button>
          </div>
        </div>
      `;

      this.nPanelBody.querySelector('#np-cam-fov')?.addEventListener('input', (e) => {
        const v = parseFloat(e.target.value);
        if (this.engine.camera.isPerspectiveCamera && Number.isFinite(v)) {
          this.engine.camera.fov = v;
          this.engine.camera.updateProjectionMatrix();
          this._renderNPanelContent();
          this.sceneManager.requestRender();
        }
      });

      this.nPanelBody.querySelectorAll('[data-np-cur]').forEach((inp) => {
        inp.addEventListener('change', (e) => {
          const ax = e.target.dataset.npCur;
          const v = parseFloat(e.target.value);
          if (Number.isFinite(v)) {
            this.cursorPosition[ax] = v;
            this.setCursorPosition(this.cursorPosition.x, this.cursorPosition.y, this.cursorPosition.z);
          }
        });
      });

      this.nPanelBody.querySelector('#np-cur-reset')?.addEventListener('click', () => this.setCursorPosition(0, 0, 0));
      this.nPanelBody.querySelector('#np-cur-to-sel')?.addEventListener('click', () => {
        if (active) {
          const wp = active.getWorldPosition(new THREE.Vector3());
          this.setCursorPosition(wp.x, wp.y, wp.z);
        }
      });
    }
  }

  // =========================================================================
  // 9. EVENT LISTENERS (MODE SWITCHING, RIGHT-CLICK MENU, 3D CURSOR, SHORTCUTS)
  // =========================================================================

  _bindEvents() {
    // Sync Left Toolbar & Viewport Header when switching between Object / Edit / Sculpt mode
    const updateModeUI = (mode) => {
      const isEdit = mode === 'edit' || !!this.editMode?.isActive;
      const objGroup = document.getElementById('toolbar-group-object');
      const editGroup = document.getElementById('toolbar-group-edit');
      if (objGroup) objGroup.style.display = isEdit ? 'none' : 'flex';
      if (editGroup) editGroup.style.display = isEdit ? 'flex' : 'none';

      const vpObjBtn = document.getElementById('btn-vp-object');
      if (vpObjBtn) vpObjBtn.textContent = isEdit ? 'Mesh' : 'Object';
    };

    window.addEventListener('blender:mode-changed', (e) => {
      updateModeUI(e.detail?.mode);
    });
    document.getElementById('viewport-mode')?.addEventListener('change', (e) => {
      setTimeout(() => updateModeUI(e.target.value), 20);
    });

    window.addEventListener('blender:viewportCameraChanged', () => this._syncNPanelFields());
    window.addEventListener('blender:cameraViewChanged', () => this._syncNPanelFields());
    // Update N-Panel when selection or transform changes
    this.sceneManager.on('selectionChanged', () => this._syncNPanelFields());
    this.sceneManager.on('transformChanged', () => this._syncNPanelFields());
    this.engine.transformControls?.addEventListener('objectChange', () => this._syncNPanelFields());

    // Close floating menus on click outside
    document.addEventListener('click', () => this._hideMenus());

    // Viewport Pointer Interaction for Right-Click Context Menu, 3D Cursor, and Measure Tool
    const dom = this.engine.domElement;
    if (dom) {
      let downX = 0, downY = 0, downBtn = -1;

      dom.addEventListener('pointerdown', (e) => {
        downX = e.clientX;
        downY = e.clientY;
        downBtn = e.button;
        this._hideMenus();

        // Measure tool start point
        if (e.button === 0 && this.activeTool === 'measure') {
          const pt = this._raycastSceneOrFloor(e);
          if (pt) {
            this.measureStart = pt.clone();
            this.measureEnd = pt.clone();
          }
        }
      });

      dom.addEventListener('pointermove', (e) => {
        if (this.activeTool === 'measure' && this.measureStart && (e.buttons & 1)) {
          const pt = this._raycastSceneOrFloor(e);
          if (pt) {
            this.measureEnd = pt.clone();
            this._updateMeasureLine(this.measureStart, this.measureEnd);
          }
        }
      });

      dom.addEventListener('pointerup', (e) => {
        const btn = downBtn;
        const moved = Math.hypot(e.clientX - downX, e.clientY - downY);
        downBtn = -1;
        if (moved > 5) return;

        // Left-click with 3D Cursor tool active OR Shift + Right-Click places 3D Cursor!
        if ((btn === 0 && this.activeTool === 'cursor') || (btn === 2 && e.button === 2 && e.shiftKey)) {
          const pt = this._raycastSceneOrFloor(e);
          if (pt) {
            this.setCursorPosition(pt.x, pt.y, pt.z);
          }
          return;
        }

        // Open Viewport Context Menu on short RMB release (not on macOS mousedown contextmenu,
        // which would intercept Web Orbit RMB camera panning under the cursor).
        if (
          btn === 2 &&
          e.button === 2 &&
          !e.shiftKey &&
          !this.modalTransform?.isActive &&
          !this.editMode?._knifeSession &&
          !this.engine?.areaManager?._dragState &&
          !this.engine?.areaManager?._splitterDrag &&
          !(typeof window !== 'undefined' && window.sculptMode?.isActive)
        ) {
          this._openViewportContextMenu(e.clientX, e.clientY);
        }
      });

      dom.addEventListener('pointercancel', () => {
        downBtn = -1;
      });

      // Suppress native browser menu; our custom context menu opens on RMB pointerup if not dragged.
      dom.addEventListener('contextmenu', (e) => {
        e.preventDefault();
      });
    }

    // Hook Edit Mode buttons in top header (#btn-edit-extrude, #btn-edit-inset, #btn-edit-bevel) so they also show F9 Adjust Last Op!
    document.getElementById('btn-edit-extrude')?.addEventListener('click', (e) => {
      e.stopImmediatePropagation();
      this.runExtrudeWithAdjust(0.5);
    }, true);
    document.getElementById('btn-edit-inset')?.addEventListener('click', (e) => {
      e.stopImmediatePropagation();
      this.runInsetWithAdjust(0.25);
    }, true);
    document.getElementById('btn-edit-bevel')?.addEventListener('click', (e) => {
      e.stopImmediatePropagation();
      this.runBevelWithAdjust(0.08, 2);
    }, true);

    // Global Blender Modeling Shortcuts:
    // - Shift + C: Reset 3D Cursor to (0,0,0)
    // - Ctrl + J: Join Selected Meshes
    // - Ctrl + A: Apply All Transforms
    // - Alt + Z: Toggle X-Ray
    // - F9: Toggle Adjust Last Operation panel
    window.addEventListener('keydown', (e) => {
      if (shouldBlockViewportShortcut()) return;
      const key = e.key.toLowerCase();

      if (key === 'c' && e.shiftKey && !e.ctrlKey) {
        e.preventDefault();
        this.setCursorPosition(0, 0, 0);
      } else if (key === 'n' && e.shiftKey) {
        // Shift+N = Recalculate Normals Outside, Shift+Ctrl+N = Inside
        e.preventDefault();
        this.recalculateSelectedNormals(e.ctrlKey);
      } else if (key === 'j' && e.ctrlKey && !e.shiftKey) {
        e.preventDefault();
        this.joinSelectedMeshes();
      } else if (key === 'z' && e.altKey) {
        e.preventDefault();
        this.toggleXRayMode();
      } else if (e.key === 'F9') {
        e.preventDefault();
        if (this.lastOpPanel) {
          if (this.lastOpPanel.style.display === 'none') {
            this.lastOpPanel.style.display = 'block';
            this.lastOpCollapsed = false;
            this.lastOpPanel.querySelector('#b-op-header-toggle')?.click();
          } else {
            this.lastOpPanel.querySelector('#b-op-header-toggle')?.click();
          }
        }
      } else if (key === 'b' && e.ctrlKey && this.editMode?.isActive) {
        e.preventDefault();
        this.runBevelWithAdjust(0.08, 2);
      }
    });
  }

  _raycastSceneOrFloor(event) {
    const dom = this.engine.domElement;
    if (!dom) return null;
    const ctx = this.engine.getViewportContextAtPoint
      ? this.engine.getViewportContextAtPoint(event.clientX, event.clientY)
      : {
          rect: this.engine.getViewportRect ? this.engine.getViewportRect() : dom.getBoundingClientRect(),
          camera: this.engine.camera
        };
    const rect = ctx.rect;
    const camera = ctx.camera || this.engine.camera;
    const ndc = new THREE.Vector2(
      ((event.clientX - rect.left) / (rect.width || 1)) * 2 - 1,
      -((event.clientY - rect.top) / (rect.height || 1)) * 2 + 1
    );
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(ndc, camera);

    const selectable = this.sceneManager.getSelectableObjects().filter(o => o.isMesh);
    const hits = raycaster.intersectObjects(selectable, true);
    if (hits.length > 0) {
      return hits[0].point;
    }

    // Intersect Y=0 ground plane
    const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const pt = new THREE.Vector3();
    if (raycaster.ray.intersectPlane(groundPlane, pt)) {
      return pt;
    }
    return null;
  }
}
