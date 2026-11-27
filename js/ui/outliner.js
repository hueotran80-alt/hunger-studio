/**
 * Web Blender Studio - Outliner Module
 * Renders hierarchical scene tree with visibility, selection, locking, and type icons.
 * Fully synchronized with SceneManager.
 */

import { escapeHtml } from '../core/escape-html.js';

export class Outliner {
  /**
   * @param {HTMLElement|string} container - DOM element or selector for the outliner
   * @param {Object} sceneManager - Reference to the SceneManager instance
   */
  constructor(container, sceneManager = null) {
    this.container = typeof container === 'string' ? document.querySelector(container) : container;
    this.sceneManager = sceneManager;
    this.searchQuery = '';
    this.filterType = 'all'; // 'all' | 'mesh' | 'light' | 'camera' | 'group' | 'collection'
    this.collapsedNodes = new Set();
    this.selectedIds = new Set();
    this.activeId = null;
    this._lastClickedId = null;
    this._renderedNodes = [];

    this.initDOM();
    this.bindEvents();

    if (this.sceneManager) {
      this.bindSceneEvents();
      this.render();
    }
  }

  /**
   * Attach SceneManager if not passed in constructor
   * @param {Object} sm 
   */
  setSceneManager(sm) {
    this.sceneManager = sm;
    this.bindSceneEvents();
    this.render();
  }

  initDOM() {
    if (!this.container) return;

    this.container.innerHTML = `
      <div class="outliner-search-wrap">
        <input type="text" class="outliner-search-input" id="outliner-search-input" placeholder="Search objects..." autocomplete="off">
      </div>
      <div class="outliner-content">
        <ul class="outliner-tree" id="outliner-tree-root"></ul>
      </div>
    `;

    this.treeRoot = this.container.querySelector('#outliner-tree-root');
    this.searchInput = this.container.querySelector('#outliner-search-input');
    this.refreshBtn = document.getElementById('btn-outliner-refresh') || this.container.querySelector('#outliner-btn-refresh');
    this.filterBtn = document.getElementById('btn-outliner-filter') || this.container.querySelector('#outliner-btn-filter');
  }

  bindEvents() {
    if (this.searchInput) {
      this.searchInput.addEventListener('input', (e) => {
        this.searchQuery = e.target.value.trim().toLowerCase();
        this.render();
      });
    }

    if (this.refreshBtn) {
      this.refreshBtn.addEventListener('click', () => {
        this.render();
      });
    }

    if (this.filterBtn) {
      this.filterBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._openFilterMenu(this.filterBtn);
      });
    }

    if (this.treeRoot) {
      this.treeRoot.tabIndex = 0;
      this.treeRoot.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          const objs = this._renderedNodes.filter((n) => !n.isCollection);
          if (!objs.length) return;
          const idx = objs.findIndex((n) => String(n.uuid || n.id) === String(this.activeId));
          const step = e.key === 'ArrowDown' ? 1 : -1;
          const nextIdx = idx < 0 ? 0 : Math.max(0, Math.min(objs.length - 1, idx + step));
          this.selectNode(objs[nextIdx], { shiftKey: e.shiftKey, ctrlKey: false });
        } else if (e.key.toLowerCase() === 'm' && !e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault();
          this.openMoveToCollectionMenu();
        }
      });
    }
  }

  setTypeFilter(type = 'all') {
    const valid = ['all', 'mesh', 'light', 'camera', 'group', 'collection'];
    this.filterType = valid.includes(type) ? type : 'all';
    if (this.filterBtn) {
      this.filterBtn.classList.toggle('active', this.filterType !== 'all');
      this.filterBtn.title = this.filterType === 'all' ? 'Filter View' : `Filter: ${this.filterType}`;
    }
    this.render();
    return this.filterType;
  }

  _openFilterMenu(anchorEl) {
    const existing = document.getElementById('outliner-filter-menu');
    if (existing) {
      existing.remove();
      return;
    }
    const menu = document.createElement('div');
    menu.id = 'outliner-filter-menu';
    menu.className = 'menu-dropdown';
    menu.style.display = 'block';
    menu.style.position = 'fixed';
    menu.style.zIndex = '9999';
    const r = anchorEl.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(window.innerWidth - 170, r.left - 110))}px`;
    menu.style.top = `${r.bottom + 4}px`;

    const opts = [
      ['all', 'All Types'],
      ['mesh', 'Meshes Only'],
      ['light', 'Lights Only'],
      ['camera', 'Cameras Only'],
      ['group', 'Groups Only'],
      ['collection', 'Collections Only'],
    ];
    menu.innerHTML = opts.map(([key, label]) => `
      <div class="dropdown-item" data-filter="${key}" style="font-weight:${this.filterType === key ? '700' : '400'}; color:${this.filterType === key ? '#60a5fa' : ''};">
        <span>${this.filterType === key ? '✓ ' : ''}${label}</span>
      </div>`).join('');
    menu.addEventListener('click', (ev) => {
      const item = ev.target.closest('.dropdown-item');
      if (item?.dataset?.filter) {
        this.setTypeFilter(item.dataset.filter);
      }
      menu.remove();
    });
    document.body.appendChild(menu);
    const closeMenu = (ev) => {
      if (!menu.contains(ev.target) && ev.target !== anchorEl) {
        menu.remove();
        document.removeEventListener('pointerdown', closeMenu);
      }
    };
    setTimeout(() => document.addEventListener('pointerdown', closeMenu), 0);
  }

  bindSceneEvents() {
    if (!this.sceneManager) return;

    if (typeof this.sceneManager.on === 'function') {
      // Direct SceneManager event emitter listeners
      this.sceneManager.on('selectionChanged', (payload) => {
        const active = payload?.active;
        const selected = payload?.selected || [];
        this.selectedIds.clear();
        selected.forEach(obj => {
          const id = obj.uuid || obj.userData?.id || obj.id;
          if (id) this.selectedIds.add(String(id));
        });
        this.activeId = active ? (active.uuid || active.userData?.id || active.id) : null;
        this.updateActiveStyles();
      });

      // Coalesce: a loop/import that adds 500 objects must rebuild the tree once.
      this.sceneManager.on('objectAdded', () => this.queueRender());
      this.sceneManager.on('objectRemoved', () => this.queueRender());
      this.sceneManager.on('objectRenamed', () => this.queueRender());
      this.sceneManager.on('visibilityChanged', () => this.queueRender());
      this.sceneManager.on('lockChanged', () => this.queueRender());
      this.sceneManager.on('objectsGrouped', () => this.queueRender());
      this.sceneManager.on('objectsUngrouped', () => this.queueRender());
    }

    // Global window events fallback
    window.addEventListener('blender:objectSelected', (e) => this.onObjectSelected(e.detail));
    window.addEventListener('blender:sceneUpdated', () => this.queueRender());
  }

  onObjectSelected(obj) {
    if (!obj) {
      this.selectedIds.clear();
      this.activeId = null;
    } else if (this.sceneManager && typeof this.sceneManager.getSelectedObjects === 'function') {
      const selected = this.sceneManager.getSelectedObjects();
      if (selected.length > 1 || (selected.length === 1 && selected[0] === obj)) {
        this.selectedIds.clear();
        selected.forEach((s) => {
          const id = s?.uuid || s?.userData?.id || s?.id;
          if (id) this.selectedIds.add(String(id));
        });
        const act = this.sceneManager.getActiveObject?.() || obj;
        this.activeId = act?.uuid || act?.userData?.id || act?.id || null;
      } else {
        this.activeId = obj.uuid || obj.userData?.id || obj.id;
        this.selectedIds.clear();
        this.selectedIds.add(String(this.activeId));
      }
    } else {
      this.activeId = obj.uuid || obj.userData?.id || obj.id;
      this.selectedIds.clear();
      this.selectedIds.add(String(this.activeId));
    }
    this.updateActiveStyles();
  }

  updateActiveStyles() {
    if (!this.treeRoot) return;
    const items = this.treeRoot.querySelectorAll('.outliner-item');
    items.forEach((el) => {
      const id = el.dataset.uuid || el.dataset.id;
      if (id === String(this.activeId)) {
        el.classList.add('active-object');
        el.classList.add('selected');
      } else if (this.selectedIds.has(String(id))) {
        el.classList.remove('active-object');
        el.classList.add('selected');
      } else {
        el.classList.remove('active-object', 'selected');
      }
    });
  }

  /**
   * Traverse scene and generate hierarchical data
   */
  getSceneNodes() {
    if (!this.sceneManager) {
      return this.getMockNodes();
    }

    // Use scene manager rootContainer (Scene Collection) or scene
    const scene = this.sceneManager.rootContainer || this.sceneManager.scene;
    if (!scene) {
      return this.getMockNodes();
    }

    const cm = this.sceneManager.collectionManager;
    const processObject = (obj) => {
      if (obj.isTransformGizmo || obj.userData?.isInternal || obj.userData?.isSystemObject ||
          obj.userData?.isHelper || obj.userData?.isCameraPart || obj.userData?.hideInOutliner || obj.isCamera ||
          obj.name === 'GridHelper' || obj.name === 'TransformControls') {
        return null;
      }

      const type = this.detectObjectType(obj);
      const node = {
        id: obj.userData?.id || obj.id,
        uuid: obj.uuid,
        name: obj.name || `${type}_${obj.id}`,
        type: type,
        visible: obj.visible !== false,
        locked: !!obj.userData?.locked,
        rawObject: obj,
        children: []
      };

      if (obj.children && obj.children.length > 0 && !obj.userData?.isCameraObject && !obj.userData?.isScatterGroup) {
        obj.children.forEach((child) => {
          const childNode = processObject(child);
          if (childNode) node.children.push(childNode);
        });
      }

      return node;
    };

    if (cm) {
      this._syncHeaderControls(cm);
      const allChildren = scene.children || [];
      const topObjsByUuid = new Map();
      allChildren.forEach((ch) => { topObjsByUuid.set(ch.uuid, ch); });
      const placedUuids = new Set();

      const buildCollectionNode = (col) => {
        const colNode = {
          id: col.id,
          uuid: col.id,
          name: col.name,
          type: 'collection',
          isCollection: true,
          isActiveCollection: col.id === cm.activeCollectionId,
          visible: col.visible !== false,
          renderable: col.renderable !== false,
          holdout: Boolean(col.holdout),
          locked: false,
          children: [],
        };
        for (const childId of (col.childIds || [])) {
          const sub = cm.collections.get(childId);
          if (sub) colNode.children.push(buildCollectionNode(sub));
        }
        for (const uuid of (col.objectUuids || [])) {
          const obj = topObjsByUuid.get(uuid);
          if (obj && !placedUuids.has(uuid)) {
            placedUuids.add(uuid);
            const n = processObject(obj);
            if (n) colNode.children.push(n);
          }
        }
        return colNode;
      };

      const rootCol = cm.collections.get(cm.rootId);
      const rootNode = buildCollectionNode(rootCol);
      rootNode.id = 'scene-collection';
      rootNode.uuid = 'scene-collection';
      allChildren.forEach((ch) => {
        if (!placedUuids.has(ch.uuid)) {
          const n = processObject(ch);
          if (n) rootNode.children.push(n);
        }
      });
      return [rootNode];
    }

    // Fallback flat Scene Collection
    const rootNode = {
      id: 'scene-collection',
      uuid: 'scene-collection',
      name: 'Scene Collection',
      type: 'collection',
      isCollection: true,
      visible: true,
      locked: false,
      children: []
    };
    if (scene.children) {
      scene.children.forEach((child) => {
        const n = processObject(child);
        if (n) rootNode.children.push(n);
      });
    }
    return [rootNode];
  }

  detectObjectType(obj) {
    if (obj.isMesh) return 'mesh';
    if (obj.isLight) return 'light';
    if (obj.isCamera || obj.userData?.isCameraObject) return 'camera';
    if (obj.isGroup) return 'group';
    return 'object';
  }

  getMockNodes() {
    return [
      {
        id: 'coll-1',
        uuid: 'coll-1',
        name: 'Collection',
        type: 'collection',
        visible: true,
        locked: false,
        children: [
          { id: 'cam-1', uuid: 'cam-1', name: 'Camera', type: 'camera', visible: true, locked: false, children: [] },
          { id: 'cube-1', uuid: 'cube-1', name: 'Cube', type: 'mesh', visible: true, locked: false, children: [] },
          { id: 'light-1', uuid: 'light-1', name: 'Light', type: 'light', visible: true, locked: false, children: [] }
        ]
      }
    ];
  }

  /**
   * Schedules one tree rebuild on the next animation frame. Multiple scene
   * events inside the same tick collapse into a single DOM rebuild.
   */
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

  render() {
    if (!this.treeRoot) return;
    this.treeRoot.innerHTML = '';
    this._renderedNodes = [];

    const nodes = this.getSceneNodes();
    nodes.forEach((node) => {
      this.renderNode(node, 0, this.treeRoot);
    });

    this.updateActiveStyles();
  }

  renderNode(node, depth, parentEl) {
    if (!this.nodeMatchesFilters(node)) {
      return;
    }
    this._renderedNodes.push(node);

    const hasChildren = node.children && node.children.length > 0;
    const isCollapsed = this.collapsedNodes.has(node.uuid || node.id);

    const li = document.createElement('li');
    li.className = `outliner-item${node.isCollection && node.isActiveCollection ? ' active-collection' : ''}`;
    if (node.isCollection && node.isActiveCollection) {
      li.style.borderLeft = '2px solid #e58c2c';
    }
    li.dataset.uuid = node.uuid || node.id;
    li.dataset.id = node.id;
    li.style.paddingLeft = `${depth * 14 + 6}px`;

    // Arrow icon
    const arrowSpan = document.createElement('span');
    arrowSpan.className = `outliner-expand-arrow ${hasChildren ? (!isCollapsed ? 'expanded' : '') : ''}`;
    if (hasChildren) {
      arrowSpan.innerHTML = `<svg viewBox="0 0 16 16" width="10" height="10" fill="currentColor"><path d="M6 4l4 4-4 4V4z"/></svg>`;
      arrowSpan.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = node.uuid || node.id;
        if (this.collapsedNodes.has(id)) {
          this.collapsedNodes.delete(id);
        } else {
          this.collapsedNodes.add(id);
        }
        this.render();
      });
    }
    li.appendChild(arrowSpan);

    // Type Icon
    const iconSpan = document.createElement('span');
    iconSpan.className = `outliner-item-icon type-${node.type}`;
    iconSpan.innerHTML = this.getTypeIconSvg(node.type);
    li.appendChild(iconSpan);

    // Name label
    const nameSpan = document.createElement('span');
    nameSpan.className = 'outliner-item-name';
    nameSpan.textContent = node.name;
    nameSpan.title = node.name;

    // Double-click to inline rename
    nameSpan.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      this.startInlineRename(nameSpan, node);
    });
    li.appendChild(nameSpan);

    if (node.rawObject?.userData?.isScatterGroup) {
      const badgeSpan = document.createElement('span');
      const cnt = Number(node.rawObject.userData.instanceCount ?? 0);
      badgeSpan.className = 'outliner-scatter-badge';
      badgeSpan.style.cssText = 'font-size:10px;color:#55efc4;background:rgba(85,239,196,0.12);border:1px solid rgba(85,239,196,0.28);border-radius:3px;padding:0 4px;margin-left:4px;white-space:nowrap;';
      badgeSpan.textContent = `🌿 ${cnt.toLocaleString()}`;
      li.appendChild(badgeSpan);
    }

    // Actions (Visibility eye button, Collection render/holdout or Lock toggle button)
    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'outliner-item-actions';

    if (node.isCollection && this.sceneManager?.collectionManager && node.id !== 'scene-collection') {
      const colId = node.id;
      const cm = this.sceneManager.collectionManager;
      const holdBtn = document.createElement('button');
      holdBtn.className = `outliner-action-btn ${node.holdout ? '' : 'hidden-state'}`;
      holdBtn.title = node.holdout ? 'Disable Holdout' : 'Enable Holdout Mask';
      holdBtn.style.fontSize = '10px';
      holdBtn.textContent = '◐';
      holdBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        cm.setCollectionHoldout?.(colId, !node.holdout);
        this.render();
      });
      actionsDiv.appendChild(holdBtn);

      const renBtn = document.createElement('button');
      renBtn.className = `outliner-action-btn ${node.renderable === false ? 'hidden-state' : ''}`;
      renBtn.title = node.renderable === false ? 'Enable in Renders' : 'Disable in Renders';
      renBtn.style.fontSize = '10px';
      renBtn.textContent = node.renderable === false ? '📷̸' : '📷';
      renBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        cm.setCollectionRenderable?.(colId, node.renderable === false);
        this.render();
      });
      actionsDiv.appendChild(renBtn);
    }

    // Lock Button
    const lockBtn = document.createElement('button');
    lockBtn.className = `outliner-action-btn ${node.locked ? '' : 'hidden-state'}`;
    lockBtn.title = node.locked ? 'Unlock Object' : 'Lock Object (Restrict Selection)';
    lockBtn.innerHTML = node.locked ? this.getLockClosedSvg() : this.getLockOpenSvg();
    lockBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleLock(node, lockBtn);
    });
    actionsDiv.appendChild(lockBtn);

    // Eye Button
    const eyeBtn = document.createElement('button');
    eyeBtn.className = `outliner-action-btn ${!node.visible ? 'hidden-state' : ''}`;
    eyeBtn.title = node.visible ? 'Hide in Viewport' : 'Show in Viewport';
    eyeBtn.innerHTML = node.visible ? this.getEyeOpenSvg() : this.getEyeClosedSvg();
    eyeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleVisibility(node, eyeBtn);
    });
    actionsDiv.appendChild(eyeBtn);

    li.appendChild(actionsDiv);

    // Click item to select in 3D scene (supports Ctrl/Cmd toggle & Shift range multi-select)
    li.addEventListener('click', (e) => {
      e.stopPropagation();
      this.selectNode(node, { shiftKey: e.shiftKey, ctrlKey: e.ctrlKey || e.metaKey });
    });

    // Right-click context menu
    li.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.selectNode(node, false);
      this.showContextMenu(e, node);
    });

    parentEl.appendChild(li);

    // Render children if expanded
    if (hasChildren && !isCollapsed) {
      node.children.forEach((child) => {
        this.renderNode(child, depth + 1, parentEl);
      });
    }
  }

  nodeMatchesFilters(node) {
    const queryOk = !this.searchQuery || this.nodeMatchesSearch(node, this.searchQuery);
    if (!queryOk) return false;
    if (!this.filterType || this.filterType === 'all') return true;
    if (this.filterType === 'collection') return Boolean(node.isCollection);
    if (node.isCollection) {
      return Boolean(node.children?.some((ch) => this.nodeMatchesFilters(ch)));
    }
    if (node.type === this.filterType) return true;
    return Boolean(node.children?.some((ch) => this.nodeMatchesFilters(ch)));
  }

  nodeMatchesSearch(node, query) {
    if (node.name.toLowerCase().includes(query)) return true;
    if (node.children) {
      return node.children.some((child) => this.nodeMatchesSearch(child, query));
    }
    return false;
  }

  selectNode(node, modifiers = false) {
    const isBoolMod = typeof modifiers === 'boolean';
    const ctrlKey = isBoolMod ? modifiers : Boolean(modifiers?.ctrlKey || modifiers?.metaKey);
    const shiftKey = isBoolMod ? false : Boolean(modifiers?.shiftKey);

    if (node.isCollection && this.sceneManager?.collectionManager) {
      const cm = this.sceneManager.collectionManager;
      cm.activeCollectionId = node.id === 'scene-collection' ? cm.rootId : node.id;
      this.render();
      return;
    }

    const nodeId = String(node.uuid || node.id);
    if (shiftKey && this._lastClickedId && this._renderedNodes.length > 0) {
      const objs = this._renderedNodes.filter((n) => !n.isCollection);
      const fromIdx = objs.findIndex((n) => String(n.uuid || n.id) === String(this._lastClickedId));
      const toIdx = objs.findIndex((n) => String(n.uuid || n.id) === nodeId);
      if (fromIdx !== -1 && toIdx !== -1) {
        const lo = Math.min(fromIdx, toIdx);
        const hi = Math.max(fromIdx, toIdx);
        const rangeNodes = objs.slice(lo, hi + 1);
        if (!ctrlKey) this.selectedIds.clear();
        const rangeObjs = [];
        for (const n of rangeNodes) {
          this.selectedIds.add(String(n.uuid || n.id));
          const obj = n.rawObject || this.sceneManager?.resolveObject?.(n.uuid || n.id);
          if (obj) rangeObjs.push(obj);
        }
        this.activeId = nodeId;
        this._lastClickedId = nodeId;
        this.updateActiveStyles();
        const activeObj = node.rawObject || this.sceneManager?.resolveObject?.(nodeId);
        if (this.sceneManager?.setSelection && rangeObjs.length > 0) {
          this.sceneManager.setSelection(rangeObjs, activeObj || rangeObjs[rangeObjs.length - 1]);
        }
        window.dispatchEvent(new CustomEvent('blender:objectSelected', {
          detail: node.rawObject || { id: node.id, uuid: node.uuid, name: node.name, type: node.type }
        }));
        return;
      }
    }

    const obj = node.rawObject || this.sceneManager?.resolveObject?.(node.uuid || node.id);
    if (ctrlKey && this.selectedIds.has(nodeId)) {
      this.selectedIds.delete(nodeId);
      if (this.sceneManager?.deselect && obj) {
        this.sceneManager.deselect(obj);
      }
      this.activeId = this.sceneManager?.getActiveObject?.()?.uuid || Array.from(this.selectedIds)[0] || null;
      this._lastClickedId = nodeId;
      this.updateActiveStyles();
      return;
    }

    const additive = ctrlKey || shiftKey;
    this.activeId = nodeId;
    this._lastClickedId = nodeId;
    if (!additive) {
      this.selectedIds.clear();
    }
    this.selectedIds.add(nodeId);
    this.updateActiveStyles();

    if (this.sceneManager) {
      if (typeof this.sceneManager.select === 'function') {
        this.sceneManager.select(obj || node.uuid, additive);
      } else if (typeof this.sceneManager.selectObject === 'function') {
        this.sceneManager.selectObject(obj || node.uuid);
      }
    }

    const event = new CustomEvent('blender:objectSelected', {
      detail: node.rawObject || { id: node.id, uuid: node.uuid, name: node.name, type: node.type }
    });
    window.dispatchEvent(event);
  }

  _syncHeaderControls(cm) {
    if (typeof document === 'undefined' || !cm) return;
    if (!this._headerBound) {
      this._headerBound = true;
      document.getElementById('btn-outliner-new-col')?.addEventListener('click', () => {
        const count = cm.collections.size;
        cm.createCollection(`Collection.${String(count).padStart(3, '0')}`, cm.activeCollectionId || cm.rootId);
        this.render();
      });
      document.getElementById('select-outliner-viewlayer')?.addEventListener('change', (e) => {
        cm.setActiveViewLayer(e.target.value);
        this.render();
      });
    }
    const vlSel = document.getElementById('select-outliner-viewlayer');
    if (vlSel) {
      vlSel.innerHTML = Array.from(cm.viewLayers.values())
        .map((vl) => `<option value="${escapeHtml(vl.id)}" ${vl.id === cm.activeViewLayerId ? 'selected' : ''}>${escapeHtml(vl.name)}</option>`)
        .join('');
    }
  }

  toggleVisibility(node, btn) {
    node.visible = !node.visible;
    if (node.isCollection && this.sceneManager?.collectionManager) {
      const colId = node.id === 'scene-collection' ? this.sceneManager.collectionManager.rootId : node.id;
      this.sceneManager.collectionManager.setCollectionVisibility(colId, node.visible);
      this.render();
      return;
    }
    if (this.sceneManager && typeof this.sceneManager.setVisibility === 'function') {
      this.sceneManager.setVisibility(node.rawObject || node.uuid || node.id, node.visible);
    } else if (node.rawObject) {
      node.rawObject.visible = node.visible;
    }

    if (btn) {
      btn.className = `outliner-action-btn ${!node.visible ? 'hidden-state' : ''}`;
      btn.title = node.visible ? 'Hide in Viewport' : 'Show in Viewport';
      btn.innerHTML = node.visible ? this.getEyeOpenSvg() : this.getEyeClosedSvg();
    }

    if (this.sceneManager && typeof this.sceneManager.requestRender === 'function') {
      this.sceneManager.requestRender();
    }
  }

  toggleLock(node, btn) {
    node.locked = !node.locked;
    if (this.sceneManager && typeof this.sceneManager.setLocked === 'function') {
      this.sceneManager.setLocked(node.rawObject || node.uuid || node.id, node.locked);
    } else if (node.rawObject) {
      node.rawObject.userData = node.rawObject.userData || {};
      node.rawObject.userData.locked = node.locked;
    }

    if (btn) {
      btn.className = `outliner-action-btn ${node.locked ? '' : 'hidden-state'}`;
      btn.title = node.locked ? 'Unlock Object' : 'Lock Object';
      btn.innerHTML = node.locked ? this.getLockClosedSvg() : this.getLockOpenSvg();
    }
  }

  startInlineRename(nameSpan, node) {
    nameSpan.contentEditable = 'true';
    nameSpan.focus();
    document.execCommand('selectAll', false, null);

    const finishRename = () => {
      nameSpan.contentEditable = 'false';
      const newName = nameSpan.textContent.trim();
      if (newName && newName !== node.name) {
        node.name = newName;
        if (node.isCollection && this.sceneManager?.collectionManager) {
          const colId = node.id === 'scene-collection' ? this.sceneManager.collectionManager.rootId : node.id;
          this.sceneManager.collectionManager.renameCollection?.(colId, newName);
          this.render();
        } else if (this.sceneManager && typeof this.sceneManager.renameObject === 'function') {
          this.sceneManager.renameObject(node.rawObject || node.uuid || node.id, newName);
        } else if (node.rawObject) {
          node.rawObject.name = newName;
        }
        window.dispatchEvent(new CustomEvent('blender:objectRenamed', { detail: { uuid: node.uuid, name: newName } }));
      } else {
        nameSpan.textContent = node.name;
      }
    };

    nameSpan.onblur = finishRename;
    nameSpan.onkeydown = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        nameSpan.blur();
      } else if (e.key === 'Escape') {
        nameSpan.textContent = node.name;
        nameSpan.contentEditable = 'false';
      }
    };
  }

  showContextMenu(e, node) {
    const existing = document.getElementById('blender-context-menu');
    if (existing) existing.remove();

    const menu = document.createElement('div');
    menu.id = 'blender-context-menu';
    menu.className = 'menu-dropdown';
    menu.style.display = 'block';
    menu.style.position = 'fixed';
    menu.style.left = `${e.clientX}px`;
    menu.style.top = `${e.clientY}px`;
    menu.style.zIndex = '9999';

    const cm = this.sceneManager?.collectionManager;
    if (node.isCollection && cm) {
      const colId = node.id === 'scene-collection' ? cm.rootId : node.id;
      const canDelete = colId !== cm.rootId;
      menu.innerHTML = `
        <div class="dropdown-item" data-action="activate-col"><span>Set Active Collection</span></div>
        <div class="dropdown-item" data-action="new-col"><span>New Sub-Collection</span></div>
        <div class="dropdown-item" data-action="toggle-col-vis"><span>${node.visible ? 'Hide Collection' : 'Show Collection'}</span></div>
        <div class="dropdown-item" data-action="toggle-col-render"><span>${node.renderable === false ? 'Enable Render' : 'Disable Render'}</span></div>
        <div class="dropdown-item" data-action="toggle-col-holdout"><span>${node.holdout ? 'Disable Holdout' : 'Enable Holdout'}</span></div>
        ${canDelete ? `<div class="dropdown-divider"></div><div class="dropdown-item" data-action="delete-col" style="color:#ff6b6b;"><span>Delete Collection</span></div>` : ''}
      `;
    } else {
      menu.innerHTML = `
        <div class="dropdown-item" data-action="focus"><span>Focus View</span><span class="shortcut">Numpad .</span></div>
        <div class="dropdown-item" data-action="hide"><span>${node.visible ? 'Hide' : 'Unhide'}</span><span class="shortcut">H</span></div>
        <div class="dropdown-item" data-action="lock"><span>${node.locked ? 'Unlock' : 'Lock'}</span></div>
        <div class="dropdown-item" data-action="new-col"><span>New Sub-Collection</span></div>
        <div class="dropdown-item" data-action="move-active-col"><span>Move to Collection…</span><span class="shortcut">M</span></div>
        <div class="dropdown-divider"></div>
        <div class="dropdown-item" data-action="duplicate"><span>Duplicate</span><span class="shortcut">Shift+D</span></div>
        <div class="dropdown-item" data-action="delete" style="color: #ff6b6b;"><span>Delete</span><span class="shortcut">X</span></div>
      `;
    }

    menu.addEventListener('click', (ev) => {
      const item = ev.target.closest('.dropdown-item');
      if (!item) return;
      const action = item.dataset.action;

      if (action === 'activate-col' && cm) {
        const colId = node.id === 'scene-collection' ? cm.rootId : node.id;
        cm.activeCollectionId = colId;
        this.render();
      } else if (action === 'toggle-col-vis' && cm) {
        const colId = node.id === 'scene-collection' ? cm.rootId : node.id;
        cm.setCollectionVisibility(colId, !node.visible);
        this.render();
      } else if (action === 'toggle-col-render' && cm) {
        const colId = node.id === 'scene-collection' ? cm.rootId : node.id;
        cm.setCollectionRenderable?.(colId, node.renderable === false);
        this.render();
      } else if (action === 'toggle-col-holdout' && cm) {
        const colId = node.id === 'scene-collection' ? cm.rootId : node.id;
        cm.setCollectionHoldout?.(colId, !node.holdout);
        this.render();
      } else if (action === 'delete-col' && cm) {
        cm.removeCollection(node.id);
        this.render();
      } else if (action === 'hide') {
        this.toggleVisibility(node);
      } else if (action === 'lock') {
        this.toggleLock(node);
      } else if (action === 'delete') {
        if (this.sceneManager && typeof this.sceneManager.removeObject === 'function') {
          this.sceneManager.removeObject(node.rawObject || node.uuid);
        }
        this.render();
      } else if (action === 'duplicate') {
        if (this.sceneManager && typeof this.sceneManager.duplicateObject === 'function') {
          this.sceneManager.duplicateObject(node.rawObject || node.uuid);
          this.render();
        }
      } else if (action === 'focus') {
        if (this.sceneManager && typeof this.sceneManager.focusObject === 'function') {
          this.sceneManager.focusObject(node.rawObject || node.uuid);
        }
      } else if (action === 'new-col' && cm) {
        const parentId = node.isCollection ? (node.id === 'scene-collection' ? cm.rootId : node.id) : cm.activeCollectionId;
        cm.createCollection(`Collection.${String(cm.collections.size).padStart(3, '0')}`, parentId);
        this.render();
      } else if (action === 'move-active-col' && node.rawObject && cm) {
        menu.remove();
        this.openMoveToCollectionMenu([node.rawObject], e);
        return;
      }

      menu.remove();
    });

    document.body.appendChild(menu);

    const closeMenu = (ev) => {
      if (!menu.contains(ev.target)) {
        menu.remove();
        document.removeEventListener('pointerdown', closeMenu);
      }
    };
    setTimeout(() => document.addEventListener('pointerdown', closeMenu), 0);
  }

  /**
   * Blender 'M' shortcut popup: Move selected objects to a Collection or create a new one.
   */
  openMoveToCollectionMenu(explicitObjects = null, anchorEvent = null) {
    const cm = this.sceneManager?.collectionManager;
    if (!cm || typeof document === 'undefined') return false;
    const objects = (Array.isArray(explicitObjects) && explicitObjects.length > 0)
      ? explicitObjects
      : (this.sceneManager.getSelectedObjects ? this.sceneManager.getSelectedObjects() : []);
    if (!objects.length) return false;

    const existing = document.getElementById('blender-move-col-menu');
    if (existing) existing.remove();

    const menu = document.createElement('div');
    menu.id = 'blender-move-col-menu';
    menu.className = 'menu-dropdown';
    menu.style.display = 'block';
    menu.style.position = 'fixed';
    menu.style.zIndex = '10000';
    const cx = anchorEvent?.clientX ?? Math.round((window.innerWidth || 800) * 0.5);
    const cy = anchorEvent?.clientY ?? Math.round((window.innerHeight || 600) * 0.35);
    menu.style.left = `${Math.max(12, Math.min((window.innerWidth || 800) - 210, cx))}px`;
    menu.style.top = `${Math.max(12, Math.min((window.innerHeight || 600) - 240, cy))}px`;

    const header = `<div style="padding:4px 10px; font-size:10px; text-transform:uppercase; color:#9aa3b2; border-bottom:1px solid #333;">Move ${objects.length} Object(s) to Collection</div>`;
    const rows = Array.from(cm.collections.values()).map((col) => `
      <div class="dropdown-item" data-col-id="${escapeHtml(col.id)}">
        <span>${col.id === cm.activeCollectionId ? '★ ' : ''}${escapeHtml(col.name)}</span>
      </div>`).join('');
    const footer = `<div class="dropdown-divider"></div><div class="dropdown-item" data-col-new="1"><span>+ New Collection…</span></div>`;
    menu.innerHTML = header + rows + footer;

    menu.addEventListener('click', (ev) => {
      const item = ev.target.closest('.dropdown-item');
      if (!item) return;
      let targetColId = item.dataset.colId;
      if (item.dataset.colNew) {
        const created = cm.createCollection(`Collection.${String(cm.collections.size).padStart(3, '0')}`, cm.rootId);
        targetColId = created.id;
      }
      if (targetColId) {
        for (const obj of objects) {
          cm.moveObjectToCollection(obj, targetColId);
        }
        cm.activeCollectionId = targetColId;
        this.render();
      }
      menu.remove();
    });

    document.body.appendChild(menu);
    const closeMenu = (ev) => {
      if (!menu.contains(ev.target)) {
        menu.remove();
        document.removeEventListener('pointerdown', closeMenu);
      }
    };
    setTimeout(() => document.addEventListener('pointerdown', closeMenu), 0);
    return true;
  }

  getTypeIconSvg(type) {
    switch (type) {
      case 'collection':
        return `<svg viewBox="0 0 16 16"><path d="M1 2.5A1.5 1.5 0 0 1 2.5 1h3.764a1.5 1.5 0 0 1 1.06.44l1.236 1.236A1.5 1.5 0 0 0 9.62 3H13.5A1.5 1.5 0 0 1 15 4.5v9a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 1 13.5v-11z"/></svg>`;
      case 'mesh':
        return `<svg viewBox="0 0 16 16"><path d="M8 1l7 4v6l-7 4-7-4V5l7-4zm0 1.63L2.61 5.37 8 8.1l5.39-2.73L8 2.63zm-6 3.9v4.29l5 2.86V9.45L2 6.53zm12 0l-5 2.92v4.23l5-2.86V6.53z"/></svg>`;
      case 'light':
        return `<svg viewBox="0 0 16 16"><path d="M8 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM8 0a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0v-1.5A.75.75 0 0 1 8 0zm0 13a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0v-1.5A.75.75 0 0 1 8 13zm8-5a.75.75 0 0 1-.75.75h-1.5a.75.75 0 0 1 0-1.5h1.5A.75.75 0 0 1 16 8zM3 8a.75.75 0 0 1-.75.75H.75a.75.75 0 0 1 0-1.5h1.5A.75.75 0 0 1 3 8z"/></svg>`;
      case 'camera':
        return `<svg viewBox="0 0 16 16"><path d="M0 4.5A1.5 1.5 0 0 1 1.5 3h7A1.5 1.5 0 0 1 10 4.5v1.793l3.146-2.098A1 1 0 0 1 15 5.027v5.946a1 1 0 0 1-1.854.832L10 9.707v1.793A1.5 1.5 0 0 1 8.5 13h-7A1.5 1.5 0 0 1 0 11.5v-7z"/></svg>`;
      default:
        return `<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="5"/></svg>`;
    }
  }

  getEyeOpenSvg() {
    return `<svg viewBox="0 0 16 16"><path d="M8 2c4 0 7 6 7 6s-3 6-7 6-7-6-7-6 3-6 7-6zm0 2C5.5 4 3.2 6.3 2.1 8c1.1 1.7 3.4 4 5.9 4 2.5 0 4.8-2.3 5.9-4-1.1-1.7-3.4-4-5.9-4zm0 2a2 2 0 1 1 0 4 2 2 0 0 1 0-4z"/></svg>`;
  }

  getEyeClosedSvg() {
    return `<svg viewBox="0 0 16 16"><path d="M14.7 13.3l-12-12-.7.7 2.1 2.1C2.5 5.3 1 8 1 8s3 6 7 6c1.8 0 3.3-.8 4.6-2.1l1.4 1.4.7-.7zM8 12c-2.5 0-4.8-2.3-5.9-4 .7-1.1 1.8-2.3 3.1-3.1l1.6 1.6A2 2 0 0 0 9.5 9l1.6 1.6c-.9.9-2 1.4-3.1 1.4zm5.9-4c-.5.8-1.3 1.9-2.3 2.8l-1.1-1.1C11.3 9.1 12 8 12 8s-3-6-7-6c-.7 0-1.4.2-2 .5L4.4 3.9C5.5 3.3 6.7 3 8 3c4 0 7 5 7 5z"/></svg>`;
  }

  getLockOpenSvg() {
    return `<svg viewBox="0 0 16 16"><path d="M11 5V4a3 3 0 0 0-6 0v1H3v10h10V5h-2zm-5-1a2 2 0 1 1 4 0v1H6V4zm6 10H4V6h8v8z"/></svg>`;
  }

  getLockClosedSvg() {
    return `<svg viewBox="0 0 16 16"><path d="M11 5V4a3 3 0 0 0-6 0v1H3v10h10V5h-2zm-5-1a2 2 0 1 1 4 0v1H6V4zm6 10H4V6h8v8zm-4-5a1.5 1.5 0 0 0-1 2.83V12h2v-1.17A1.5 1.5 0 0 0 8 9z"/></svg>`;
  }
}
