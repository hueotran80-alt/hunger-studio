/**
 * Blender-style Corner-Drag Workspace Area Manager
 *
 * Implements binary-tree area splitting/joining by dragging from any area corner,
 * draggable border splitters, right-click area context menus, Quad View (Ctrl+Alt+Q),
 * per-pane 3D cameras/projection/shading/ViewHelper, and live DOM reparenting for
 * embedded 2D editors (UV Editor, Timeline, Graph Editor, Scripting, Materials, Physics,
 * Outliner, Properties).
 *
 * File: js/ui/workspace-areas.js
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { ViewHelper } from 'three/addons/helpers/ViewHelper.js';

export const EDITOR_TYPES = [
  { id: 'viewport3d', label: '3D Viewport', short: '3D View' },
  { id: 'uv-editor', label: 'UV Editor', short: 'UV' },
  { id: 'timeline', label: 'Timeline', short: 'Timeline' },
  { id: 'graph-editor', label: 'Graph Editor', short: 'Graph' },
  { id: 'scripting', label: 'Scripting (DSL)', short: 'Script' },
  { id: 'materials', label: 'PBR Materials', short: 'Materials' },
  { id: 'shader-editor', label: 'Shader Node Editor', short: 'Shader' },
  { id: 'asset-browser', label: 'Asset Browser', short: 'Assets' },
  { id: 'physics', label: 'Physics (Rapier)', short: 'Physics' },
  { id: 'outliner', label: 'Outliner', short: 'Outliner' },
  { id: 'inspector', label: 'Properties', short: 'Props' },
];

export const VIEWPORT_PRESET_OPTIONS = [
  { id: 'persp', label: 'Persp' },
  { id: 'front', label: 'Front' },
  { id: 'back', label: 'Back' },
  { id: 'right', label: 'Right' },
  { id: 'left', label: 'Left' },
  { id: 'top', label: 'Top' },
  { id: 'bottom', label: 'Bottom' },
  { id: 'camera', label: 'Camera' },
];

let _nextIdCounter = 1;
function _genId(prefix = 'area') {
  return `${prefix}-${_nextIdCounter++}`;
}

export function clampRatio(ratio, min = 0.12, max = 0.88) {
  const n = Number(ratio);
  if (!Number.isFinite(n)) return 0.5;
  return Math.max(min, Math.min(max, n));
}

export function createLeafArea(options = {}) {
  return {
    id: options.id || _genId('area'),
    type: 'leaf',
    editorType: options.editorType || 'viewport3d',
    cameraPreset: options.cameraPreset || 'persp',
    shadingMode: options.shadingMode || 'inherit',
    showGrid: options.showGrid !== false,
    showGizmo: options.showGizmo !== false,
    label: options.label || null,
  };
}

export function cloneAreaTree(node) {
  if (!node) return null;
  if (node.type === 'leaf') {
    return { ...node };
  }
  return {
    id: node.id,
    type: 'split',
    direction: node.direction,
    ratio: node.ratio,
    a: cloneAreaTree(node.a),
    b: cloneAreaTree(node.b),
  };
}

export function findLeafNode(root, leafId) {
  if (!root) return null;
  if (root.type === 'leaf') return root.id === leafId ? root : null;
  return findLeafNode(root.a, leafId) || findLeafNode(root.b, leafId);
}

export function listLeafNodes(root, out = []) {
  if (!root) return out;
  if (root.type === 'leaf') {
    out.push(root);
    return out;
  }
  listLeafNodes(root.a, out);
  listLeafNodes(root.b, out);
  return out;
}

export function computeNormalizedRects(root, box = { x: 0, y: 0, w: 1, h: 1 }, out = new Map()) {
  if (!root) return out;
  if (root.type === 'leaf') {
    out.set(root.id, {
      x: box.x,
      y: box.y,
      w: box.w,
      h: box.h,
      right: box.x + box.w,
      bottom: box.y + box.h,
    });
    return out;
  }
  const r = clampRatio(root.ratio);
  if (root.direction === 'vertical') {
    const wA = box.w * r;
    const wB = box.w - wA;
    computeNormalizedRects(root.a, { x: box.x, y: box.y, w: wA, h: box.h }, out);
    computeNormalizedRects(root.b, { x: box.x + wA, y: box.y, w: wB, h: box.h }, out);
  } else {
    const hA = box.h * r;
    const hB = box.h - hA;
    computeNormalizedRects(root.a, { x: box.x, y: box.y, w: box.w, h: hA }, out);
    computeNormalizedRects(root.b, { x: box.x, y: box.y + hA, w: box.w, h: hB }, out);
  }
  return out;
}

/**
 * Splits `leafId` in the BSP tree into a vertical (Left|Right) or horizontal (Top|Bottom) split.
 */
export function splitLeafInTree(root, leafId, direction = 'vertical', ratio = 0.5, insertNewFirst = false, newLeafOptions = {}) {
  if (!root) return null;
  const dir = direction === 'horizontal' ? 'horizontal' : 'vertical';
  const clamped = clampRatio(ratio);

  function walk(node) {
    if (node.type === 'leaf') {
      if (node.id !== leafId) return { node, newLeaf: null };
      const newLeaf = createLeafArea({
        editorType: newLeafOptions.editorType || node.editorType || 'viewport3d',
        cameraPreset: newLeafOptions.cameraPreset || node.cameraPreset || 'persp',
        shadingMode: newLeafOptions.shadingMode || 'inherit',
        showGrid: node.showGrid,
        showGizmo: node.showGizmo,
        ...newLeafOptions,
      });
      const splitNode = {
        id: _genId('split'),
        type: 'split',
        direction: dir,
        ratio: clamped,
        a: insertNewFirst ? newLeaf : node,
        b: insertNewFirst ? node : newLeaf,
      };
      return { node: splitNode, newLeaf };
    }
    const leftRes = walk(node.a);
    if (leftRes.newLeaf) {
      return { node: { ...node, a: leftRes.node }, newLeaf: leftRes.newLeaf };
    }
    const rightRes = walk(node.b);
    if (rightRes.newLeaf) {
      return { node: { ...node, b: rightRes.node }, newLeaf: rightRes.newLeaf };
    }
    return { node, newLeaf: null };
  }

  return walk(root);
}

/**
 * Finds the path [ancestorSplit, ...] from root to leafId, along with branch keys ('a'|'b').
 */
function findPathToLeaf(root, leafId, path = []) {
  if (!root) return null;
  if (root.type === 'leaf') return root.id === leafId ? path : null;
  const left = findPathToLeaf(root.a, leafId, [...path, { node: root, branch: 'a' }]);
  if (left) return left;
  return findPathToLeaf(root.b, leafId, [...path, { node: root, branch: 'b' }]);
}

/**
 * Checks whether two leaves share an aligned common edge of matching perpendicular span,
 * and returns join relationship metadata or null.
 */
export function canJoinLeaves(root, leafAId, leafBId, eps = 1e-4) {
  if (!root || !leafAId || !leafBId || leafAId === leafBId) return null;
  const rects = computeNormalizedRects(root);
  const ra = rects.get(leafAId);
  const rb = rects.get(leafBId);
  if (!ra || !rb) return null;

  // Touching horizontally: A right === B left OR B right === A left, and same vertical [y, bottom]
  const sameY = Math.abs(ra.y - rb.y) < eps && Math.abs(ra.bottom - rb.bottom) < eps;
  if (sameY && Math.abs(ra.right - rb.x) < eps) {
    return { direction: 'vertical', order: 'ab' };
  }
  if (sameY && Math.abs(rb.right - ra.x) < eps) {
    return { direction: 'vertical', order: 'ba' };
  }

  // Touching vertically: A bottom === B top OR B bottom === A top, and same horizontal [x, right]
  const sameX = Math.abs(ra.x - rb.x) < eps && Math.abs(ra.right - rb.right) < eps;
  if (sameX && Math.abs(ra.bottom - rb.y) < eps) {
    return { direction: 'horizontal', order: 'ab' };
  }
  if (sameX && Math.abs(rb.bottom - ra.y) < eps) {
    return { direction: 'horizontal', order: 'ba' };
  }
  return null;
}

/**
 * Joins `removeLeafId` into `keepLeafId` in the BSP tree (both direct sibling merges and
 * same-axis chain merges such as 3 vertical panes side-by-side).
 */
export function joinLeavesInTree(root, keepLeafId, removeLeafId) {
  if (!root || root.type === 'leaf') return null;
  const rel = canJoinLeaves(root, keepLeafId, removeLeafId);
  if (!rel) return null;

  const rects = computeNormalizedRects(root);
  const pathKeep = findPathToLeaf(root, keepLeafId);
  const pathRem = findPathToLeaf(root, removeLeafId);
  if (!pathKeep || !pathRem) return null;

  // Find lowest common ancestor split node
  let lcaIdx = 0;
  while (
    lcaIdx < pathKeep.length &&
    lcaIdx < pathRem.length &&
    pathKeep[lcaIdx].node === pathRem[lcaIdx].node
  ) {
    lcaIdx++;
  }
  const lcaIndex = lcaIdx - 1;
  if (lcaIndex < 0) return null;

  const lcaEntry = pathKeep[lcaIndex];
  const lcaNode = lcaEntry.node;

  const keepNode = findLeafNode(root, keepLeafId);
  if (!keepNode) return null;

  // Case 1: Direct siblings under lcaNode
  const keepDirect = lcaIndex === pathKeep.length - 1;
  const remDirect = lcaIndex === pathRem.length - 1;
  if (keepDirect && remDirect) {
    return replaceNodeInTree(root, lcaNode.id, keepNode);
  }

  // Case 2: One is direct child of LCA (`directLeaf`) and the other is nested along the same axis
  if (lcaNode.direction === rel.direction) {
    const rKeep = rects.get(keepLeafId);
    const rRem = rects.get(removeLeafId);
    const axisSpan = rel.direction === 'vertical' ? 'w' : 'h';
    const lcaTotal =
      (computeSubtreeSpan(lcaNode.a, rects, axisSpan)) +
      (computeSubtreeSpan(lcaNode.b, rects, axisSpan));

    if (keepDirect && !remDirect) {
      // Remove `removeLeafId` by collapsing its parent to its sibling, and expand LCA keep branch
      const remParent = pathRem[pathRem.length - 1].node;
      const remBranch = pathRem[pathRem.length - 1].branch;
      const remSibling = remBranch === 'a' ? remParent.b : remParent.a;
      let nextRoot = replaceNodeInTree(root, remParent.id, remSibling);
      const mergedSpan = rKeep[axisSpan] + rRem[axisSpan];
      const nextRatio = clampRatio(mergedSpan / lcaTotal, 0.05, 0.95);
      nextRoot = updateSplitRatio(nextRoot, lcaNode.id, lcaEntry.branch === 'a' ? nextRatio : 1 - nextRatio);
      return nextRoot;
    }

    if (!keepDirect && remDirect) {
      // Collapse `keepLeafId`'s parent? No: expand `keep`'s edge to replace `removeLeafId`:
      // Since keep & remove are only separated by lcaNode, replacing lcaNode's direct remove child
      // happens only if keep's branch reduces cleanly when keep has a single edge-touching parent.
      const keepParent = pathKeep[pathKeep.length - 1].node;
      const keepBranch = pathKeep[pathKeep.length - 1].branch;
      const keepSibling = keepBranch === 'a' ? keepParent.b : keepParent.a;
      // Keep replaces `remove` inside LCA, while `keep`'s old parent collapses to `keepSibling`!
      const remBranch = pathRem[pathRem.length - 1].branch;
      let nextRoot = replaceChildOnSplit(root, lcaNode.id, remBranch, keepNode);
      nextRoot = replaceNodeInTree(nextRoot, keepParent.id, keepSibling);
      const remainingOnKeepSide = Math.max(0.05, lcaTotal - (rKeep[axisSpan] + rRem[axisSpan]));
      const mergedSpan = rKeep[axisSpan] + rRem[axisSpan];
      const lcaNextRatio = remBranch === 'a'
        ? clampRatio(mergedSpan / lcaTotal, 0.05, 0.95)
        : clampRatio(remainingOnKeepSide / lcaTotal, 0.05, 0.95);
      nextRoot = updateSplitRatio(nextRoot, lcaNode.id, lcaNextRatio);
      return nextRoot;
    }

    // Case 3a: Both keep & remove are nested along the same chain axis (e.g. [A1|A2] + [B1|B2])
    if (!keepDirect && !remDirect && pathRem.length === lcaIndex + 2 && pathKeep.length === lcaIndex + 2) {
      const keepParent = pathKeep[pathKeep.length - 1].node;
      const keepBranch = pathKeep[pathKeep.length - 1].branch;
      const remParent = pathRem[pathRem.length - 1].node;
      const remBranch = pathRem[pathRem.length - 1].branch;
      if (keepParent.direction === rel.direction && remParent.direction === rel.direction) {
        const remSibling = remBranch === 'a' ? remParent.b : remParent.a;
        const keepSpanOld = computeSubtreeSpan(keepParent, rects, axisSpan);
        const keepSpanNew = keepSpanOld + rRem[axisSpan];
        const keepOther = keepBranch === 'a' ? keepParent.b : keepParent.a;
        const keepOtherSpan = computeSubtreeSpan(keepOther, rects, axisSpan);
        const newKeepParentRatio = keepBranch === 'a'
          ? clampRatio((keepSpanNew - keepOtherSpan) / Math.max(1e-6, keepSpanNew), 0.05, 0.95)
          : clampRatio(keepOtherSpan / Math.max(1e-6, keepSpanNew), 0.05, 0.95);
        let nextRoot = replaceNodeInTree(root, remParent.id, remSibling);
        nextRoot = updateSplitRatio(nextRoot, keepParent.id, newKeepParentRatio);
        const nextLcaRatio = lcaEntry.branch === 'a'
          ? clampRatio(keepSpanNew / Math.max(1e-6, lcaTotal), 0.05, 0.95)
          : clampRatio((lcaTotal - keepSpanNew) / Math.max(1e-6, lcaTotal), 0.05, 0.95);
        nextRoot = updateSplitRatio(nextRoot, lcaNode.id, nextLcaRatio);
        return nextRoot;
      }
    }
  }

  // Case 3b: Quad-view / 4-pane symmetrical grid join across orthogonal split (e.g. TL + TR over [BL | BR])
  if (!keepDirect && !remDirect && pathKeep.length === lcaIndex + 2 && pathRem.length === lcaIndex + 2) {
    const keepEntry = pathKeep[pathKeep.length - 1];
    const remEntry = pathRem[pathRem.length - 1];
    const keepParent = keepEntry.node;
    const remParent = remEntry.node;
    if (
      lcaNode.direction === rel.direction &&
      keepParent.direction !== lcaNode.direction &&
      remParent.direction === keepParent.direction &&
      keepEntry.branch === remEntry.branch &&
      Math.abs(keepParent.ratio - remParent.ratio) < 1e-3
    ) {
      const keepOther = keepEntry.branch === 'a' ? keepParent.b : keepParent.a;
      const remOther = remEntry.branch === 'a' ? remParent.b : remParent.a;
      const leftOther = lcaEntry.branch === 'a' ? keepOther : remOther;
      const rightOther = lcaEntry.branch === 'a' ? remOther : keepOther;
      const pairedOther = {
        type: 'split',
        id: remParent.id,
        direction: lcaNode.direction,
        ratio: lcaNode.ratio,
        a: leftOther,
        b: rightOther,
      };
      const restructured = keepEntry.branch === 'a'
        ? { type: 'split', id: lcaNode.id, direction: keepParent.direction, ratio: keepParent.ratio, a: keepNode, b: pairedOther }
        : { type: 'split', id: lcaNode.id, direction: keepParent.direction, ratio: keepParent.ratio, a: pairedOther, b: keepNode };
      return replaceNodeInTree(root, lcaNode.id, restructured);
    }
  }

  return null;
}

function computeSubtreeSpan(node, rects, axisSpan) {
  if (node.type === 'leaf') return rects.get(node.id)?.[axisSpan] || 0;
  const leaves = listLeafNodes(node);
  if (node.direction === (axisSpan === 'w' ? 'vertical' : 'horizontal')) {
    return computeSubtreeSpan(node.a, rects, axisSpan) + computeSubtreeSpan(node.b, rects, axisSpan);
  }
  return rects.get(leaves[0]?.id)?.[axisSpan] || 0;
}

function replaceNodeInTree(root, targetId, replacement) {
  if (!root) return root;
  if (root.id === targetId) return replacement;
  if (root.type === 'leaf') return root;
  return {
    ...root,
    a: replaceNodeInTree(root.a, targetId, replacement),
    b: replaceNodeInTree(root.b, targetId, replacement),
  };
}

function replaceChildOnSplit(root, splitId, branch, replacement) {
  if (!root || root.type === 'leaf') return root;
  if (root.id === splitId) {
    return branch === 'a' ? { ...root, a: replacement } : { ...root, b: replacement };
  }
  return {
    ...root,
    a: replaceChildOnSplit(root.a, splitId, branch, replacement),
    b: replaceChildOnSplit(root.b, splitId, branch, replacement),
  };
}

export function updateSplitRatio(root, splitId, nextRatio) {
  if (!root || root.type === 'leaf') return root;
  const clamped = clampRatio(nextRatio, 0.08, 0.92);
  if (root.id === splitId) {
    return { ...root, ratio: clamped };
  }
  return {
    ...root,
    a: updateSplitRatio(root.a, splitId, clamped),
    b: updateSplitRatio(root.b, splitId, clamped),
  };
}

export function swapLeavesInTree(root, idA, idB) {
  if (!root || !idA || !idB || idA === idB) return root;
  const leafA = findLeafNode(root, idA);
  const leafB = findLeafNode(root, idB);
  if (!leafA || !leafB) return root;

  function walk(node) {
    if (node.type === 'leaf') {
      if (node.id === idA) return leafB;
      if (node.id === idB) return leafA;
      return node;
    }
    return { ...node, a: walk(node.a), b: walk(node.b) };
  }
  return walk(root);
}

/**
 * Classifies a corner-drag gesture at current client coordinates relative to leaf pixel rects.
 * Returns:
 * - `{ action: 'none' }` when drag distance < threshold
 * - `{ action: 'join', keepLeafId, removeLeafId, arrow }` when dragging outward into an aligned neighbor
 * - `{ action: 'close-bottom-dock', arrow: 'down' }` when dragging bottom corner down into visible #bottom-dock
 * - `{ action: 'split', leafId, direction, ratio, insertNewFirst }` when dragging inward
 */
export function classifyCornerDrag({
  root,
  sourceLeafId,
  corner, // 'tl' | 'tr' | 'bl' | 'br'
  startX,
  startY,
  curX,
  curY,
  domRects, // Map<leafId, { left, top, right, bottom, width, height }>
  bottomDockRect = null, // optional visible #bottom-dock rect
  threshold = 16,
}) {
  const dx = curX - startX;
  const dy = curY - startY;
  if (Math.hypot(dx, dy) < threshold) {
    return { action: 'none' };
  }

  const srcRect = domRects.get(sourceLeafId);
  if (!srcRect) return { action: 'none' };

  const pad = 6;
  const insideSource =
    curX >= srcRect.left - pad &&
    curX <= srcRect.right + pad &&
    curY >= srcRect.top - pad &&
    curY <= srcRect.bottom + pad;

  // 1. Outward drag into an adjacent area -> Join
  if (!insideSource) {
    for (const [candidateId, candRect] of domRects.entries()) {
      if (candidateId === sourceLeafId) continue;
      if (
        curX >= candRect.left &&
        curX <= candRect.right &&
        curY >= candRect.top &&
        curY <= candRect.bottom
      ) {
        const rel = canJoinLeaves(root, sourceLeafId, candidateId);
        if (rel) {
          let arrow = 'right';
          if (rel.direction === 'vertical') {
            arrow = candRect.left >= srcRect.right - 6 ? 'right' : 'left';
          } else {
            arrow = candRect.top >= srcRect.bottom - 6 ? 'down' : 'up';
          }
          return {
            action: 'join',
            keepLeafId: sourceLeafId,
            removeLeafId: candidateId,
            arrow,
          };
        }
      }
    }

    // Bottom corner pulled straight down into #bottom-dock -> collapse bottom dock like Blender Join
    if (
      bottomDockRect &&
      bottomDockRect.height > 20 &&
      (corner === 'bl' || corner === 'br') &&
      curY > srcRect.bottom + 14 &&
      curY >= bottomDockRect.top &&
      curX >= bottomDockRect.left &&
      curX <= bottomDockRect.right
    ) {
      return { action: 'close-bottom-dock', arrow: 'down' };
    }
  }

  // 2. Inward drag (or horizontal/vertical split inside source) -> Split
  const horizIntent = Math.abs(dx) >= Math.abs(dy);
  if (horizIntent) {
    const ratio = clampRatio((curX - srcRect.left) / Math.max(1, srcRect.width));
    const insertNewFirst = corner === 'tl' || corner === 'bl';
    return {
      action: 'split',
      leafId: sourceLeafId,
      direction: 'vertical',
      ratio,
      insertNewFirst,
      guidePos: srcRect.left + srcRect.width * ratio,
    };
  }

  const ratio = clampRatio((curY - srcRect.top) / Math.max(1, srcRect.height));
  const insertNewFirst = corner === 'tl' || corner === 'tr';
  return {
    action: 'split',
    leafId: sourceLeafId,
    direction: 'horizontal',
    ratio,
    insertNewFirst,
    guidePos: srcRect.top + srcRect.height * ratio,
  };
}

/**
 * Finds the best adjacent leaf that can join with `leafId` (used for context menu Join action).
 */
export function findFirstJoinableNeighbor(root, leafId) {
  const leaves = listLeafNodes(root);
  for (const other of leaves) {
    if (other.id !== leafId && canJoinLeaves(root, leafId, other.id)) {
      return other.id;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// WorkspaceAreaManager (Runtime + DOM + Multi-Viewport Cameras/Controls)
// ---------------------------------------------------------------------------

export class WorkspaceAreaManager {
  constructor(app) {
    this.app = app;
    this.engine = app?.engine || null;
    this.sceneManager = app?.sceneManager || null;
    this.cameraManager = app?.cameraManager || null;

    this.root = createLeafArea({
      id: 'area-main',
      editorType: 'viewport3d',
      cameraPreset: 'persp',
    });

    this.activeLeafId = 'area-main';
    this.maximizedLeafId = null;
    this._preQuadSnapshot = null;

    /** @type {Map<string, Object>} leafId -> runtime pane state */
    this.panes = new Map();
    /** @type {Map<string, HTMLElement>} leafId -> .area-leaf element */
    this.leafElements = new Map();
    /** @type {Map<string, HTMLElement>} leafId -> .area-pane-viewport body element */
    this.viewportElements = new Map();

    /** Singleton DOM editor mount registry for reparenting into split areas */
    this._mountedEditors = new Map(); // editorType -> { leafId, wrapperNode, homeContainer, anchorEl, placeholderEl }

    this.hostEl = null;
    this.overlayRoot = null;
    this._dragState = null;
    this._splitterDrag = null;
    this._previewGuideEl = null;
    this._joinOverlayEl = null;
    this._contextMenuEl = null;
    this._dockCornerCleanups = [];

    this._onPointerMoveBound = this._onWindowPointerMove.bind(this);
    this._onPointerUpBound = this._onWindowPointerUp.bind(this);
    this._onKeyDownBound = this._onWindowKeyDown.bind(this);
    this._onWindowClickBound = this._closeContextMenu.bind(this);
  }

  init() {
    this.engine = this.app?.engine || this.engine;
    this.sceneManager = this.app?.sceneManager || this.sceneManager;
    this.cameraManager = this.app?.cameraManager || this.cameraManager;
    this.hostEl = document.getElementById('viewport-canvas-host') || this.engine?.container;
    if (!this.hostEl) return;

    this.overlayRoot = document.getElementById('blender-area-root');
    if (!this.overlayRoot) {
      this.overlayRoot = document.createElement('div');
      this.overlayRoot.id = 'blender-area-root';
      this.overlayRoot.className = 'blender-area-root';
      this.hostEl.appendChild(this.overlayRoot);
    }

    // Bind primary root pane directly to Engine's primary camera & OrbitControls
    if (this.engine) {
      this.panes.set('area-main', {
        id: 'area-main',
        isPrimary: true,
        perspectiveCamera: this.engine.perspectiveCamera || this.engine.camera,
        orthographicCamera: this.engine.orthographicCamera,
        camera: this.engine.camera,
        controls: this.engine.controls,
        viewHelper: this.engine.viewHelper,
        shadingMode: 'inherit',
        showGrid: true,
        showGizmo: true,
        cameraPreset: 'persp',
        sceneCameraObj: null,
      });
    }

    this._bindDockCornerHandles();
    this._bindToolbarQuickButtons();
    this.renderLayout();

    window.addEventListener('pointermove', this._onPointerMoveBound);
    window.addEventListener('pointerup', this._onPointerUpBound);
    window.addEventListener('keydown', this._onKeyDownBound, true);
    window.addEventListener('pointerdown', this._onWindowClickBound, true);
  }

  dispose() {
    window.removeEventListener('pointermove', this._onPointerMoveBound);
    window.removeEventListener('pointerup', this._onPointerUpBound);
    window.removeEventListener('keydown', this._onKeyDownBound, true);
    window.removeEventListener('pointerdown', this._onWindowClickBound, true);
    for (const cleanup of this._dockCornerCleanups) cleanup();
    this._dockCornerCleanups = [];

    for (const editorType of Array.from(this._mountedEditors.keys())) {
      this._restoreEditorToHome(editorType);
    }
    for (const [id, pane] of this.panes.entries()) {
      if (!pane.isPrimary) this._disposePaneRuntime(pane);
    }
    this.panes.clear();
  }

  isSingleFullViewport() {
    return (
      !this.maximizedLeafId &&
      this.root?.type === 'leaf' &&
      this.root.editorType === 'viewport3d'
    );
  }

  getActiveLeafId() {
    return this.activeLeafId;
  }

  getActivePane() {
    return this.panes.get(this.activeLeafId) || this.panes.get('area-main') || null;
  }

  getViewportPanes() {
    const out = [];
    const leaves = this.maximizedLeafId
      ? [findLeafNode(this.root, this.maximizedLeafId)].filter(Boolean)
      : listLeafNodes(this.root);

    for (const leaf of leaves) {
      if (leaf.editorType !== 'viewport3d') continue;
      const pane = this.panes.get(leaf.id);
      const vpEl = this.viewportElements.get(leaf.id);
      if (pane && vpEl) {
        pane.leaf = leaf;
        pane.viewportEl = vpEl;
        out.push(pane);
      }
    }
    return out;
  }

  getAllViewportControls() {
    const ctrls = [];
    for (const pane of this.panes.values()) {
      if (pane.controls) ctrls.push(pane.controls);
    }
    return ctrls;
  }

  getPaneAtClientPoint(clientX, clientY) {
    for (const pane of this.getViewportPanes()) {
      const rect = pane.viewportEl?.getBoundingClientRect?.();
      if (!rect || rect.width <= 0 || rect.height <= 0) continue;
      if (
        clientX >= rect.left &&
        clientX <= rect.right &&
        clientY >= rect.top &&
        clientY <= rect.bottom
      ) {
        return pane;
      }
    }
    return this.getActivePane();
  }

  setActiveLeaf(leafId) {
    if (!leafId || !findLeafNode(this.root, leafId)) return;
    if (this.activeLeafId !== leafId) {
      this.activeLeafId = leafId;
      for (const [id, el] of this.leafElements.entries()) {
        el.classList.toggle('is-active-area', id === leafId);
      }
    }
    const leaf = findLeafNode(this.root, leafId);
    if (leaf?.editorType === 'viewport3d' && this.engine) {
      const pane = this.panes.get(leafId);
      if (pane && typeof this.engine.setActiveViewportPane === 'function') {
        this.engine.setActiveViewportPane(pane);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Public Area Operations
  // -------------------------------------------------------------------------

  splitLeaf(leafId = this.activeLeafId, direction = 'vertical', ratio = 0.5, insertNewFirst = false, newLeafOptions = {}) {
    if (!findLeafNode(this.root, leafId)) return null;
    this.maximizedLeafId = null;
    this._preQuadSnapshot = null;

    const srcPane = this.panes.get(leafId);
    const res = splitLeafInTree(this.root, leafId, direction, ratio, insertNewFirst, newLeafOptions);
    if (!res || !res.newLeaf) return null;

    this.root = res.node;
    this._ensurePaneRuntime(res.newLeaf, srcPane);
    this.activeLeafId = res.newLeaf.id;
    this.renderLayout();

    const newPane = this.panes.get(res.newLeaf.id);
    if (newPane && res.newLeaf.editorType === 'viewport3d') {
      if (newLeafOptions.cameraPreset && newLeafOptions.cameraPreset !== 'persp') {
        this.applyPaneCameraPreset(res.newLeaf.id, newLeafOptions.cameraPreset);
      }
      this.engine?.setActiveViewportPane?.(newPane);
    }

    this._dispatchLayoutChanged('split', res.newLeaf.id);
    return res.newLeaf;
  }

  joinLeaves(keepLeafId, removeLeafId) {
    const nextTree = joinLeavesInTree(this.root, keepLeafId, removeLeafId);
    if (!nextTree) return false;
    this.maximizedLeafId = null;
    this._preQuadSnapshot = null;

    const prevLeaves = new Set(listLeafNodes(this.root).map(l => l.id));
    this.root = nextTree;
    const nextLeaves = new Set(listLeafNodes(this.root).map(l => l.id));

    for (const oldId of prevLeaves) {
      if (!nextLeaves.has(oldId)) {
        const oldPane = this.panes.get(oldId);
        if (oldPane?.isPrimary) {
          const keepPane = this.panes.get(keepLeafId);
          if (keepPane && !keepPane.isPrimary) {
            keepPane.isPrimary = true;
            oldPane.isPrimary = false;
          } else {
            // Preserve primary runtime fallback in case keepLeaf is a non-3D editor
            this._primaryFallbackPane = oldPane;
            oldPane.isPrimary = false;
          }
        }
        this._cleanupRemovedLeaf(oldId);
      }
    }

    if (!findLeafNode(this.root, this.activeLeafId)) {
      this.activeLeafId = keepLeafId;
    }

    this.renderLayout();
    const keepPane = this.panes.get(this.activeLeafId) || this.getViewportPanes()[0];
    if (keepPane) this.engine?.setActiveViewportPane?.(keepPane);
    this._dispatchLayoutChanged('join', keepLeafId);
    return true;
  }

  closeLeaf(leafId) {
    const leaves = listLeafNodes(this.root);
    if (leaves.length <= 1) return false;
    const neighborId = findFirstJoinableNeighbor(this.root, leafId);
    if (neighborId) {
      return this.joinLeaves(neighborId, leafId);
    }
    return false;
  }

  swapLeaves(leafIdA, leafIdB) {
    const next = swapLeavesInTree(this.root, leafIdA, leafIdB);
    if (!next || next === this.root) return false;
    this.root = next;
    this.renderLayout();
    this._dispatchLayoutChanged('swap', leafIdA);
    return true;
  }

  resetToSingleViewport() {
    this.maximizedLeafId = null;
    this._preQuadSnapshot = null;
    for (const editorType of Array.from(this._mountedEditors.keys())) {
      this._restoreEditorToHome(editorType);
    }
    for (const [id, pane] of Array.from(this.panes.entries())) {
      if (!pane.isPrimary) {
        this._disposePaneRuntime(pane);
        this.panes.delete(id);
      }
    }

    let mainLeaf = findLeafNode(this.root, 'area-main');
    if (!mainLeaf) {
      mainLeaf = createLeafArea({ id: 'area-main', editorType: 'viewport3d', cameraPreset: 'persp' });
    } else {
      mainLeaf.editorType = 'viewport3d';
    }
    if (!this.panes.has('area-main')) {
      const survivor = this._primaryFallbackPane || this.getViewportPanes()[0] || null;
      if (survivor) {
        survivor.id = 'area-main';
        survivor.isPrimary = true;
        this.panes.set('area-main', survivor);
        this._primaryFallbackPane = null;
      } else {
        this._ensurePaneRuntime(mainLeaf, null);
        const created = this.panes.get('area-main');
        if (created) created.isPrimary = true;
      }
    }
    this.root = mainLeaf;
    this.activeLeafId = 'area-main';
    this.renderLayout();
    const primary = this.panes.get('area-main');
    if (primary) this.engine?.setActiveViewportPane?.(primary);
    this._dispatchLayoutChanged('reset', 'area-main');
    return true;
  }

  toggleQuadView() {
    if (this._preQuadSnapshot) {
      // Restore layout before Quad View
      for (const editorType of Array.from(this._mountedEditors.keys())) {
        this._restoreEditorToHome(editorType);
      }
      for (const [id, pane] of Array.from(this.panes.entries())) {
        if (!pane.isPrimary) {
          this._disposePaneRuntime(pane);
          this.panes.delete(id);
        }
      }
      this.root = cloneAreaTree(this._preQuadSnapshot);
      this._preQuadSnapshot = null;
      this.maximizedLeafId = null;
      const leaves = listLeafNodes(this.root);
      for (const leaf of leaves) {
        this._ensurePaneRuntime(leaf, this.panes.get('area-main'));
      }
      this.activeLeafId = leaves[0]?.id || 'area-main';
      this.renderLayout();
      const activePane = this.panes.get(this.activeLeafId);
      if (activePane) this.engine?.setActiveViewportPane?.(activePane);
      this._dispatchLayoutChanged('quad-off', this.activeLeafId);
      return false;
    }

    // Snapshot current tree & create 4-way Quad View: Top Ortho | Persp / Front Ortho | Right Ortho
    this._preQuadSnapshot = cloneAreaTree(this.root);
    this.maximizedLeafId = null;
    for (const editorType of Array.from(this._mountedEditors.keys())) {
      this._restoreEditorToHome(editorType);
    }

    const tl = createLeafArea({ id: 'quad-top', editorType: 'viewport3d', cameraPreset: 'top' });
    const bl = createLeafArea({ id: 'quad-front', editorType: 'viewport3d', cameraPreset: 'front' });
    const tr = createLeafArea({ id: 'area-main', editorType: 'viewport3d', cameraPreset: 'persp' });
    const br = createLeafArea({ id: 'quad-right', editorType: 'viewport3d', cameraPreset: 'right' });

    this.root = {
      id: _genId('split'),
      type: 'split',
      direction: 'vertical',
      ratio: 0.5,
      a: { id: _genId('split'), type: 'split', direction: 'horizontal', ratio: 0.5, a: tl, b: bl },
      b: { id: _genId('split'), type: 'split', direction: 'horizontal', ratio: 0.5, a: tr, b: br },
    };

    const src = this.panes.get('area-main');
    for (const leaf of [tl, bl, tr, br]) {
      this._ensurePaneRuntime(leaf, src);
    }

    this.activeLeafId = tr.id;
    this.renderLayout();

    // Apply Blender orthographic presets to Top, Front, Right panes
    this.applyPaneCameraPreset(tl.id, 'top', true);
    this.applyPaneCameraPreset(bl.id, 'front', true);
    this.applyPaneCameraPreset(br.id, 'right', true);
    this.setActiveLeaf(tr.id);
    this._dispatchLayoutChanged('quad-on', tr.id);
    return true;
  }

  toggleMaximizeLeaf(leafId = this.activeLeafId) {
    if (this.maximizedLeafId === leafId) {
      this.maximizedLeafId = null;
    } else if (listLeafNodes(this.root).length > 1) {
      this.maximizedLeafId = leafId;
    } else {
      return false;
    }
    this.renderLayout();
    const candidateId = this.maximizedLeafId || this.activeLeafId;
    const candidateLeaf = findLeafNode(this.root, candidateId);
    if (candidateLeaf?.editorType === 'viewport3d') {
      this.setActiveLeaf(candidateId);
    } else {
      const fallbackVp = this.getViewportPanes()[0];
      if (fallbackVp) this.setActiveLeaf(fallbackVp.leaf?.id || fallbackVp.id);
    }
    this._dispatchLayoutChanged('maximize', leafId);
    return Boolean(this.maximizedLeafId);
  }

  setLeafEditorType(leafId, editorType) {
    const leaf = findLeafNode(this.root, leafId);
    if (!leaf || leaf.editorType === editorType) return;

    const prevType = leaf.editorType;
    if (prevType !== 'viewport3d') {
      this._restoreEditorToHome(prevType);
    }

    leaf.editorType = editorType;
    if (editorType === 'viewport3d') {
      this._ensurePaneRuntime(leaf, this.panes.get('area-main'));
    } else {
      // Ensure editor isn't mounted in another leaf
      const prevOwner = this._mountedEditors.get(editorType)?.leafId;
      if (prevOwner && prevOwner !== leafId) {
        const ownerLeaf = findLeafNode(this.root, prevOwner);
        if (ownerLeaf) ownerLeaf.editorType = 'viewport3d';
        this._restoreEditorToHome(editorType);
      }
    }

    this.renderLayout();
    if (editorType === 'viewport3d') {
      this.setActiveLeaf(leafId);
    } else if (this.activeLeafId === leafId) {
      const fallbackVp = this.getViewportPanes()[0];
      if (fallbackVp) this.setActiveLeaf(fallbackVp.leaf?.id || fallbackVp.id);
    }
    this._dispatchLayoutChanged('editor-change', leafId);
  }

  applyPaneCameraPreset(leafId, preset, orthoForCardinal = false) {
    const leaf = findLeafNode(this.root, leafId);
    const pane = this.panes.get(leafId);
    if (!leaf || !pane || !this.engine) return;

    if (preset === 'camera') {
      this.togglePaneSceneCamera(leafId);
      return;
    }

    pane.sceneCameraObj = null;
    leaf.cameraPreset = preset;
    pane.cameraPreset = preset;

    const prevPane = this.engine.activeViewportPane;
    this.engine.setActiveViewportPane(pane);

    const viewPreset = preset === 'persp' ? 'isometric' : preset;
    if (typeof this.engine.setCameraPreset === 'function') {
      this.engine.setCameraPreset(viewPreset);
    }
    if (orthoForCardinal && !pane.camera.isOrthographicCamera && typeof this.engine.toggleProjection === 'function') {
      this.engine.toggleProjection({ force: true });
    } else if (preset === 'persp' && pane.camera.isOrthographicCamera && typeof this.engine.toggleProjection === 'function') {
      this.engine.toggleProjection({ force: true });
    }

    if (prevPane && prevPane !== pane) {
      this.engine.setActiveViewportPane(prevPane);
    }
    this._refreshPaneInfoLabel(leafId);
  }

  togglePaneProjection(leafId) {
    const pane = this.panes.get(leafId);
    if (!pane || !this.engine) return;
    pane.sceneCameraObj = null;
    const prevPane = this.engine.activeViewportPane;
    this.engine.setActiveViewportPane(pane);
    this.engine.toggleProjection({ force: true });
    if (prevPane && prevPane !== pane) {
      this.engine.setActiveViewportPane(prevPane);
    }
    this._refreshPaneInfoLabel(leafId);
  }

  togglePaneSceneCamera(leafId) {
    const pane = this.panes.get(leafId);
    const leaf = findLeafNode(this.root, leafId);
    if (!pane || !leaf || !this.engine) return;

    if (this.isSingleFullViewport()) {
      this.cameraManager?.toggleViewCamera?.(this.sceneManager?.getActiveObject?.());
      return;
    }

    if (pane.sceneCameraObj) {
      pane.sceneCameraObj = null;
      leaf.cameraPreset = 'persp';
      pane.cameraPreset = 'persp';
    } else {
      const camMgr = this.cameraManager || window.cameraManager;
      let camObj = camMgr?.getActiveCameraObject?.() || camMgr?.cameras?.[0]?.group;
      if (!camObj && camMgr?.createCamera) {
        camObj = camMgr.createCamera();
      }
      if (camObj) {
        pane.sceneCameraObj = camObj;
        leaf.cameraPreset = 'camera';
        pane.cameraPreset = 'camera';
      }
    }
    this._refreshPaneInfoLabel(leafId);
  }

  // -------------------------------------------------------------------------
  // Pane Runtime Lifecycle
  // -------------------------------------------------------------------------

  _ensurePaneRuntime(leaf, sourcePane = null) {
    if (leaf.editorType !== 'viewport3d') return null;
    const existing = this.panes.get(leaf.id);
    if (existing) return existing;

    const hostW = this.hostEl?.clientWidth || 800;
    const hostH = this.hostEl?.clientHeight || 500;
    const aspect = Math.max(0.1, hostW / Math.max(1, hostH));

    const srcCam = sourcePane?.camera || this.engine?.camera;
    const srcTarget = sourcePane?.controls?.target || this.engine?.controls?.target || new THREE.Vector3();

    const persp = new THREE.PerspectiveCamera(
      srcCam?.fov || this.engine?.options?.fov || 50,
      aspect,
      this.engine?.options?.near || 0.1,
      this.engine?.options?.far || 2000
    );
    if (srcCam) {
      persp.position.copy(srcCam.position);
      persp.quaternion.copy(srcCam.quaternion);
      persp.up.copy(srcCam.up);
    } else {
      persp.position.set(7, 5, 8);
      persp.lookAt(0, 0, 0);
    }

    const ortho = new THREE.OrthographicCamera(
      -5 * aspect,
      5 * aspect,
      5,
      -5,
      this.engine?.options?.near || 0.1,
      this.engine?.options?.far || 2000
    );
    ortho.position.copy(persp.position);
    ortho.quaternion.copy(persp.quaternion);

    const activeCam = persp;
    const controls = this.engine?.domElement
      ? new OrbitControls(activeCam, this.engine.domElement)
      : null;

    if (controls) {
      controls.enableDamping = true;
      controls.dampingFactor = 0.05;
      controls.screenSpacePanning = true;
      controls.minDistance = 0.5;
      controls.maxDistance = 1500;
      controls.target.copy(srcTarget);
      controls.enabled = false;
      controls.update();
      controls.addEventListener('start', () => this.engine?.requestRender?.());
      controls.addEventListener('change', () => this.engine?.requestRender?.());

      const keymapPreset = this.app?.blenderProTools?.keymapPreset || this.engine?.keymapPreset || 'blender-pro';
      if (keymapPreset === 'blender-pro') {
        controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: null };
      } else {
        controls.mouseButtons = {
          LEFT: THREE.MOUSE.ROTATE,
          MIDDLE: THREE.MOUSE.ROTATE,
          RIGHT: THREE.MOUSE.PAN,
        };
      }
    }

    let viewHelper = null;
    if (this.engine?.createViewHelper) {
      viewHelper = this.engine.createViewHelper(activeCam, controls);
    } else if (this.engine?.domElement) {
      try {
        viewHelper = new ViewHelper(activeCam, this.engine.domElement);
        if (controls) viewHelper.center = controls.target;
      } catch (_) {
        viewHelper = null;
      }
    }

    const runtime = {
      id: leaf.id,
      isPrimary: false,
      perspectiveCamera: persp,
      orthographicCamera: ortho,
      camera: activeCam,
      controls,
      viewHelper,
      shadingMode: leaf.shadingMode || 'inherit',
      showGrid: leaf.showGrid !== false,
      showGizmo: leaf.showGizmo !== false,
      cameraPreset: leaf.cameraPreset || 'persp',
      sceneCameraObj: null,
    };
    this.panes.set(leaf.id, runtime);
    return runtime;
  }

  _disposePaneRuntime(pane) {
    if (!pane || pane.isPrimary) return;
    pane.controls?.dispose?.();
    pane.viewHelper?.dispose?.();
  }

  _cleanupRemovedLeaf(leafId) {
    const pane = this.panes.get(leafId);
    if (pane && pane !== this._primaryFallbackPane && !pane.isPrimary) {
      this._disposePaneRuntime(pane);
      this.panes.delete(leafId);
    } else if (pane && pane === this._primaryFallbackPane) {
      this.panes.delete(leafId);
    }
    this.leafElements.delete(leafId);
    this.viewportElements.delete(leafId);
    for (const [editorType, entry] of this._mountedEditors.entries()) {
      if (entry.leafId === leafId) {
        this._restoreEditorToHome(editorType);
      }
    }
  }

  // -------------------------------------------------------------------------
  // DOM Layout Rendering (BSP Tree -> Flex Splits + Corner Handles)
  // -------------------------------------------------------------------------

  renderLayout() {
    if (!this.overlayRoot) return;

    // Detach any currently mounted singleton DOM editors cleanly before rebuilding DOM
    const leaves = listLeafNodes(this.root);
    const activeNonVp = new Set(leaves.filter(l => l.editorType !== 'viewport3d').map(l => l.editorType));
    for (const mountedType of Array.from(this._mountedEditors.keys())) {
      if (!activeNonVp.has(mountedType)) {
        this._restoreEditorToHome(mountedType);
      }
    }

    this.overlayRoot.innerHTML = '';
    this.leafElements.clear();
    this.viewportElements.clear();

    const isSingle = this.isSingleFullViewport();
    document.body.classList.toggle('has-multi-areas', !isSingle);

    if (this.maximizedLeafId) {
      const maxLeaf = findLeafNode(this.root, this.maximizedLeafId);
      if (maxLeaf) {
        this.overlayRoot.appendChild(this._buildLeafElement(maxLeaf, true));
      } else {
        this.maximizedLeafId = null;
      }
    }

    if (!this.maximizedLeafId) {
      this.overlayRoot.appendChild(this._buildNodeElement(this.root, isSingle));
    }

    // Refresh splitter quick UI buttons if present
    const splitBtn = document.getElementById('btn-split-viewport');
    if (splitBtn) splitBtn.classList.toggle('active', !isSingle);
    const quadBtn = document.getElementById('btn-quad-view');
    if (quadBtn) quadBtn.classList.toggle('active', Boolean(this._preQuadSnapshot));

    requestAnimationFrame(() => {
      this.engine?.onResize?.();
      this._refreshMountedEditors();
    });
  }

  _buildNodeElement(node, isSingleRoot = false) {
    if (node.type === 'leaf') {
      return this._buildLeafElement(node, !isSingleRoot);
    }

    const wrap = document.createElement('div');
    wrap.className = `area-split-container area-split-${node.direction}`;
    wrap.dataset.splitId = node.id;

    const pctA = (clampRatio(node.ratio) * 100).toFixed(4);
    const pctB = ((1 - clampRatio(node.ratio)) * 100).toFixed(4);

    const slotA = document.createElement('div');
    slotA.className = 'area-split-slot';
    slotA.style.flex = `0 0 calc(${pctA}% - 2px)`;
    slotA.appendChild(this._buildNodeElement(node.a, false));

    const splitter = document.createElement('div');
    splitter.className = `area-splitter ${node.direction}`;
    splitter.dataset.splitId = node.id;
    splitter.title = 'Drag to resize • Right-click to Split / Join / Swap';
    splitter.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      this._startSplitterDrag(node, wrap, slotA, slotB, e);
    });
    splitter.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this._openSplitterContextMenu(node, e.clientX, e.clientY);
    });

    const slotB = document.createElement('div');
    slotB.className = 'area-split-slot';
    slotB.style.flex = `1 1 ${pctB}%`;
    slotB.appendChild(this._buildNodeElement(node.b, false));

    wrap.appendChild(slotA);
    wrap.appendChild(splitter);
    wrap.appendChild(slotB);
    return wrap;
  }

  _buildLeafElement(leaf, showPaneChrome = true) {
    const el = document.createElement('div');
    el.className = 'area-leaf';
    if (leaf.id === this.activeLeafId && showPaneChrome) {
      el.classList.add('is-active-area');
    }
    el.dataset.areaId = leaf.id;
    el.dataset.editorType = leaf.editorType;
    this.leafElements.set(leaf.id, el);

    if (showPaneChrome) {
      el.appendChild(this._buildPaneHeader(leaf));
    }

    const body = document.createElement('div');
    body.className = leaf.editorType === 'viewport3d'
      ? 'area-pane-viewport'
      : 'area-dom-content';

    if (leaf.editorType === 'viewport3d') {
      this.viewportElements.set(leaf.id, body);
      if (showPaneChrome) {
        const tag = document.createElement('div');
        tag.className = 'area-pane-info-tag';
        tag.dataset.infoFor = leaf.id;
        body.appendChild(tag);
      }
    } else {
      this._mountEditorIntoContainer(leaf, body);
    }

    el.appendChild(body);
    if (showPaneChrome) {
      this._refreshPaneInfoLabel(leaf.id, el);
    }

    // 4 Corner Drag Handles (tl, tr, bl, br) — authentic Blender corner split/join zones
    for (const corner of ['tl', 'tr', 'bl', 'br']) {
      const handle = document.createElement('div');
      handle.className = `area-corner-handle area-corner-${corner}`;
      handle.dataset.corner = corner;
      handle.dataset.areaId = leaf.id;
      handle.title = 'Drag inward to Split area • Drag into adjacent area to Join • Right-click menu';
      handle.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        this._startCornerDrag(leaf.id, corner, e);
      });
      handle.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this._openAreaContextMenu(leaf.id, e.clientX, e.clientY);
      });
      el.appendChild(handle);
    }

    return el;
  }

  _buildPaneHeader(leaf) {
    const header = document.createElement('div');
    header.className = 'area-pane-header';
    header.addEventListener('pointerdown', () => this.setActiveLeaf(leaf.id));

    const left = document.createElement('div');
    left.className = 'area-header-group area-header-left';

    // Editor Type switcher (Blender top-left area selector)
    const editorSel = document.createElement('select');
    editorSel.className = 'area-header-select';
    editorSel.title = 'Switch Editor Type';
    for (const ed of EDITOR_TYPES) {
      const opt = document.createElement('option');
      opt.value = ed.id;
      opt.textContent = ed.label;
      if (ed.id === leaf.editorType) opt.selected = true;
      editorSel.appendChild(opt);
    }
    editorSel.addEventListener('change', (e) => {
      this.setLeafEditorType(leaf.id, e.target.value);
    });
    left.appendChild(editorSel);

    const pane = this.panes.get(leaf.id);

    if (leaf.editorType === 'viewport3d' && pane) {
      // Viewpoint Preset
      const viewSel = document.createElement('select');
      viewSel.className = 'area-header-select area-view-select';
      viewSel.title = 'Viewport angle for this area (Persp / Front / Right / Top / Camera)';
      for (const vp of VIEWPORT_PRESET_OPTIONS) {
        const opt = document.createElement('option');
        opt.value = vp.id;
        opt.textContent = vp.label;
        if (vp.id === (leaf.cameraPreset || 'persp')) opt.selected = true;
        viewSel.appendChild(opt);
      }
      viewSel.addEventListener('change', (e) => {
        const val = e.target.value;
        this.applyPaneCameraPreset(leaf.id, val, val !== 'persp' && val !== 'camera');
      });
      left.appendChild(viewSel);

      // Perspective / Orthographic button
      const projBtn = document.createElement('button');
      projBtn.type = 'button';
      projBtn.className = 'area-header-btn';
      projBtn.textContent = pane.camera?.isOrthographicCamera ? 'Ortho' : 'Persp';
      projBtn.title = 'Toggle Perspective / Orthographic (Numpad 5)';
      projBtn.addEventListener('click', () => {
        this.togglePaneProjection(leaf.id);
        projBtn.textContent = pane.camera?.isOrthographicCamera ? 'Ortho' : 'Persp';
      });
      left.appendChild(projBtn);

      // Shading override (Inherit / Wire / Solid)
      const shadeSel = document.createElement('select');
      shadeSel.className = 'area-header-select';
      shadeSel.title = 'Viewport shading override for this area';
      for (const [val, lbl] of [
        ['inherit', 'Shade: Global'],
        ['wireframe', 'Wireframe'],
        ['solid', 'Solid'],
      ]) {
        const opt = document.createElement('option');
        opt.value = val;
        opt.textContent = lbl;
        if ((pane.shadingMode || 'inherit') === val) opt.selected = true;
        shadeSel.appendChild(opt);
      }
      shadeSel.addEventListener('change', (e) => {
        pane.shadingMode = e.target.value;
        leaf.shadingMode = e.target.value;
      });
      left.appendChild(shadeSel);

      // Grid toggle
      const gridBtn = document.createElement('button');
      gridBtn.type = 'button';
      gridBtn.className = `area-header-btn ${pane.showGrid !== false ? 'active' : ''}`;
      gridBtn.textContent = 'Grid';
      gridBtn.title = 'Toggle floor grid in this area';
      gridBtn.addEventListener('click', () => {
        pane.showGrid = !pane.showGrid;
        leaf.showGrid = pane.showGrid;
        gridBtn.classList.toggle('active', pane.showGrid);
      });
      left.appendChild(gridBtn);
    }

    const right = document.createElement('div');
    right.className = 'area-header-group area-header-right';

    const splitVBtn = document.createElement('button');
    splitVBtn.type = 'button';
    splitVBtn.className = 'area-header-btn';
    splitVBtn.textContent = 'Split |';
    splitVBtn.title = 'Vertical Split (Left | Right)';
    splitVBtn.addEventListener('click', () => this.splitLeaf(leaf.id, 'vertical', 0.5));
    right.appendChild(splitVBtn);

    const splitHBtn = document.createElement('button');
    splitHBtn.type = 'button';
    splitHBtn.className = 'area-header-btn';
    splitHBtn.textContent = 'Split ─';
    splitHBtn.title = 'Horizontal Split (Top / Bottom)';
    splitHBtn.addEventListener('click', () => this.splitLeaf(leaf.id, 'horizontal', 0.5));
    right.appendChild(splitHBtn);

    const maxBtn = document.createElement('button');
    maxBtn.type = 'button';
    maxBtn.className = `area-header-btn ${this.maximizedLeafId === leaf.id ? 'active' : ''}`;
    maxBtn.textContent = this.maximizedLeafId === leaf.id ? '⤡' : '⤢';
    maxBtn.title = 'Maximize / Restore Area';
    maxBtn.addEventListener('click', () => this.toggleMaximizeLeaf(leaf.id));
    right.appendChild(maxBtn);

    if (listLeafNodes(this.root).length > 1) {
      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'area-header-btn area-header-close';
      closeBtn.textContent = '×';
      closeBtn.title = 'Close / Join into adjacent area';
      closeBtn.addEventListener('click', () => this.closeLeaf(leaf.id));
      right.appendChild(closeBtn);
    }

    header.appendChild(left);
    header.appendChild(right);
    return header;
  }

  _refreshPaneInfoLabel(leafId, scopeEl = null) {
    const leaf = findLeafNode(this.root, leafId);
    const pane = this.panes.get(leafId);
    const rootEl = scopeEl || this.leafElements.get(leafId);
    if (!leaf || !pane || !rootEl) return;
    const tag = rootEl.querySelector(`.area-pane-info-tag[data-info-for="${leafId}"]`);
    if (!tag) return;

    if (pane.sceneCameraObj) {
      tag.textContent = `Camera: ${pane.sceneCameraObj.name || 'Camera'}`;
      return;
    }
    const proj = pane.camera?.isOrthographicCamera ? 'Orthographic' : 'Perspective';
    const presetMap = {
      persp: 'User',
      front: 'Front',
      back: 'Back',
      right: 'Right',
      left: 'Left',
      top: 'Top',
      bottom: 'Bottom',
    };
    const prefix = presetMap[leaf.cameraPreset] || 'User';
    tag.textContent = `${prefix} ${proj}`;
  }

  // -------------------------------------------------------------------------
  // Corner Drag Split & Join Interaction
  // -------------------------------------------------------------------------

  _collectDomRectsMap() {
    const map = new Map();
    for (const [id, el] of this.leafElements.entries()) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        map.set(id, {
          left: r.left,
          top: r.top,
          right: r.right,
          bottom: r.bottom,
          width: r.width,
          height: r.height,
        });
      }
    }
    return map;
  }

  _startCornerDrag(leafId, corner, event) {
    this._closeContextMenu();
    this.setActiveLeaf(leafId);

    // Disable OrbitControls on canvas while dragging area corners
    for (const ctrl of this.getAllViewportControls()) {
      ctrl.enabled = false;
    }

    this._dragState = {
      sourceLeafId: leafId,
      corner,
      startX: event.clientX,
      startY: event.clientY,
      lastResult: { action: 'none' },
      domRects: this._collectDomRectsMap(),
    };
    document.body.classList.add('is-dragging-area-corner');
  }

  _bindDockCornerHandles() {
    const bottomDock = document.getElementById('bottom-dock');
    if (!bottomDock || bottomDock.querySelector('.dock-corner-handle')) return;

    for (const corner of ['tl', 'tr']) {
      const handle = document.createElement('div');
      handle.className = `dock-corner-handle dock-corner-${corner}`;
      handle.title = 'Drag up into Viewport to promote editor into a Split Area';
      const onDown = (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        this._startDockPromotionDrag(corner, e);
      };
      handle.addEventListener('pointerdown', onDown);
      this._dockCornerCleanups.push(() => handle.removeEventListener('pointerdown', onDown));
      bottomDock.appendChild(handle);
    }
  }

  _startDockPromotionDrag(corner, event) {
    this._closeContextMenu();
    const activeDockTab = document.querySelector('.dock-tab.active')?.dataset.pane || '';
    const dockToEditorMap = {
      'dock-uv-editor': 'uv-editor',
      'dock-timeline': 'timeline',
      'dock-graph-editor': 'graph-editor',
      'dock-scripting': 'scripting',
      'dock-materials': 'materials',
      'dock-physics': 'physics',
    };
    const editorType = dockToEditorMap[activeDockTab] || 'viewport3d';
    const hostRect = this.hostEl?.getBoundingClientRect();
    if (!hostRect) return;

    this._dragState = {
      fromBottomDock: true,
      editorType,
      corner,
      startX: event.clientX,
      startY: event.clientY,
      hostRect,
      lastResult: { action: 'none' },
    };
    document.body.classList.add('is-dragging-area-corner');
  }

  _onWindowPointerMove(event) {
    if (this._splitterDrag) {
      this._updateSplitterDrag(event);
      return;
    }
    if (!this._dragState) return;

    if (this._dragState.fromBottomDock) {
      const st = this._dragState;
      const dy = st.startY - event.clientY;
      if (dy > 24 && event.clientY < st.hostRect.bottom) {
        const ratio = clampRatio((event.clientY - st.hostRect.top) / Math.max(1, st.hostRect.height));
        st.lastResult = {
          action: 'split-bottom-promote',
          ratio,
          guidePos: st.hostRect.top + st.hostRect.height * ratio,
          editorType: st.editorType,
        };
        this._showSplitGuide('horizontal', st.hostRect, st.lastResult.guidePos);
      } else {
        st.lastResult = { action: 'none' };
        this._clearDragOverlays();
      }
      return;
    }

    const st = this._dragState;
    const dockEl = document.getElementById('bottom-dock');
    const dockStyle = dockEl ? window.getComputedStyle(dockEl) : null;
    const bottomDockRect =
      dockEl && dockStyle && dockStyle.display !== 'none'
        ? dockEl.getBoundingClientRect()
        : null;

    const result = classifyCornerDrag({
      root: this.root,
      sourceLeafId: st.sourceLeafId,
      corner: st.corner,
      startX: st.startX,
      startY: st.startY,
      curX: event.clientX,
      curY: event.clientY,
      domRects: st.domRects,
      bottomDockRect,
    });
    st.lastResult = result;

    if (result.action === 'split') {
      const srcRect = st.domRects.get(result.leafId);
      if (srcRect) {
        this._hideJoinOverlay();
        this._showSplitGuide(result.direction, srcRect, result.guidePos);
      }
    } else if (result.action === 'join') {
      this._hideSplitGuide();
      const targetRect = st.domRects.get(result.removeLeafId);
      if (targetRect) {
        this._showJoinOverlay(targetRect, result.arrow, 'Release to Join Area');
      }
    } else if (result.action === 'close-bottom-dock' && bottomDockRect) {
      this._hideSplitGuide();
      this._showJoinOverlay(bottomDockRect, 'down', 'Release to Close Bottom Dock');
    } else {
      this._clearDragOverlays();
    }
  }

  _onWindowPointerUp() {
    if (this._splitterDrag) {
      this._splitterDrag = null;
      document.body.classList.remove('is-resizing-split');
      this.engine?.onResize?.();
      this._refreshMountedEditors();
      if (typeof window !== 'undefined') window.dispatchEvent(new Event('resize'));
      return;
    }
    if (!this._dragState) return;

    const st = this._dragState;
    const res = st.lastResult || { action: 'none' };
    this._dragState = null;
    this._clearDragOverlays();
    document.body.classList.remove('is-dragging-area-corner');

    if (res.action === 'split') {
      this.splitLeaf(res.leafId, res.direction, res.ratio, res.insertNewFirst);
    } else if (res.action === 'join') {
      this.joinLeaves(res.keepLeafId, res.removeLeafId);
    } else if (res.action === 'close-bottom-dock') {
      this.app?.blenderProTools?.toggleBottomDock?.(true);
    } else if (res.action === 'split-bottom-promote') {
      const targetLeaf = listLeafNodes(this.root).find(l => l.editorType === 'viewport3d')?.id || this.activeLeafId;
      this.splitLeaf(targetLeaf, 'horizontal', res.ratio, false, {
        editorType: res.editorType,
      });
    }

    this.engine?.syncViewportPaneControls?.();
  }

  _onWindowKeyDown(e) {
    if (e.key === 'Escape' && this._dragState) {
      e.preventDefault();
      e.stopPropagation();
      this._dragState = null;
      this._clearDragOverlays();
      document.body.classList.remove('is-dragging-area-corner');
      this.engine?.syncViewportPaneControls?.();
    }
  }

  // -------------------------------------------------------------------------
  // Split & Join Visual Feedback Overlays
  // -------------------------------------------------------------------------

  _showSplitGuide(direction, rect, guideClientPos) {
    if (!this._previewGuideEl) {
      this._previewGuideEl = document.createElement('div');
      this._previewGuideEl.className = 'area-split-guide';
      document.body.appendChild(this._previewGuideEl);
    }
    const g = this._previewGuideEl;
    g.style.display = 'block';
    g.dataset.dir = direction;

    if (direction === 'vertical') {
      g.style.left = `${Math.round(guideClientPos)}px`;
      g.style.top = `${Math.round(rect.top)}px`;
      g.style.width = '2px';
      g.style.height = `${Math.round(rect.height)}px`;
      g.innerHTML = '<span class="area-split-guide-tag">Split Left | Right</span>';
    } else {
      g.style.left = `${Math.round(rect.left)}px`;
      g.style.top = `${Math.round(guideClientPos)}px`;
      g.style.width = `${Math.round(rect.width)}px`;
      g.style.height = '2px';
      g.innerHTML = '<span class="area-split-guide-tag">Split Top / Bottom</span>';
    }
  }

  _hideSplitGuide() {
    if (this._previewGuideEl) this._previewGuideEl.style.display = 'none';
  }

  _showJoinOverlay(targetRect, arrow, label) {
    if (!this._joinOverlayEl) {
      this._joinOverlayEl = document.createElement('div');
      this._joinOverlayEl.className = 'area-join-overlay';
      document.body.appendChild(this._joinOverlayEl);
    }
    const el = this._joinOverlayEl;
    const arrowGlyph = { left: '←', right: '→', up: '↑', down: '↓' }[arrow] || '→';
    el.style.display = 'flex';
    el.style.left = `${Math.round(targetRect.left)}px`;
    el.style.top = `${Math.round(targetRect.top)}px`;
    el.style.width = `${Math.round(targetRect.width)}px`;
    el.style.height = `${Math.round(targetRect.height)}px`;
    el.innerHTML = `<div class="area-join-arrow">${arrowGlyph}</div><div class="area-join-label">${label}</div>`;
  }

  _hideJoinOverlay() {
    if (this._joinOverlayEl) this._joinOverlayEl.style.display = 'none';
  }

  _clearDragOverlays() {
    this._hideSplitGuide();
    this._hideJoinOverlay();
  }

  // -------------------------------------------------------------------------
  // Border Splitter Resize
  // -------------------------------------------------------------------------

  _startSplitterDrag(splitNode, containerEl, slotA, slotB, event) {
    const rect = containerEl.getBoundingClientRect();
    this._splitterDrag = { splitNode, rect, slotA, slotB };
    document.body.classList.add('is-resizing-split');
  }

  _updateSplitterDrag(event) {
    const sd = this._splitterDrag;
    if (!sd) return;
    const { splitNode, rect, slotA, slotB } = sd;
    const raw =
      splitNode.direction === 'vertical'
        ? (event.clientX - rect.left) / Math.max(1, rect.width)
        : (event.clientY - rect.top) / Math.max(1, rect.height);
    const ratio = clampRatio(raw);
    splitNode.ratio = ratio;

    const pctA = (ratio * 100).toFixed(4);
    const pctB = ((1 - ratio) * 100).toFixed(4);
    slotA.style.flex = `0 0 calc(${pctA}% - 2px)`;
    slotB.style.flex = `1 1 ${pctB}%`;
    this.engine?.onResize?.();
  }

  // -------------------------------------------------------------------------
  // Context Menus (Right-click Splitter or Corner)
  // -------------------------------------------------------------------------

  _closeContextMenu(e = null) {
    if (e && this._contextMenuEl && this._contextMenuEl.contains(e.target)) return;
    if (this._contextMenuEl) {
      this._contextMenuEl.remove();
      this._contextMenuEl = null;
    }
  }

  _showMenuAt(items, clientX, clientY) {
    this._closeContextMenu();
    const menu = document.createElement('div');
    menu.className = 'area-context-menu';

    for (const item of items) {
      if (item.divider) {
        const div = document.createElement('div');
        div.className = 'area-context-divider';
        menu.appendChild(div);
        continue;
      }
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'area-context-item';
      btn.disabled = Boolean(item.disabled);
      btn.textContent = item.label;
      btn.addEventListener('click', () => {
        this._closeContextMenu();
        item.action?.();
      });
      menu.appendChild(btn);
    }

    document.body.appendChild(menu);
    const mw = menu.offsetWidth || 180;
    const mh = menu.offsetHeight || 160;
    menu.style.left = `${Math.min(clientX, window.innerWidth - mw - 8)}px`;
    menu.style.top = `${Math.min(clientY, window.innerHeight - mh - 8)}px`;
    this._contextMenuEl = menu;
  }

  _openAreaContextMenu(leafId, x, y) {
    const neighborId = findFirstJoinableNeighbor(this.root, leafId);
    const count = listLeafNodes(this.root).length;
    this._showMenuAt(
      [
        { label: 'Vertical Split (Left | Right)', action: () => this.splitLeaf(leafId, 'vertical', 0.5) },
        { label: 'Horizontal Split (Top / Bottom)', action: () => this.splitLeaf(leafId, 'horizontal', 0.5) },
        { divider: true },
        {
          label: 'Join Adjacent Area',
          disabled: !neighborId,
          action: () => neighborId && this.joinLeaves(leafId, neighborId),
        },
        {
          label: 'Close Area',
          disabled: count <= 1 || !neighborId,
          action: () => this.closeLeaf(leafId),
        },
        { divider: true },
        {
          label: this.maximizedLeafId === leafId ? 'Restore Split Layout' : 'Maximize Area',
          disabled: count <= 1,
          action: () => this.toggleMaximizeLeaf(leafId),
        },
        {
          label: this._preQuadSnapshot ? 'Exit Quad View (Ctrl+Alt+Q)' : 'Toggle Quad View (Ctrl+Alt+Q)',
          action: () => this.toggleQuadView(),
        },
        {
          label: 'Reset Single Viewport',
          disabled: count <= 1 && !this._preQuadSnapshot,
          action: () => this.resetToSingleViewport(),
        },
      ],
      x,
      y
    );
  }

  _openSplitterContextMenu(splitNode, x, y) {
    const leafA = listLeafNodes(splitNode.a)[0];
    const leafB = listLeafNodes(splitNode.b)[0];
    const canJoinDirect = splitNode.a.type === 'leaf' && splitNode.b.type === 'leaf';

    this._showMenuAt(
      [
        {
          label: 'Swap Areas',
          action: () => {
            const tmp = splitNode.a;
            splitNode.a = splitNode.b;
            splitNode.b = tmp;
            splitNode.ratio = clampRatio(1 - splitNode.ratio);
            this.renderLayout();
            this.engine?.syncViewportPaneControls?.();
          },
        },
        {
          label: 'Reset Ratio 50 / 50',
          action: () => {
            splitNode.ratio = 0.5;
            this.renderLayout();
            this.engine?.syncViewportPaneControls?.();
          },
        },
        { divider: true },
        {
          label: `Join -> Keep ${splitNode.direction === 'vertical' ? 'Left' : 'Top'}`,
          disabled: !canJoinDirect,
          action: () => canJoinDirect && this.joinLeaves(leafA.id, leafB.id),
        },
        {
          label: `Join -> Keep ${splitNode.direction === 'vertical' ? 'Right' : 'Bottom'}`,
          disabled: !canJoinDirect,
          action: () => canJoinDirect && this.joinLeaves(leafB.id, leafA.id),
        },
      ],
      x,
      y
    );
  }

  // -------------------------------------------------------------------------
  // Live DOM Singleton Editor Mounting (UV / Timeline / Graph / Script / Outliner / Inspector)
  // -------------------------------------------------------------------------

  _resolveHomeForEditor(editorType) {
    switch (editorType) {
      case 'uv-editor':
        return { home: document.getElementById('dock-uv-editor'), target: document.getElementById('uv-editor'), singleChild: true };
      case 'graph-editor':
        return { home: document.getElementById('dock-graph-editor'), target: document.getElementById('graph-editor'), singleChild: true };
      case 'scripting':
        return { home: document.getElementById('dock-scripting'), singleChild: false };
      case 'timeline':
        return { home: document.getElementById('dock-timeline'), singleChild: false };
      case 'materials':
        return { home: document.getElementById('dock-materials'), singleChild: false };
      case 'shader-editor':
        return { home: document.getElementById('dock-shader-editor'), singleChild: false };
      case 'asset-browser':
        return { home: document.getElementById('dock-asset-browser'), singleChild: false };
      case 'physics':
        return { home: document.getElementById('dock-physics'), singleChild: false };
      case 'outliner':
        return { home: document.getElementById('outliner-panel'), target: document.getElementById('outliner-container'), singleChild: true };
      case 'inspector':
        return { home: document.getElementById('inspector-panel'), target: document.getElementById('inspector-container'), singleChild: true };
      default:
        return null;
    }
  }

  _mountEditorIntoContainer(leaf, destContainer) {
    const editorType = leaf.editorType;
    const spec = this._resolveHomeForEditor(editorType);
    if (!spec || !spec.home) {
      destContainer.innerHTML = `<div class="area-empty-msg">Editor "${editorType}" not found.</div>`;
      return;
    }

    // Check if already mounted somewhere; if so capture wrapper first
    let entry = this._mountedEditors.get(editorType);
    if (!entry) {
      const wrapperNode = document.createElement('div');
      wrapperNode.className = 'area-mounted-wrapper';
      wrapperNode.dataset.mountedEditor = editorType;

      const anchorEl = document.createElement('span');
      anchorEl.className = 'area-home-anchor';
      anchorEl.style.display = 'none';

      const placeholderEl = document.createElement('div');
      placeholderEl.className = 'area-dock-placeholder';
      placeholderEl.innerHTML = `<span>Open in Split Area above.</span>`;
      const recallBtn = document.createElement('button');
      recallBtn.type = 'button';
      recallBtn.className = 'timeline-btn';
      recallBtn.textContent = '↩ Dock Back Here';
      recallBtn.addEventListener('click', () => {
        const curEntry = this._mountedEditors.get(editorType);
        if (curEntry) this.setLeafEditorType(curEntry.leafId, 'viewport3d');
      });
      placeholderEl.appendChild(recallBtn);

      if (spec.singleChild && spec.target) {
        spec.home.insertBefore(anchorEl, spec.target);
        wrapperNode.appendChild(spec.target);
      } else {
        spec.home.appendChild(anchorEl);
        const children = Array.from(spec.home.childNodes).filter(n => n !== anchorEl);
        for (const ch of children) wrapperNode.appendChild(ch);
      }

      spec.home.appendChild(placeholderEl);
      entry = { leafId: leaf.id, wrapperNode, homeContainer: spec.home, anchorEl, placeholderEl, spec };
      this._mountedEditors.set(editorType, entry);
    }

    entry.leafId = leaf.id;
    destContainer.appendChild(entry.wrapperNode);
  }

  _restoreEditorToHome(editorType) {
    const entry = this._mountedEditors.get(editorType);
    if (!entry) return;
    const { wrapperNode, homeContainer, anchorEl, placeholderEl, spec } = entry;

    if (spec.singleChild && spec.target) {
      if (anchorEl.parentElement === homeContainer) {
        homeContainer.insertBefore(spec.target, anchorEl);
      } else {
        homeContainer.appendChild(spec.target);
      }
    } else {
      const children = Array.from(wrapperNode.childNodes);
      for (const ch of children) {
        if (anchorEl.parentElement === homeContainer) {
          homeContainer.insertBefore(ch, anchorEl);
        } else {
          homeContainer.appendChild(ch);
        }
      }
    }

    anchorEl.remove();
    placeholderEl.remove();
    wrapperNode.remove();
    this._mountedEditors.delete(editorType);
  }

  _refreshMountedEditors() {
    if (this._mountedEditors.has('uv-editor')) {
      this.app?.uvEditor?.resizeCanvas?.();
      this.app?.uvEditor?.render?.();
    }
    if (this._mountedEditors.has('graph-editor')) {
      this.app?.graphEditor?.resizeCanvas?.();
      this.app?.graphEditor?.render?.();
    }
    if (this._mountedEditors.has('timeline')) this.app?.timelineUI?.render?.();
    if (this._mountedEditors.has('shader-editor')) {
      this.app?.shaderEditor?.resize?.();
      this.app?.shaderEditor?.render?.();
    }
    if (this._mountedEditors.has('asset-browser')) this.app?.assetBrowser?.render?.();
  }

  saveLayout() {
    try {
      if (typeof localStorage === 'undefined') return false;
      localStorage.setItem('wbs_workspace_layout_v1', JSON.stringify({
        version: 1,
        activeLeafId: this.activeLeafId,
        root: this.root,
      }));
      return true;
    } catch (_) {
      return false;
    }
  }

  restoreLayout() {
    try {
      if (typeof localStorage === 'undefined') return false;
      const raw = localStorage.getItem('wbs_workspace_layout_v1');
      if (!raw) return false;
      const data = JSON.parse(raw);
      if (!data?.root || (data.root.type !== 'leaf' && data.root.type !== 'split')) return false;
      const leaves = listLeafNodes(data.root);
      if (leaves.length === 0) return false;
      this.root = data.root;
      this.activeLeafId = findLeafNode(this.root, data.activeLeafId) ? data.activeLeafId : leaves[0].id;
      for (const leaf of leaves) {
        if (leaf.editorType === 'viewport3d') this._ensurePaneRuntime(leaf, this.panes.get('area-main'));
      }
      this.renderLayout();
      this._dispatchLayoutChanged('restore', this.activeLeafId);
      return true;
    } catch (_) {
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Quick Toolbar Bindings & Events
  // -------------------------------------------------------------------------

  _bindToolbarQuickButtons() {
    document.getElementById('btn-split-viewport')?.addEventListener('click', () => {
      if (listLeafNodes(this.root).length <= 1) {
        this.splitLeaf(this.activeLeafId || 'area-main', 'vertical', 0.5);
      } else {
        this.resetToSingleViewport();
      }
    });
    document.getElementById('btn-quad-view')?.addEventListener('click', () => {
      this.toggleQuadView();
    });
  }

  _dispatchLayoutChanged(action, leafId) {
    this.engine?.syncViewportPaneControls?.();
    if (action && action !== 'restore') {
      this.saveLayout();
    }
    if (typeof window === 'undefined') return;
    window.dispatchEvent(
      new CustomEvent('blender:areaLayoutChanged', {
        detail: {
          action,
          leafId,
          leafCount: listLeafNodes(this.root).length,
          isSingle: this.isSingleFullViewport(),
          quadActive: Boolean(this._preQuadSnapshot),
        },
      })
    );
  }
}

export default WorkspaceAreaManager;
