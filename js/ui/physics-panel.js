/**
 * @file physics-panel.js
 * @description Physics dock: rigid-body properties for the active object plus
 * deterministic play/pause/step/reset and bake-to-timeline controls.
 */

import {
  DEFAULT_PHYSICS,
  PHYSICS_BODY_TYPES,
  PHYSICS_COLLIDER_TYPES,
  PHYSICS_JOINT_TYPES,
  PHYSICS_JOINT_AXES,
  PHYSICS_MOTOR_MODES
} from '../simulation/simulation-manager.js';

const MOTOR_LABELS = Object.freeze({ off: 'Off', velocity: 'Velocity', position: 'Position', servo: 'Servo' });
const MOTOR_FIELDS = Object.freeze([
  ['limitsEnabled', 'Angle Limits', 'checkbox'],
  ['lower', 'Lower Limit (°)', 'number', -180, 180, 1],
  ['upper', 'Upper Limit (°)', 'number', -180, 180, 1],
  ['motorMode', 'Motor', 'select'],
  ['targetVelocity', 'Target Velocity (°/s)', 'number', -3600, 3600, 1],
  ['targetAngle', 'Target Angle (°)', 'number', -180, 180, 1],
  ['stiffness', 'Stiffness', 'number', 0, 10000, 1],
  ['damping', 'Damping', 'number', 0, 10000, 0.1],
  ['maxTorque', 'Max Torque (N·m)', 'number', 0, 10000, 1]
]);

export class PhysicsPanel {
  constructor(container, { sceneManager, simulationManager, timelineEngine = null }) {
    this.container = typeof container === 'string' ? document.querySelector(container) : container;
    this.sceneManager = sceneManager;
    this.sim = simulationManager;
    this.timeline = timelineEngine;
    this.object = null;
    this._boundRefresh = this.refresh.bind(this);

    this._build();
    if (this.sceneManager && typeof this.sceneManager.on === 'function') {
      this.sceneManager.on('selectionChanged', this._selectionHandler = ({ active }) => {
        this.object = active;
        this.refresh();
      });
      this.sceneManager.on('historyChanged', this._boundRefresh);
      this.sceneManager.on('objectAdded', this._boundRefresh);
      this.sceneManager.on('objectRemoved', this._boundRefresh);
      this.sceneManager.on('sceneCleared', this._boundRefresh);
    }
    this._startAngleReadout();
    this.refresh();
  }

  _button(id, label, title = '') {
    return `<button id="${id}" class="timeline-btn" title="${title}">${label}</button>`;
  }

  _build() {
    if (!this.container) return;
    this.container.innerHTML = `
      <div style="display:flex; flex-direction:column; height:100%; gap:8px; padding:10px 12px; overflow:auto; color:#ddd; font-size:12px;">
        <div style="display:flex; gap:6px; align-items:center; flex-wrap:wrap;">
          <b style="color:#8ab4f8;">Rigid Body Physics</b>
          <span id="phys-status" style="color:#999;"></span>
          <div style="flex:1"></div>
          ${this._button('phys-play', '▶ Play')}
          ${this._button('phys-pause', '⏸ Pause')}
          ${this._button('phys-step', '⏭ 1s')}
          ${this._button('phys-reset', '↺ Reset')}
        </div>
        <div style="display:flex; gap:14px; align-items:center; flex-wrap:wrap;">
          <label style="display:flex; gap:6px; align-items:center;">
            <input type="checkbox" id="phys-ground" checked> Ground plane (y = 0)
          </label>
          <label style="display:flex; gap:6px; align-items:center;" title="Show Rapier collider and joint wireframe">
            <input type="checkbox" id="phys-debug-wire"> Wireframe 3D
          </label>
          <label style="display:flex; gap:4px; align-items:center; color:#aaa;">
            Gravity Y: <input id="phys-gravity-y" type="number" step="0.5" value="-9.81" style="width:58px; background:#2a2a2a; color:#fff; border:1px solid #444; border-radius:3px; padding:2px 4px;"> m/s²
          </label>
          <div style="flex:1"></div>
          <label>Bake frames: <input id="phys-bake-frames" type="number" min="1" max="5000" value="120" style="width:64px; background:#2a2a2a; color:#fff; border:1px solid #444; border-radius:3px; padding:2px 4px;"></label>
          ${this._button('phys-bake', 'Bake → Timeline')}
        </div>
        <div id="phys-editor" style="border-top:1px solid #333; padding-top:8px;"></div>
      </div>
    `;

    this.statusEl = this.container.querySelector('#phys-status');
    this.editorEl = this.container.querySelector('#phys-editor');
    this.groundEl = this.container.querySelector('#phys-ground');
    this.debugEl = this.container.querySelector('#phys-debug-wire');
    this.gravityEl = this.container.querySelector('#phys-gravity-y');

    this.container.querySelector('#phys-play').addEventListener('click', async () => {
      if (!this.sim.ready) await this.sim.ensureInit?.();
      this.sim.play();
      this.refreshStatus();
    });
    this.container.querySelector('#phys-pause').addEventListener('click', () => {
      this.sim.pause();
      this.refreshStatus();
    });
    this.container.querySelector('#phys-step').addEventListener('click', async () => {
      if (!this.sim.ready) await this.sim.ensureInit?.();
      this.sim.stepFrames(60);
      this.refreshStatus();
    });
    this.container.querySelector('#phys-reset').addEventListener('click', async () => {
      if (!this.sim.ready) await this.sim.ensureInit?.();
      this.sim.reset();
      this.refreshStatus();
    });
    this.groundEl.addEventListener('change', async () => {
      if (!this.sim.ready) await this.sim.ensureInit?.();
      this.sim.setGroundEnabled(this.groundEl.checked);
      this.refreshStatus();
    });
    this.debugEl?.addEventListener('change', async () => {
      if (!this.sim.ready) await this.sim.ensureInit?.();
      this.sim.setDebugEnabled?.(this.debugEl.checked);
    });
    this.gravityEl?.addEventListener('change', async () => {
      if (!this.sim.ready) await this.sim.ensureInit?.();
      const gy = Number(this.gravityEl.value);
      if (Number.isFinite(gy)) {
        const g = this.sim.gravity || { x: 0, y: -9.81, z: 0 };
        this.sim.setGravity(g.x, gy, g.z);
      }
    });
    this.container.querySelector('#phys-bake').addEventListener('click', async () => {
      if (!this.sim.ready) await this.sim.ensureInit?.();
      const frames = Number(this.container.querySelector('#phys-bake-frames').value) || 120;
      const result = this.sim.bake({
        fps: this.timeline?.fps || 30,
        frames
      });
      this.setStatus(result
        ? `Baked ${result.frames} frames for ${result.objects} object(s)`
        : 'Select an object with a Rigid Body before baking.');
    });
  }

  setStatus(text) {
    if (this.statusEl) this.statusEl.textContent = text;
  }

  refreshStatus() {
    if (!this.statusEl) return;
    const active = Boolean(this.sim.isPlaying || this.sim.playing);
    this.statusEl.textContent = `${this.sim.bodyCount} body · ${this.sim.jointCount} joint · ${active ? 'playing' : 'stopped'}`;
    if (this.debugEl) this.debugEl.checked = Boolean(this.sim.debugEnabled);
    if (this.gravityEl && document.activeElement !== this.gravityEl) {
      this.gravityEl.value = String(this.sim.gravity?.y ?? -9.81);
    }
    this._syncAngleReadoutsNow();
    if (active && !this._angleRaf && this._angleReadouts?.length) {
      this._startAngleReadout();
    }
  }

  _syncAngleReadoutsNow() {
    for (const { element, owner, spec } of this._angleReadouts || []) {
      if (!element.isConnected) continue;
      const angle = this.sim.getJointAngle(owner, spec);
      element.textContent = Number.isFinite(angle) ? `${angle.toFixed(1)}°` : 'Inactive';
      const config = this.sim.getJointConfig(owner, spec);
      const outOfRange = config?.limitsEnabled && Number.isFinite(angle) && (angle < config.lower - 0.5 || angle > config.upper + 0.5);
      element.style.color = outOfRange ? '#e5b567' : '#8ab4f8';
      element.title = outOfRange ? 'Outside angle limits; solver will pull joint back in.' : 'Relative angle since joint creation.';
    }
  }

  _numberField(id, label, value, step = 0.1) {
    value = Number.isFinite(value) ? value : 0;
    return `<label style="display:flex; flex-direction:column; gap:2px; color:#aaa;">
      ${label}
      <input id="${id}" type="number" step="${step}" value="${value}"
        style="width:80px; background:#2a2a2a; color:#fff; border:1px solid #444; border-radius:3px; padding:3px 5px;">
    </label>`;
  }

  _selectField(id, label, options, value, labels = {}) {
    return `<label style="display:flex; flex-direction:column; gap:2px; color:#aaa;">
      ${label}
      <select id="${id}" style="background:#2a2a2a; color:#fff; border:1px solid #444; border-radius:3px; padding:3px 5px;">
        ${options.map((option) => `<option value="${option}" ${option === value ? 'selected' : ''}>${labels[option] || option}</option>`).join('')}
      </select>
    </label>`;
  }

  _startAngleReadout() {
    const update = () => {
      this._angleRaf = null;
      if (this._disposed || this.container?.offsetParent === null) return;
      this._syncAngleReadoutsNow();
      if (this.sim.isPlaying || this.sim.playing) {
        this._angleRaf = requestAnimationFrame(update);
      }
    };
    if (!this._angleRaf) {
      this._angleRaf = requestAnimationFrame(update);
    }
  }

  refresh() {
    if (!this.editorEl) return;
    // The dock pane is hidden most of the time; rebuilding this form on every
    // selection made bulk object creation O(n) DOM work. Defer until visible.
    if (this.container && this.container.offsetParent === null) {
      this._dirty = true;
      return;
    }
    this._dirty = false;
    this.refreshStatus();
    this.groundEl.checked = this.sim.groundEnabled;
    if (this.debugEl) this.debugEl.checked = Boolean(this.sim.debugEnabled);
    const object = this.object;
    if (!object || !object.isObject3D) {
      this.editorEl.innerHTML = '<span style="color:#888;">Select an object to add a Rigid Body. Ground plane is enabled at y=0.</span>';
      return;
    }

    const config = this.sim.getConfig(object);
    const hasBody = this.sim.bodies.has(object);
    this.editorEl.innerHTML = `
      <div style="display:flex; gap:10px; align-items:flex-end; flex-wrap:wrap;">
        <b id="phys-object-name" style="width:100%; color:#e0e0e0;"></b>
        ${this._selectField('phys-body', 'Body', PHYSICS_BODY_TYPES, config.body)}
        ${this._selectField('phys-collider', 'Collider', PHYSICS_COLLIDER_TYPES, config.collider)}
        ${this._numberField('phys-mass', 'Mass (kg)', config.mass)}
        ${this._numberField('phys-friction', 'Friction', config.friction, 0.05)}
        ${this._numberField('phys-restitution', 'Restitution', config.restitution, 0.05)}
        ${this._numberField('phys-linear-damping', 'Lin. damping', config.linearDamping, 0.01)}
        ${this._numberField('phys-angular-damping', 'Ang. damping', config.angularDamping, 0.01)}
        <button id="phys-apply" class="timeline-btn">${hasBody ? 'Apply' : 'Add Rigid Body'}</button>
        ${hasBody ? '<button id="phys-remove" class="timeline-btn" style="color:#ff9b90;">Remove</button>' : ''}
      </div>
      <div style="color:#888; margin-top:6px;">
        Dynamic: gravity/collisions · Fixed: static ground/walls · Kinematic: driven by animation.
      </div>
      <div style="border-top:1px solid #333; margin-top:8px; padding-top:8px;">
        ${this._renderJointSection(object)}
      </div>
    `;

    this.editorEl.querySelector('#phys-object-name').textContent =
      `${object.name || object.type}${hasBody ? ' · Rigid Body active' : ''}`;
    this.editorEl.querySelector('#phys-apply').addEventListener('click', async () => {
      if (!this.sim.ready) await this.sim.ensureInit?.();
      const value = (id, fallback) => {
        const raw = Number(this.editorEl.querySelector(`#${id}`).value);
        return Number.isFinite(raw) ? raw : fallback;
      };
      this.sim.setConfig(object, {
        body: this.editorEl.querySelector('#phys-body').value,
        collider: this.editorEl.querySelector('#phys-collider').value,
        mass: value('phys-mass', DEFAULT_PHYSICS.mass),
        friction: value('phys-friction', DEFAULT_PHYSICS.friction),
        restitution: value('phys-restitution', DEFAULT_PHYSICS.restitution),
        linearDamping: value('phys-linear-damping', DEFAULT_PHYSICS.linearDamping),
        angularDamping: value('phys-angular-damping', DEFAULT_PHYSICS.angularDamping)
      });
      this.refresh();
    });

    this.editorEl.querySelector('#phys-remove')?.addEventListener('click', () => {
      this.sim.removeObject(object, true);
      this.refresh();
    });
    this._bindJointEvents(object);
    this._syncAngleReadoutsNow();
  }

  _selectedObjects() {
    const set = this.sceneManager?.selectedObjects;
    return set ? Array.from(set) : [];
  }

  _renderJointSection() {
    const selected = this._selectedObjects();
    const validPair = selected.length === 2 && selected.every((o) => this.sim.canJoint(o));
    return `
      <b style="color:#8ab4f8;">Joints</b>
      <div style="display:flex; gap:10px; align-items:flex-end; flex-wrap:wrap; margin-top:6px;">
        ${this._selectField('phys-joint-type', 'Joint', PHYSICS_JOINT_TYPES, 'revolute')}
        ${this._selectField('phys-joint-axis', 'World Axis', PHYSICS_JOINT_AXES, 'z')}
        <button id="phys-joint-create" class="timeline-btn" ${validPair ? '' : 'disabled'}>Create Joint</button>
      </div>
      <div style="color:#999; margin-top:6px;">Select exactly 2 meshes; active (last) mesh stores the joint config. Anchor sits halfway between origins.</div>
      <div style="color:#999;">Auto-adds Dynamic if missing a body; set one side Fixed to anchor it. Connected bodies disable self-collision.</div>
      <div id="phys-joint-list" style="margin-top:6px;"></div>
    `;
  }

  _bindJointEvents(object) {
    const typeEl = this.editorEl.querySelector('#phys-joint-type');
    const axisEl = this.editorEl.querySelector('#phys-joint-axis');
    typeEl.addEventListener('change', () => { axisEl.disabled = typeEl.value === 'fixed'; });
    this.editorEl.querySelector('#phys-joint-create').addEventListener('click', async () => {
      if (!this.sim.ready) await this.sim.ensureInit?.();
      const selected = this._selectedObjects();
      if (selected.length !== 2 || !selected.every((o) => this.sim.canJoint(o))) return;
      const target = selected.find((o) => o !== object);
      const spec = this.sim.createJoint(object, target, { type: typeEl.value, axis: axisEl.value });
      this.refresh();
      if (!spec) this.setStatus('Selected objects already share a joint or are invalid.');
    });

    const root = this.sceneManager.rootContainer;
    const list = this.editorEl.querySelector('#phys-joint-list');
    this._angleReadouts = [];
    const usedIds = new Set([...this.editorEl.querySelectorAll('[id]')].map((element) => element.id));
    let jointCounter = 0;
    root?.traverse((owner) => {
      for (const spec of this.sim.getJoints(owner)) {
        if (!spec || (owner !== object && spec.targetUuid !== object.uuid)) continue;
        const jointIdx = jointCounter++;
        const target = root.getObjectByProperty('uuid', spec.targetUuid);
        const active = this.sim.jointEntries.some((entry) => entry.spec === spec);
        const row = document.createElement('div');
        row.dataset.jointRow = '';
        row.style.cssText = 'margin-top:8px; padding:8px; border:1px solid #444; border-radius:4px; background:#252525;';
        const header = document.createElement('div');
        header.style.cssText = 'display:flex; flex-wrap:wrap; gap:8px; align-items:center;';
        const label = document.createElement('span');
        label.style.cssText = 'overflow-wrap:anywhere; flex:1; min-width:120px; color:#ddd;';
        label.textContent = `${spec.type}: ${owner.name || owner.type} → ${target?.name || target?.type || 'missing object'}${active ? '' : ' (inactive)'}`;
        const remove = document.createElement('button');
        remove.className = 'timeline-btn';
        remove.style.flexShrink = '0';
        remove.textContent = 'Remove Joint';
        remove.dataset.jointRemove = '';
        remove.addEventListener('click', () => {
          this.sim.removeJoint(owner, spec);
          this.refresh();
        });
        header.append(label, remove);
        row.append(header);
        const config = this.sim.getJointConfig(owner, spec);
        if (config) {
          const angleLabel = document.createElement('span');
          angleLabel.style.cssText = 'display:block; margin-top:6px; color:#aaa;';
          angleLabel.append('Joint angle: ');
          const angle = document.createElement('output');
          angle.dataset.jointAngle = '';
          angle.setAttribute('aria-label', `Joint angle ${owner.name || owner.type}`);
          angle.style.cssText = 'font-variant-numeric:tabular-nums; font-weight:600;';
          angle.textContent = 'Inactive';
          angleLabel.append(angle);
          this._angleReadouts.push({ element: angle, owner, spec });
          row.append(angleLabel);
          const fields = document.createElement('div');
          fields.dataset.jointMotor = '';
          fields.style.cssText = 'display:flex; flex-wrap:wrap; gap:10px; align-items:flex-end; margin-top:8px;';
          const inputs = new Map();
          const prefix = `phys-joint-${owner.uuid}-${jointIdx}`;
          usedIds.add(prefix);
          for (const [key, title, type, min, max, step] of MOTOR_FIELDS) {
            const id = `${prefix}-${key}`;
            if (usedIds.has(id)) continue;
            usedIds.add(id);
            const holder = document.createElement('div');
            if (type === 'checkbox') {
              holder.innerHTML = `<label style="display:flex; gap:5px; align-items:center; min-height:28px; color:#ddd;"><input id="${id}" type="checkbox" data-joint-field="${key}">${title}</label>`;
            } else if (type === 'select') {
              holder.innerHTML = this._selectField(id, title, PHYSICS_MOTOR_MODES, config[key], MOTOR_LABELS);
              holder.querySelector('select').dataset.jointField = key;
            } else {
              holder.innerHTML = this._numberField(id, title, config[key], step);
              const input = holder.querySelector('input');
              input.min = min;
              input.max = max;
              input.dataset.jointField = key;
            }
            const input = holder.querySelector('input, select');
            if (input) {
              inputs.set(key, input);
              input.addEventListener('change', () => this._commitJointInput(owner, spec, key, input));
            }
            fields.append(holder);
          }
          this._syncMotorFields(owner, spec, inputs);
          row.append(fields);
        }
        list.append(row);
      }
    });
  }

  _syncMotorFields(owner, spec, inputs) {
    const config = this.sim.getJointConfig(owner, spec);
    if (!config) return;
    const velocity = config.motorMode === 'velocity' || config.motorMode === 'servo';
    const position = config.motorMode === 'position' || config.motorMode === 'servo';
    const lowerEl = inputs.get('lower');
    const upperEl = inputs.get('upper');
    if (lowerEl) lowerEl.max = config.upper;
    if (upperEl) upperEl.min = config.lower;
    for (const [key, enabled] of [['lower', config.limitsEnabled], ['upper', config.limitsEnabled],
      ['targetVelocity', velocity], ['targetAngle', position], ['stiffness', position],
      ['damping', config.motorMode !== 'off'], ['maxTorque', config.motorMode !== 'off']]) {
      const el = inputs.get(key);
      if (el) el.disabled = !enabled;
    }
  }

  _commitJointInput(owner, spec, key, input) {
    const value = input.type === 'checkbox' ? input.checked
      : input.tagName === 'SELECT' ? input.value
        : input.value === '' ? NaN : Number(input.value);
    if ((typeof value === 'number' && !Number.isFinite(value)) || (key === 'motorMode' && !PHYSICS_MOTOR_MODES.includes(value))) {
      input.value = this.sim.getJointConfig(owner, spec)[key];
      this.setStatus('Invalid joint value; previous configuration kept.');
      return;
    }
    const before = this.sim.getJointConfig(owner, spec);
    try {
      this.sim.setJointConfig(owner, spec, { [key]: value });
    } catch {
      input.value = before[key];
      this.setStatus('Unable to apply joint configuration.');
      return;
    }
    // setJointConfig records history, which can rebuild the editor mid-handler;
    // refresh from current state instead of syncing the now-detached input.
    this.refresh();
    this.setStatus('Applied motor / angle limits; press Ctrl+Z to undo.');
  }

  dispose() {
    this._disposed = true;
    if (this._angleRaf != null) cancelAnimationFrame(this._angleRaf);
    this._angleRaf = null;
    this._angleReadouts = [];
    this.sceneManager?.off?.('selectionChanged', this._selectionHandler);
    for (const event of ['historyChanged', 'objectAdded', 'objectRemoved', 'sceneCleared']) {
      this.sceneManager?.off?.(event, this._boundRefresh);
    }
    this._selectionHandler = null;
    if (this.container) this.container.innerHTML = '';
    this.statusEl = this.editorEl = this.groundEl = null;
  }
}
