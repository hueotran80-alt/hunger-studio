/**
 * @file simulation-manager.js
 * @description Deterministic rigid-body simulation for Web Blender Studio.
 *
 * Design rules:
 * - Fixed timestep (60 Hz), independent from the render loop.
 * - Physics properties live in `object.userData.physics`, so project JSON
 *   round-trips them without a second schema.
 * - The Rapier world can always be rebuilt from Three transforms + config.
 * - Bake writes ordinary timeline keyframes, so GLB export needs no Rapier.
 */

import * as THREE from 'three';
import { initRapier } from './rapier-loader.js';

export const PHYSICS_BODY_TYPES = Object.freeze(['dynamic', 'fixed', 'kinematic']);
export const PHYSICS_COLLIDER_TYPES = Object.freeze(['auto', 'box', 'sphere', 'capsule', 'cylinder', 'convex']);
export const PHYSICS_JOINT_TYPES = Object.freeze(['revolute', 'fixed']);
export const PHYSICS_JOINT_AXES = Object.freeze(['x', 'y', 'z']);
export const PHYSICS_MOTOR_MODES = Object.freeze(['off', 'velocity', 'position', 'servo']);

export const DEFAULT_REVOLUTE = Object.freeze({
  limitsEnabled: false,
  lower: -180,
  upper: 180,
  motorMode: 'off',
  targetVelocity: 0,
  targetAngle: 0,
  stiffness: 20,
  damping: 2,
  maxTorque: 100
});

export const DEFAULT_PHYSICS = Object.freeze({
  body: 'dynamic',
  collider: 'auto',
  mass: 1,
  friction: 0.5,
  restitution: 0.1,
  linearDamping: 0.05,
  angularDamping: 0.05
});

const _box = new THREE.Box3();
const _size = new THREE.Vector3();
const _center = new THREE.Vector3();
const _worldPos = new THREE.Vector3();
const _worldQuat = new THREE.Quaternion();
const _parentQuat = new THREE.Quaternion();
const _invMatrix = new THREE.Matrix4();
const _midpoint = new THREE.Vector3();
const _axisVec = new THREE.Vector3();
const _tmpQuat = new THREE.Quaternion();
const _frame1 = new THREE.Quaternion();
const _frame2 = new THREE.Quaternion();
const _relativeRotation = new THREE.Quaternion();
const MAX_TORQUE = 10000;
const MAX_SPRING = 10000;
const MAX_SPEED = 3600;

function vector(value, size) {
  return Array.isArray(value) && value.length === size && value.every(Number.isFinite);
}

function unit(value, size) {
  return vector(value, size) && Math.abs(Math.hypot(...value) - 1) < 1e-4;
}

function validJointSpec(spec) {
  return spec && PHYSICS_JOINT_TYPES.includes(spec.type) && typeof spec.targetUuid === 'string'
    && vector(spec.anchor, 3) && vector(spec.targetAnchor, 3)
    && (spec.type === 'fixed'
      ? unit(spec.frame, 4) && unit(spec.targetFrame, 4)
      : unit(spec.axis, 3) && unit(spec.targetAxis, 3) && validRevoluteConfig(spec));
}

function normalizeRevolute(input = {}, previous = DEFAULT_REVOLUTE) {
  const finite = (value, fallback) => Number.isFinite(value) ? value : fallback;
  const lower = THREE.MathUtils.clamp(finite(input.lower, previous.lower), -180, 180);
  return {
    limitsEnabled: typeof input.limitsEnabled === 'boolean' ? input.limitsEnabled : previous.limitsEnabled,
    lower,
    upper: THREE.MathUtils.clamp(finite(input.upper, previous.upper), lower, 180),
    motorMode: PHYSICS_MOTOR_MODES.includes(input.motorMode) ? input.motorMode : previous.motorMode,
    targetVelocity: THREE.MathUtils.clamp(finite(input.targetVelocity, previous.targetVelocity), -MAX_SPEED, MAX_SPEED),
    targetAngle: THREE.MathUtils.clamp(finite(input.targetAngle, previous.targetAngle), -180, 180),
    stiffness: THREE.MathUtils.clamp(finite(input.stiffness, previous.stiffness), 0, MAX_SPRING),
    damping: THREE.MathUtils.clamp(finite(input.damping, previous.damping), 0, MAX_SPRING),
    maxTorque: THREE.MathUtils.clamp(finite(input.maxTorque, previous.maxTorque), 0, MAX_TORQUE)
  };
}

function validRevoluteConfig(spec) {
  if ('limitsEnabled' in spec && typeof spec.limitsEnabled !== 'boolean') return false;
  if ('motorMode' in spec && !PHYSICS_MOTOR_MODES.includes(spec.motorMode)) return false;
  for (const key of ['lower', 'upper', 'targetVelocity', 'targetAngle', 'stiffness', 'damping', 'maxTorque']) {
    if (key in spec && !Number.isFinite(spec[key])) return false;
  }
  const config = normalizeRevolute(spec);
  return Object.keys(config).every((key) => !(key in spec) || config[key] === spec[key]);
}

function revoluteAngle(spec, joint, reference = 0) {
  const rotation1 = joint.body1().rotation(), rotation2 = joint.body2().rotation();
  const localFrame1 = joint.frameX1(), localFrame2 = joint.frameX2();
  _frame1.set(rotation1.x, rotation1.y, rotation1.z, rotation1.w)
    .multiply(_tmpQuat.set(localFrame1.x, localFrame1.y, localFrame1.z, localFrame1.w));
  _frame2.set(rotation2.x, rotation2.y, rotation2.z, rotation2.w)
    .multiply(_tmpQuat.set(localFrame2.x, localFrame2.y, localFrame2.z, localFrame2.w));
  _relativeRotation.copy(_frame1).invert().multiply(_frame2);
  const angle = 2 * Math.atan2(_relativeRotation.x, _relativeRotation.w) - reference;
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

export class SimulationManager {
  constructor({ sceneManager = null, engine = null, timelineEngine = null } = {}) {
    this.sceneManager = sceneManager;
    this.engine = engine;
    this.timelineEngine = timelineEngine;

    this.RAPIER = null;
    this.world = null;
    this.bodies = new Map();
    this.jointEntries = [];
    this._angleReferences = new WeakMap();
    this.fixedDt = 1 / 60;
    this.gravity = { x: 0, y: -9.81, z: 0 };
    this.groundEnabled = false;
    this.groundY = 0;

    this.playing = false;
    this._raf = null;
    this._lastTime = null;
    this._accumulator = 0;
    this._initial = null;
    this._isStepping = false;
    this._hasStepped = false;
    this.debugEnabled = false;
    this._debugHelper = null;
    this._tick = this._tick.bind(this);
  }

  async init() {
    if (this.world) return this;
    if (this._initPromise) return this._initPromise;
    this._initPromise = (async () => {
      this.RAPIER = await initRapier();
      this._ensureWorld();
      if (this.sceneManager && typeof this.sceneManager.on === 'function') {
        this._sceneHandlers = {
          objectAdded: ({ object }) => object?.traverse((node) => {
            if (node.userData.physics && !this.bodies.has(node)) this.addObject(node);
          }),
          objectRemoved: ({ object }) => object?.traverse((node) => this.removeObject(node)),
          transformChanged: ({ object } = {}) => {
            if (this.playing || this._isStepping || !object) return;
            const entry = this.bodies.get(object);
            if (!entry) return;
            this._syncBodyFromObject(entry);
            if (!this._hasStepped && this._initial?.has(object)) {
              this._initial.set(object, {
                position: object.position.clone(),
                quaternion: object.quaternion.clone(),
                scale: object.scale.clone(),
              });
            }
            if (this.debugEnabled) this.updateDebugRender();
          },
          sceneCleared: () => {
            this.pause();
            this._initial = null;
            this._hasStepped = false;
            this._ensureWorld();
            this.updateDebugRender();
          }
        };
        for (const [event, handler] of Object.entries(this._sceneHandlers)) {
          this.sceneManager.on(event, handler);
        }
        this._sceneHandlers.objectAdded({ object: this.sceneManager.rootContainer });
      }
      return this;
    })();
    try {
      return await this._initPromise;
    } finally {
      if (!this.world) this._initPromise = null;
    }
  }

  async ensureInit() {
    return this.init();
  }

  get ready() { return !!this.world; }
  get bodyCount() { return this.bodies.size; }
  get isPlaying() { return this.playing; }

  _ensureWorld() {
    if (this.world) {
      try { this.world.free?.(); } catch (_) { /* already freed */ }
    }
    this.bodies.clear();
    this.jointEntries = [];
    this.world = new this.RAPIER.World(this.gravity);
    this.world.timestep = this.fixedDt;
    if (this.groundEnabled) this._createGround();
  }

  _createGround() {
    const RAPIER = this.RAPIER;
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(0, this.groundY - 0.1, 0)
    );
    this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(100, 0.1, 100).setFriction(0.8).setRestitution(0.0),
      body
    );
  }

  setGravity(x = 0, y = -9.81, z = 0) {
    const prev = this.gravity || { x: 0, y: -9.81, z: 0 };
    this.gravity = {
      x: Number.isFinite(x) ? x : (Number.isFinite(prev.x) ? prev.x : 0),
      y: Number.isFinite(y) ? y : (Number.isFinite(prev.y) ? prev.y : -9.81),
      z: Number.isFinite(z) ? z : (Number.isFinite(prev.z) ? prev.z : 0)
    };
    if (this.world) {
      this.world.gravity = this.gravity;
      for (const { body } of this.bodies.values()) {
        try { body.wakeUp?.(); } catch (_) {}
      }
    }
  }

  setGroundEnabled(enabled, y = this.groundY) {
    this.groundEnabled = !!enabled;
    this.groundY = Number.isFinite(y) ? y : 0;
    if (this.world) {
      const configs = [...this.bodies.values()].map((entry) => ({
        object: entry.object,
        config: { ...entry.config }
      }));
      this._ensureWorld();
      configs.forEach(({ object, config }) => this.addObject(object, config));
    }
  }

  hasPhysics(object) {
    return this.bodies.has(object) || !!object?.userData?.physics;
  }

  getConfig(object) {
    const existing = object?.userData?.physics;
    return { ...DEFAULT_PHYSICS, ...(existing || {}) };
  }

  setConfig(object, partial = {}) {
    if (!object) return null;
    const config = { ...this.getConfig(object), ...partial };
    if (!PHYSICS_BODY_TYPES.includes(config.body)) config.body = 'dynamic';
    if (!PHYSICS_COLLIDER_TYPES.includes(config.collider)) config.collider = 'auto';
    for (const key of ['mass', 'friction', 'restitution', 'linearDamping', 'angularDamping']) {
      if (!Number.isFinite(config[key])) config[key] = DEFAULT_PHYSICS[key];
    }
    config.mass = Math.max(0.0001, config.mass);
    config.friction = THREE.MathUtils.clamp(config.friction, 0, 2);
    config.restitution = THREE.MathUtils.clamp(config.restitution, 0, 1);
    config.linearDamping = Math.max(0, config.linearDamping);
    config.angularDamping = Math.max(0, config.angularDamping);
    object.userData.physics = config;
    if (this.world) this.addObject(object, config);
    else this.ensureInit().catch(() => {});
    return config;
  }

  _resolveColliderType(object, requested) {
    if (requested && requested !== 'auto') return requested;
    const type = object?.geometry?.type || '';
    if (type.includes('Sphere') || type.includes('Icosahedron')) return 'sphere';
    if (type.includes('Cylinder')) return 'cylinder';
    if (type.includes('Capsule')) return 'capsule';
    return 'box';
  }

  _buildColliderDesc(object, config) {
    const RAPIER = this.RAPIER;
    const type = this._resolveColliderType(object, config.collider);
    object.updateWorldMatrix(true, false);

    // World scale: a mesh parented under a scaled group used to be sized from
    // its local scale, so the collider was too small and the mesh sank into the floor.
    const worldScale = object.getWorldScale(new THREE.Vector3());

    let desc;
    if (object.geometry) {
      if (!object.geometry.boundingBox) object.geometry.computeBoundingBox();
      _box.copy(object.geometry.boundingBox);
      _box.getSize(_size);
      _box.getCenter(_center);
      _size.multiply(worldScale);
      _center.multiply(worldScale);
    } else {
      // Group / GLB hierarchy: compute union local AABB across descendant meshes
      _box.makeEmpty();
      const invRoot = new THREE.Matrix4().copy(object.matrixWorld).invert();
      const childMat = new THREE.Matrix4();
      const childBox = new THREE.Box3();
      object.traverse?.((child) => {
        if (child.isMesh && child.geometry && !child.userData?.isHelper && !child.userData?.isSystemObject) {
          if (!child.geometry.boundingBox) child.geometry.computeBoundingBox();
          child.updateWorldMatrix(true, false);
          childMat.multiplyMatrices(invRoot, child.matrixWorld);
          childBox.copy(child.geometry.boundingBox).applyMatrix4(childMat);
          _box.union(childBox);
        }
      });
      if (_box.isEmpty()) {
        _size.set(1, 1, 1);
        _center.set(0, 0, 0);
      } else {
        _box.getSize(_size);
        _box.getCenter(_center);
        _size.multiply(worldScale);
        _center.multiply(worldScale);
      }
    }

    const fallbackCuboid = () => RAPIER.ColliderDesc.cuboid(
      Math.max(0.005, Math.abs(_size.x) * 0.5 || 0.5),
      Math.max(0.005, Math.abs(_size.y) * 0.5 || 0.5),
      Math.max(0.005, Math.abs(_size.z) * 0.5 || 0.5)
    );

    if (type === 'sphere') {
      const radius = Math.max(Math.abs(_size.x), Math.abs(_size.y), Math.abs(_size.z)) * 0.5 || 0.5;
      desc = RAPIER.ColliderDesc.ball(radius);
    } else if (type === 'cylinder' && typeof RAPIER.ColliderDesc.cylinder === 'function') {
      const radius = Math.max(0.005, Math.max(Math.abs(_size.x), Math.abs(_size.z)) * 0.5 || 0.25);
      const halfHeight = Math.max(0.005, Math.abs(_size.y) * 0.5 || 0.25);
      desc = RAPIER.ColliderDesc.cylinder(halfHeight, radius);
    } else if (type === 'capsule' || type === 'cylinder') {
      const radius = Math.max(Math.abs(_size.x), Math.abs(_size.z)) * 0.5 || 0.25;
      const halfHeight = Math.max(0.005, Math.abs(_size.y) * 0.5 - radius);
      desc = RAPIER.ColliderDesc.capsule(halfHeight, radius);
    } else if (type === 'convex' && object.geometry) {
      const position = object.geometry.getAttribute('position');
      const hasVolumeScale = Math.abs(worldScale.x) > 1e-6
        && Math.abs(worldScale.y) > 1e-6
        && Math.abs(worldScale.z) > 1e-6;
      if (!position || position.count < 4 || !hasVolumeScale) {
        desc = fallbackCuboid();
      } else {
        const vertices = new Float32Array(position.count * 3);
        let finite = true;
        for (let i = 0; i < position.count; i += 1) {
          const vx = position.getX(i) * worldScale.x;
          const vy = position.getY(i) * worldScale.y;
          const vz = position.getZ(i) * worldScale.z;
          if (!Number.isFinite(vx) || !Number.isFinite(vy) || !Number.isFinite(vz)) {
            finite = false;
            break;
          }
          vertices[i * 3] = vx;
          vertices[i * 3 + 1] = vy;
          vertices[i * 3 + 2] = vz;
        }
        desc = finite ? RAPIER.ColliderDesc.convexHull(vertices) : null;
        if (!desc) desc = fallbackCuboid();
      }
    } else {
      desc = RAPIER.ColliderDesc.cuboid(
        Math.max(0.005, Math.abs(_size.x) * 0.5),
        Math.max(0.005, Math.abs(_size.y) * 0.5),
        Math.max(0.005, Math.abs(_size.z) * 0.5)
      );
    }

    if (_center.lengthSq() > 1e-10) desc.setTranslation(_center.x, _center.y, _center.z);
    return desc;
  }

  addObject(object, config = null) {
    if (!this.world || !object) return null;
    const cfg = config || this.getConfig(object);
    object.userData.physics = cfg;
    this.removeObject(object, false);
    object.updateWorldMatrix(true, false);
    object.getWorldPosition(_worldPos);
    object.getWorldQuaternion(_worldQuat);
    if (!Number.isFinite(_worldQuat.x) || !Number.isFinite(_worldQuat.y)
      || !Number.isFinite(_worldQuat.z) || !Number.isFinite(_worldQuat.w)
      || _worldQuat.lengthSq() < 1e-10) {
      _worldQuat.copy(object.quaternion);
      if (!Number.isFinite(_worldQuat.x) || !Number.isFinite(_worldQuat.y)
        || !Number.isFinite(_worldQuat.z) || !Number.isFinite(_worldQuat.w)
        || _worldQuat.lengthSq() < 1e-10) {
        _worldQuat.identity();
      } else {
        _worldQuat.normalize();
      }
    }

    const RAPIER = this.RAPIER;
    let bodyDesc;
    if (cfg.body === 'fixed') bodyDesc = RAPIER.RigidBodyDesc.fixed();
    else if (cfg.body === 'kinematic') bodyDesc = RAPIER.RigidBodyDesc.kinematicPositionBased();
    else bodyDesc = RAPIER.RigidBodyDesc.dynamic();
    bodyDesc.setTranslation(_worldPos.x, _worldPos.y, _worldPos.z);
    bodyDesc.setRotation({ x: _worldQuat.x, y: _worldQuat.y, z: _worldQuat.z, w: _worldQuat.w });
    bodyDesc.setLinearDamping(cfg.linearDamping);
    bodyDesc.setAngularDamping(cfg.angularDamping);

    const body = this.world.createRigidBody(bodyDesc);
    const configureCollider = (desc) => desc
      .setMass(cfg.mass)
      .setFriction(cfg.friction)
      .setRestitution(cfg.restitution);
    let colliderDesc = configureCollider(this._buildColliderDesc(object, cfg));
    let collider;
    try {
      collider = this.world.createCollider(colliderDesc, body);
    } catch (err) {
      if (this._resolveColliderType(object, cfg.collider) !== 'convex') throw err;
      colliderDesc = configureCollider(this._buildColliderDesc(object, { ...cfg, collider: 'box' }));
      collider = this.world.createCollider(colliderDesc, body);
    }

    const entry = { object, body, collider, config: cfg };
    this.bodies.set(object, entry);
    this._relinkJoints();
    return entry;
  }

  _relinkJoints() {
    if (!this.world) return;
    const byUuid = new Map([...this.bodies.keys()].map((object) => [object.uuid, object]));
    const previous = new Map(this.jointEntries.map((entry) => [entry.spec, entry]));
    const next = [];
    for (const [owner, ownerEntry] of this.bodies) {
      for (const spec of this.getJoints(owner)) {
        if (!validJointSpec(spec)) continue;
        const target = byUuid.get(spec.targetUuid);
        if (!target || target === owner) continue;
        const existing = previous.get(spec);
        if (existing) {
          this._applyRevoluteConfig(existing.joint, spec, existing.angleReference);
          next.push(existing);
          previous.delete(spec);
        } else {
          const joint = this._createRapierJoint(ownerEntry, this.bodies.get(target), spec);
          let reference = this._angleReferences.get(spec);
          if (reference === undefined) {
            reference = this._jointAngleReference(spec, joint);
            this._angleReferences.set(spec, reference);
          }
          this._applyRevoluteConfig(joint, spec, reference);
          next.push({ joint, spec, owner, target, angleReference: reference });
        }
      }
    }
    for (const { joint } of previous.values()) this.world.removeImpulseJoint(joint, true);
    this.jointEntries = next;
  }

  _createRapierJoint(ownerEntry, targetEntry, spec) {
    const point = (a) => ({ x: a[0], y: a[1], z: a[2] });
    const quaternion = (a) => ({ ...point(a), w: a[3] });
    const J = this.RAPIER.JointData;
    const jointData = spec.type === 'fixed'
      ? J.fixed(point(spec.anchor), quaternion(spec.frame), point(spec.targetAnchor), quaternion(spec.targetFrame))
      : J.revoluteWithAxes(point(spec.anchor), point(spec.targetAnchor), point(spec.axis), point(spec.targetAxis));
    const joint = this.world.createImpulseJoint(jointData, ownerEntry.body, targetEntry.body, true);
    joint.setContactsEnabled(false);
    return joint;
  }

  _jointAngleReference(spec, joint) {
    return spec.type === 'revolute' ? revoluteAngle(spec, joint) : 0;
  }

  _applyRevoluteConfig(joint, spec, reference = this._jointAngleReference(spec, joint)) {
    if (spec.type !== 'revolute') return;
    const config = normalizeRevolute(spec);
    const radLower = config.limitsEnabled ? THREE.MathUtils.degToRad(config.lower) : -Number.MAX_VALUE;
    const radUpper = config.limitsEnabled ? THREE.MathUtils.degToRad(config.upper) : Number.MAX_VALUE;
    if (config.limitsEnabled) {
      joint.setLimits(reference + radLower, reference + radUpper);
    } else {
      joint.setLimits(-Number.MAX_VALUE, Number.MAX_VALUE);
    }
    joint.configureMotorModel(this.RAPIER.MotorModel.ForceBased);
    const velocity = ['velocity', 'servo'].includes(config.motorMode)
      ? THREE.MathUtils.degToRad(config.targetVelocity) : 0;
    const target = config.motorMode === 'position' || config.motorMode === 'servo'
      ? reference + THREE.MathUtils.clamp(THREE.MathUtils.degToRad(config.targetAngle), radLower, radUpper)
      : revoluteAngle(spec, joint, reference);
    const stiffness = config.motorMode === 'position' || config.motorMode === 'servo' ? config.stiffness : 0;
    joint.configureMotor(target, velocity, stiffness, config.damping);
    joint.setMotorMaxForce(config.motorMode === 'off' ? 0 : config.maxTorque);
  }

  getJointConfig(owner, spec) {
    return spec?.type === 'revolute' && owner?.userData?.joints?.includes(spec)
      ? normalizeRevolute(spec) : null;
  }

  getJointAngle(owner, spec) {
    const entry = this.jointEntries.find((item) => item.owner === owner && item.spec === spec);
    return entry?.spec.type === 'revolute' ? THREE.MathUtils.radToDeg(revoluteAngle(spec, entry.joint, entry.angleReference)) : null;
  }

  setJointConfig(owner, spec, partial = {}, recordHistory = true) {
    const specs = owner?.userData?.joints;
    if (!Array.isArray(specs) || !specs.includes(spec) || spec.type !== 'revolute') return null;
    if (!partial || typeof partial !== 'object' || Array.isArray(partial)) throw new Error('Invalid joint configuration.');
    const current = normalizeRevolute(spec);
    const next = normalizeRevolute(partial, current);
    if (Object.keys(next).every((key) => next[key] === current[key])) return next;
    const wasLegacy = !Object.keys(DEFAULT_REVOLUTE).some((key) => key in spec);
    const apply = (config, legacy) => {
      this.pause();
      // Read live array dynamically so Undo after removeJoint->undo never sees stale deleted array
      const liveSpecs = owner?.userData?.joints;
      if (!Array.isArray(liveSpecs) || liveSpecs.indexOf(spec) < 0) return;
      for (const key of Object.keys(DEFAULT_REVOLUTE)) {
        if (legacy) delete spec[key];
        else spec[key] = config[key];
      }
      const entry = this.jointEntries.find((item) => item.owner === owner && item.spec === spec);
      if (entry) this._applyRevoluteConfig(entry.joint, spec, entry.angleReference);
      else this._relinkJoints();
    };
    apply(next, false);
    if (recordHistory) this.sceneManager?.executeCommand?.({
      description: 'Update joint motor / limits',
      execute: () => apply(next, false),
      undo: () => apply(current, wasLegacy)
    });
    return next;
  }

  canJoint(object) {
    return !!object?.isMesh && !object.isSkinnedMesh && !!object.geometry
      && !object.userData.isHelper && !object.userData.isCameraPart;
  }

  createJoint(owner, target, { type = 'revolute', axis = 'z' } = {}) {
    if (!this.world || !this.canJoint(owner) || !this.canJoint(target) || owner === target) return null;
    if (this.getJoints(owner).some((s) => s?.targetUuid === target.uuid)
      || this.getJoints(target).some((s) => s?.targetUuid === owner.uuid)) return null;
    if (!PHYSICS_JOINT_TYPES.includes(type)) type = 'revolute';
    if (!PHYSICS_JOINT_AXES.includes(axis)) axis = 'z';
    const addedBodies = [owner, target].filter((object) => !this.bodies.has(object));
    const previousConfigs = addedBodies.map((object) => object.userData.physics);
    this.pause();
    this._initial = null;
    this.addObject(owner);
    this.addObject(target);
    owner.updateWorldMatrix(true, false);
    target.updateWorldMatrix(true, false);
    const ownerRotation = owner.getWorldQuaternion(new THREE.Quaternion()).invert();
    const targetRotation = target.getWorldQuaternion(new THREE.Quaternion()).invert();
    const worldAxis = new THREE.Vector3();
    worldAxis[axis] = 1;
    _midpoint.copy(owner.getWorldPosition(new THREE.Vector3()))
      .add(target.getWorldPosition(new THREE.Vector3())).multiplyScalar(0.5);
    const spec = {
      type,
      targetUuid: target.uuid,
      anchor: this._worldAnchorToLocal(owner, _midpoint),
      targetAnchor: this._worldAnchorToLocal(target, _midpoint),
      ...(type === 'fixed' ? {
        frame: ownerRotation.toArray(),
        targetFrame: targetRotation.toArray()
      } : {
        axis: worldAxis.clone().applyQuaternion(ownerRotation).toArray(),
        targetAxis: worldAxis.clone().applyQuaternion(targetRotation).toArray()
      })
    };

    if (!Array.isArray(owner.userData.joints)) owner.userData.joints = [];
    owner.userData.joints.push(spec);
    this._relinkJoints();
    this.sceneManager?.executeCommand?.({
      description: `Create ${type} joint`,
      execute: () => {
        this.pause();
        addedBodies.forEach((object) => this.addObject(object));
        owner.userData.joints = [...this.getJoints(owner), spec];
        this._relinkJoints();
      },
      undo: () => {
        this.removeJoint(owner, spec, false);
        addedBodies.forEach((object, index) => {
          this.removeObject(object, true);
          if (previousConfigs[index]) object.userData.physics = previousConfigs[index];
        });
      }
    });
    return spec;
  }

  _worldAnchorToLocal(object, worldPoint) {
    object.getWorldPosition(_worldPos);
    object.getWorldQuaternion(_worldQuat);
    _axisVec.copy(worldPoint).sub(_worldPos);
    _tmpQuat.copy(_worldQuat).invert();
    _axisVec.applyQuaternion(_tmpQuat);
    return [_axisVec.x, _axisVec.y, _axisVec.z];
  }

  removeJoint(owner, spec, recordHistory = true) {
    const specs = owner?.userData?.joints;
    if (!Array.isArray(specs) || !specs.includes(spec)) return false;
    this.pause();
    const index = specs.indexOf(spec);
    specs.splice(index, 1);
    if (specs.length === 0) delete owner.userData.joints;
    this._relinkJoints();
    if (recordHistory) this.sceneManager?.executeCommand?.({
      description: 'Remove joint',
      execute: () => this.removeJoint(owner, spec, false),
      undo: () => {
        this.pause();
        owner.userData.joints = this.getJoints(owner);
        owner.userData.joints.splice(index, 0, spec);
        this._relinkJoints();
      }
    });
    return true;
  }

  getJoints(object) {
    const specs = object?.userData?.joints;
    return Array.isArray(specs) ? specs.slice() : [];
  }

  get jointCount() { return this.jointEntries.length; }

  removeObject(object, forgetConfig = false) {
    const entry = this.bodies.get(object);
    if (entry && this.world) {
      // Rapier removes attached joints, so discard their handles before relinking.
      this.jointEntries = this.jointEntries.filter((j) => j.owner !== object && j.target !== object);
      try { this.world.removeRigidBody(entry.body); } catch (_) { /* world rebuilt */ }
    }
    this.bodies.delete(object);
    if (entry && this.world) this._relinkJoints();
    if (forgetConfig && object?.userData) delete object.userData.physics;
  }

  _captureInitial() {
    this._initial = new Map();
    for (const object of this.bodies.keys()) {
      this._initial.set(object, {
        position: object.position.clone(),
        quaternion: object.quaternion.clone(),
        scale: object.scale.clone()
      });
    }
  }

  _restoreInitial() {
    if (!this._initial) return;
    for (const [object, state] of this._initial) {
      if (!object.parent && !this.bodies.has(object)) continue;
      object.position.copy(state.position);
      object.quaternion.copy(state.quaternion);
      object.scale.copy(state.scale);
      object.updateMatrixWorld(true);
    }
  }

  _rebuildBodies() {
    const configs = [...this.bodies.values()].map(({ object, config }) => ({ object, config }));
    this._ensureWorld();
    configs.forEach(({ object, config }) => this.addObject(object, config));
  }

  _syncBodyFromObject(entry) {
    const { object, body, config } = entry;
    if (!object || !body) return;
    object.updateWorldMatrix(true, false);
    object.getWorldPosition(_worldPos);
    object.getWorldQuaternion(_worldQuat);
    if (config.body === 'kinematic') {
      body.setNextKinematicTranslation({ x: _worldPos.x, y: _worldPos.y, z: _worldPos.z });
      body.setNextKinematicRotation({ x: _worldQuat.x, y: _worldQuat.y, z: _worldQuat.z, w: _worldQuat.w });
    } else {
      body.setTranslation({ x: _worldPos.x, y: _worldPos.y, z: _worldPos.z }, true);
      body.setRotation({ x: _worldQuat.x, y: _worldQuat.y, z: _worldQuat.z, w: _worldQuat.w }, true);
      if (typeof body.setLinvel === 'function') body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      if (typeof body.setAngvel === 'function') body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }
  }

  _stepWorldOnce() {
    if (!this.world) return;
    for (const entry of this.bodies.values()) {
      if (entry.config.body === 'kinematic') {
        this._syncBodyFromObject(entry);
      }
    }
    this._hasStepped = true;
    this.world.step();
  }

  _syncObjectFromBody(entry) {
    const { object, body } = entry;
    const translation = body.translation();
    const rotation = body.rotation();
    const position = _worldPos.set(translation.x, translation.y, translation.z);
    const quaternion = _worldQuat.set(rotation.x, rotation.y, rotation.z, rotation.w);
    if (object.parent) {
      object.parent.updateWorldMatrix(true, false);
      _invMatrix.copy(object.parent.matrixWorld).invert();
      object.position.copy(position).applyMatrix4(_invMatrix);
      object.parent.getWorldQuaternion(_parentQuat);
      object.quaternion.copy(_parentQuat.invert().multiply(quaternion));
    } else {
      object.position.copy(position);
      object.quaternion.copy(quaternion);
    }
    object.updateMatrixWorld(true);
  }

  _syncAll() {
    this._isStepping = true;
    try {
      for (const entry of this.bodies.values()) {
        if (entry.config.body === 'dynamic') this._syncObjectFromBody(entry);
      }
      if (this.debugEnabled) this.updateDebugRender();
      this.engine?.updateSelectionHelper?.();
      this.engine?.requestRender?.();
    } finally {
      this._isStepping = false;
    }
  }

  setDebugEnabled(enabled) {
    this.debugEnabled = Boolean(enabled);
    if (!this.debugEnabled) {
      if (this._debugHelper) this._debugHelper.visible = false;
      this.engine?.requestRender?.();
      return false;
    }
    this.updateDebugRender();
    return true;
  }

  updateDebugRender() {
    const scene = this.sceneManager?.scene || this.engine?.scene;
    if (!this.debugEnabled || !this.world || typeof this.world.debugRender !== 'function' || !scene) {
      if (this._debugHelper) this._debugHelper.visible = false;
      return null;
    }
    const buffers = this.world.debugRender();
    const verts = buffers?.vertices;
    const cols = buffers?.colors;
    if (!verts || verts.length === 0) {
      if (this._debugHelper) this._debugHelper.visible = false;
      return null;
    }
    if (!this._debugHelper) {
      const geom = new THREE.BufferGeometry();
      const mat = new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.85,
        depthTest: false,
      });
      this._debugHelper = new THREE.LineSegments(geom, mat);
      this._debugHelper.name = 'Physics_Debug_Wireframe';
      this._debugHelper.frustumCulled = false;
      this._debugHelper.renderOrder = 998;
      this._debugHelper.userData = {
        isSystemObject: true,
        isHelper: true,
        isPhysicsDebugHelper: true,
        selectable: false,
      };
      scene.add(this._debugHelper);
    }
    const g = this._debugHelper.geometry;
    g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    if (cols && cols.length >= (verts.length / 3) * 4) {
      // Rapier debugRender returns RGBA colors (4 floats/vertex); convert cleanly to RGB
      const vCount = verts.length / 3;
      const rgb = new Float32Array(vCount * 3);
      for (let i = 0; i < vCount; i++) {
        rgb[i * 3 + 0] = cols[i * 4 + 0];
        rgb[i * 3 + 1] = cols[i * 4 + 1];
        rgb[i * 3 + 2] = cols[i * 4 + 2];
      }
      g.setAttribute('color', new THREE.Float32BufferAttribute(rgb, 3));
    }
    this._debugHelper.visible = true;
    this.engine?.requestRender?.();
    return this._debugHelper;
  }

  stepFrames(count = 1) {
    if (!this.world) return;
    if (!this._initial) this._captureInitial();
    const frames = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
    for (let i = 0; i < frames; i += 1) {
      this._stepWorldOnce();
    }
    this._syncAll();
  }

  _tick(now) {
    if (!this.playing) return;
    if (this._lastTime == null) this._lastTime = now;
    const elapsed = Math.min(0.1, (now - this._lastTime) / 1000);
    this._lastTime = now;
    this._accumulator += elapsed;
    let steps = 0;
    while (this._accumulator >= this.fixedDt && steps < 6) {
      this._stepWorldOnce();
      this._accumulator -= this.fixedDt;
      steps += 1;
    }
    this._syncAll();
    this._raf = requestAnimationFrame(this._tick);
  }

  play() {
    if (!this.world || this.playing || this.bodies.size === 0) return false;
    if (!this._initial) this._captureInitial();
    this.playing = true;
    this._lastTime = null;
    this._accumulator = 0;
    this.engine?.requestRender?.();
    if (typeof requestAnimationFrame === 'function') {
      this._raf = requestAnimationFrame(this._tick);
    }
    return true;
  }

  pause() {
    this.playing = false;
    if (this._raf != null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this._raf);
    }
    this._raf = null;
  }

  reset() {
    this.pause();
    this._restoreInitial();
    this._initial = null;
    this._hasStepped = false;
    this._rebuildBodies();
    this._syncAll();
  }

  /**
   * Simulates `frames` frames at `fps`, recording position/rotation keyframes
   * with quaternion sign continuity, then restores the original scene state.
   */
  bake({ fps = 30, frames = 60, startFrame = 0 } = {}) {
    if (!this.world || !this.timelineEngine || this.bodies.size === 0) return null;
    const timeline = this.timelineEngine;
    const finiteFps = Number.isFinite(fps) ? fps : 30;
    const finiteFrames = Number.isFinite(frames) ? frames : 60;
    const safeFps = Math.max(1, Math.min(120, finiteFps));
    const totalFrames = Math.max(1, Math.min(5000, Math.floor(finiteFrames)));
    const baseFrame = Math.max(0, Math.floor(Number.isFinite(startFrame) ? startFrame : 0));
    this.pause();
    this._captureInitial();

    const stepDt = 1 / safeFps;
    let accumulator = 0;
    const prevQuats = new Map();

    for (let frame = 0; frame <= totalFrames; frame += 1) {
      if (frame > 0) {
        accumulator += stepDt;
        while (accumulator >= this.fixedDt - 1e-9) {
          this._stepWorldOnce();
          accumulator -= this.fixedDt;
        }
        this._syncAll();
      }
      for (const { object } of this.bodies.values()) {
        // Align quaternion hemisphere with previous frame to prevent 360-deg antipodal flip on GLB export
        const prev = prevQuats.get(object);
        if (prev && prev.dot(object.quaternion) < 0) {
          object.quaternion.set(-object.quaternion.x, -object.quaternion.y, -object.quaternion.z, -object.quaternion.w);
          object.rotation.setFromQuaternion(object.quaternion);
        }
        prevQuats.set(object, object.quaternion.clone());
        timeline.insertKeyframe(object, baseFrame + frame, ['position', 'rotation']);
      }
    }

    this._restoreInitial();
    this._initial = null;
    this._hasStepped = false;
    this._rebuildBodies();
    if (typeof timeline.seekToFrame === 'function') timeline.seekToFrame(baseFrame);
    return { frames: totalFrames + 1, objects: this.bodies.size };
  }

  dispose() {
    this.pause();
    for (const [event, handler] of Object.entries(this._sceneHandlers || {})) {
      this.sceneManager.off?.(event, handler);
    }
    this._sceneHandlers = null;
    this._initial = null;
    if (this._debugHelper) {
      try { this._debugHelper.parent?.remove(this._debugHelper); } catch (_) {}
      try { this._debugHelper.geometry?.dispose(); } catch (_) {}
      try { this._debugHelper.material?.dispose(); } catch (_) {}
      this._debugHelper = null;
    }
    if (this.world) {
      try { this.world.free?.(); } catch (_) { /* noop */ }
    }
    this.world = null;
    this.bodies.clear();
    this.jointEntries = [];
  }
}
