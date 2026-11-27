/**
 * Web Blender Studio - Manual Skeleton Pose Editor
 * File: js/animation/manual-pose-editor.js
 *
 * Lets the user manually grab any joint of a character in the 3D viewport,
 * drag it to the desired position, and the editor solves the bone rotations
 * (FK, parent-space) so the skeleton follows. This is the "fix it by hand"
 * escape hatch for mocap retargets that look wrong.
 *
 * Features:
 * - Full-body joint handle list (auto-detected from the rig).
 * - Viewport joint handles (spheres) + drag with TransformControls.
 * - Up/Down chain selection: move 1 bone only, or whole sub-chain.
 * - "Apply IK to chain": drag a wrist, whole arm follows (simple CCD IK).
 * - Reset single bone / whole skeleton / mirror L<->R / bake current pose.
 * - Exports the current pose as a .json you can re-use.
 */

import * as THREE from 'three';

const HANDLE_RADIUS = 0.035;

// Semantic joint names the retargeter uses -> human readable label
// (exported so the UI can build the joint dropdown from one source of truth)
export const JOINT_LABELS = {
  hips: 'Hips',
  spine: 'Spine',
  spine1: 'Chest',
  neck: 'Neck',
  leftShoulder: 'Left Clavicle',
  leftArm: 'Left Upper Arm',
  leftForearm: 'Left Forearm',
  leftHand: 'Left Hand',
  rightShoulder: 'Right Clavicle',
  rightArm: 'Right Upper Arm',
  rightForearm: 'Right Forearm',
  rightHand: 'Right Hand',
  leftUpLeg: 'Left Thigh',
  leftLeg: 'Left Shin',
  leftFoot: 'Left Foot',
  rightUpLeg: 'Right Thigh',
  rightLeg: 'Right Shin',
  rightFoot: 'Right Foot',
};

export class ManualPoseEditor {
  constructor(engine, sceneManager) {
    this.engine = engine;             // { scene, camera, transformControls, renderer, domElement, addRenderCallback }
    this.sceneManager = sceneManager;

    this.character = null;
    this.bones = new Map();           // semantic key -> THREE.Bone
    this.restQuats = new Map();       // bone.uuid -> Quaternion (bind)
    this.restPositions = new Map();   // bone.uuid -> Vector3   (bind)

    this.handleGroup = null;          // THREE.Group holding joint spheres
    this.handles = new Map();         // bone.uuid -> Mesh
    this.selectedKey = null;
    this.mode = 'fk';                 // 'fk' | 'ik'
    this.chainDepth = 1;              // how many bones up the chain to affect

    this.enabled = false;
    this._dragging = false;
    this._dragStartQuats = new Map();

    this._raycaster = new THREE.Raycaster();
    this._pointer = new THREE.Vector2();
    this._onPointerDown = this._onPointerDown.bind(this);
  }

  // ------------------------------------------------------------------ //
  // Setup / teardown
  // ------------------------------------------------------------------ //

  setCharacter(character) {
    if (!character) return false;
    // Idempotent: remove old listeners/handles first so switching characters
    // does not stack pointerdown handlers.
    this.enable(false);
    this.disposeHandles();
    this.character = character;
    this._buildBoneMap();
    this._captureRest();
    this._buildHandles();
    this.enable(true);
    return true;
  }

  _buildBoneMap() {
    this.bones.clear();
    const all = [];
    this.character.traverse((o) => { if (o.isBone) all.push(o); });

    const aliases = {
      hips: ['hips', 'pelvis', 'root'],
      spine: ['spine', 'abdomen'],
      spine1: ['spine1', 'spine2', 'chest'],
      neck: ['neck', 'head'],
      leftShoulder: ['leftshoulder', 'clavicle_l', 'shoulder_l'],
      leftArm: ['leftarm', 'leftupperarm', 'upperarm_l'],
      leftForearm: ['leftforearm', 'leftlowerarm', 'lowerarm_l'],
      leftHand: ['lefthand', 'hand_l', 'wrist_l'],
      rightShoulder: ['rightshoulder', 'clavicle_r', 'shoulder_r'],
      rightArm: ['rightarm', 'rightupperarm', 'upperarm_r'],
      rightForearm: ['rightforearm', 'rightlowerarm', 'lowerarm_r'],
      rightHand: ['righthand', 'hand_r', 'wrist_r'],
      leftUpLeg: ['leftupleg', 'leftthigh', 'thigh_l', 'upperleg_l'],
      leftLeg: ['leftleg', 'leftcalf', 'calf_l', 'lowerleg_l'],
      leftFoot: ['leftfoot', 'foot_l', 'ankle_l'],
      rightUpLeg: ['rightupleg', 'rightthigh', 'thigh_r', 'upperleg_r'],
      rightLeg: ['rightleg', 'rightcalf', 'calf_r', 'lowerleg_r'],
      rightFoot: ['rightfoot', 'foot_r', 'ankle_r'],
    };

    for (const [key, aliasList] of Object.entries(aliases)) {
      for (const bone of all) {
        const clean = bone.name.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (aliasList.some((a) => clean.includes(a))) { this.bones.set(key, bone); break; }
      }
    }
  }

  _captureRest() {
    this.restQuats.clear();
    this.restPositions.clear();
    this.character.traverse((o) => {
      if (o.isBone) {
        this.restQuats.set(o.uuid, o.quaternion.clone());
        this.restPositions.set(o.uuid, o.position.clone());
      }
    });
  }

  // ------------------------------------------------------------------ //
  // Joint handles
  // ------------------------------------------------------------------ //

  _buildHandles() {
    this.disposeHandles();
    this.handleGroup = new THREE.Group();
    this.handleGroup.name = '__PoseEditorHandles';
    this.handleGroup.userData.isSystemObject = true;
    this.handleGroup.userData.selectable = false;

    const geo = new THREE.SphereGeometry(HANDLE_RADIUS, 16, 12);
    for (const [key, bone] of this.bones.entries()) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0x00b4ff,
        depthTest: false,
        transparent: true,
        opacity: 0.9,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = `__handle_${key}`;
      mesh.renderOrder = 999;
      mesh.userData.isPoseHandle = true;
      mesh.userData.boneKey = key;
      mesh.userData.bone = bone;
      mesh.userData.isSystemObject = true;
      bone.getWorldPosition(mesh.position);
      this.handleGroup.add(mesh);
      this.handles.set(bone.uuid, mesh);
    }

    // Thin connector lines so the skeleton is visible
    const lineMat = new THREE.LineBasicMaterial({ color: 0xffa50f, transparent: true, opacity: 0.85 });
    for (const [, bone] of this.bones.entries()) {
      if (!bone.parent || !bone.parent.isBone) continue;
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
        lineMat
      );
      line.userData.fromBone = bone.parent;
      line.userData.toBone = bone;
      line.userData.isPoseConnector = true;
      // Connectors are visual only. If they stay raycastable, they sit between
      // the camera and the joint spheres and steal every click.
      line.raycast = () => {};
      line.userData.selectable = false;
      this.handleGroup.add(line);
    }

    this.engine.scene.add(this.handleGroup);
  }

  disposeHandles() {
    if (!this.handleGroup) return;
    this.handleGroup.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
    this.engine.scene.remove(this.handleGroup);
    this.handleGroup = null;
    this.handles.clear();
  }

  /** Called every frame to keep sphere positions glued to the bones. */
  update() {
    if (!this.handleGroup) return;
    if (this.character) this.character.updateMatrixWorld(true);

    // Handles live in a separate group, not under the skeleton, so writing
    // mesh.position is NOT enough: their matrixWorld stays stale (0,0,0) and
    // raycast picking silently fails. Refresh it explicitly.
    for (const [, mesh] of this.handles.entries()) {
      const bone = mesh.userData.bone;
      if (!bone) continue;
      bone.getWorldPosition(mesh.position);
      mesh.updateMatrixWorld(true);
    }

    for (const c of this.handleGroup.children) {
      if (!c.userData.isPoseConnector) continue;
      const from = c.userData.fromBone.getWorldPosition(new THREE.Vector3());
      const to = c.userData.toBone.getWorldPosition(new THREE.Vector3());
      c.geometry.setFromPoints([from, to]);
      c.geometry.attributes.position.needsUpdate = true;
      c.geometry.computeBoundingSphere();
      c.updateMatrixWorld(true);
    }
  }

  // ------------------------------------------------------------------ //
  // Enable / disable + picking
  // ------------------------------------------------------------------ //

  enable(on) {
    const dom = this.engine.domElement || this.engine.renderer?.domElement;
    // Tolerate being called twice without DOM (headless / engine not mounted)
    this.enabled = !!on;
    if (this.handleGroup) this.handleGroup.visible = this.enabled;
    if (!dom) return;
    // Always remove first: addEventListener would otherwise stack duplicates.
    // Capture phase = runs before the engine's selection raycaster.
    dom.removeEventListener('pointerdown', this._onPointerDown, true);
    if (on) {
      dom.addEventListener('pointerdown', this._onPointerDown, true);
    } else {
      this.detachGizmo();
    }
  }

  /**
   * Camera must be up to date before projecting screen space: the engine only
   * updates camera matrices inside render(), and a click can happen right
   * after an orbit move. Without this, picking misses the handles.
   */
  _pickHandle(ev) {
    const dom = this.engine.domElement || this.engine.renderer?.domElement;
    if (!dom || !this.handleGroup) return null;
    const cam = this.engine.camera;
    if (!cam) return null;
    // Always refresh camera + handles so projection matches what was rendered.
    cam.updateMatrixWorld(true);
    if (this.handleGroup) this.update();
    const rect = this.engine.getViewportRect ? this.engine.getViewportRect() : dom.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    this._pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    this._pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;

    this._raycaster.setFromCamera(this._pointer, cam);
    // Connector lines also live in this group and can be the first hit, so we
    // must pick the nearest MESH, not just hits[0].
    const hits = this._raycaster.intersectObjects(this.handleGroup.children, false);
    for (const hit of hits) {
      const obj = hit.object;
      if (obj && obj.isMesh && obj.userData?.isPoseHandle) return obj;
    }
    return null;
  }

  /**
   * Registered on the engine canvas at CAPTURE phase, so it runs before the
   * engine's own selection raycaster, and converts the click into a joint
   * selection + gizmo attach instead of selecting the character mesh.
   */
  _onPointerDown(ev) {
    if (!this.enabled || this._dragging) return;
    // Leave gizmo drags alone (TransformControls sits on top of the canvas)
    const tc = this.engine.transformControls;
    if (tc && (tc.dragging || tc.hovered)) return;

    const handle = this._pickHandle(ev);
    if (!handle) return;

    this.selectJoint(handle.userData.boneKey);

    // Keep the joint picker in the Mocap panel in sync
    if (typeof window !== 'undefined') {
      const sel = typeof document !== 'undefined' ? document.getElementById('pose-edit-joint') : null;
      if (sel) sel.value = handle.userData.boneKey;
    }

    this._attachGizmoForHandle(handle);
    // Consume the event so the engine does not re-select the character
    ev.preventDefault();
    ev.stopPropagation();
    ev.stopImmediatePropagation?.();
  }

  selectJoint(key) {
    this.selectedKey = key;
    for (const [uuid, mesh] of this.handles.entries()) {
      const bone = this.bones.get(key);
      const active = bone && bone.uuid === uuid;
      mesh.material.color.set(active ? 0x2ecc71 : 0x00b4ff);
      mesh.material.opacity = active ? 1.0 : 0.55;
      mesh.scale.setScalar(active ? 1.35 : 1.0);
    }
  }

  /** World position of a joint's TIP (end of its bone), which is what the
   *  user perceives as "the joint". Used to place the gizmo. */
  _getJointTipWorld(bone) {
    const child = bone.children.find((c) => c.isBone && c.position.lengthSq() > 1e-10);
    if (child) return child.getWorldPosition(new THREE.Vector3());
    return bone.getWorldPosition(new THREE.Vector3());
  }

  _attachGizmoForHandle(handle) {
    const tc = this.engine.transformControls;
    if (!tc) return;
    // We drag a ghost object; on mouseMove we solve rotations from it.
    // Place it at the bone TIP so the arrows sit on the visible joint.
    this.detachGizmo();
    this._dragGhost = new THREE.Object3D();
    this._dragGhost.position.copy(this._getJointTipWorld(handle.userData.bone));
    this._dragGhost.userData.isSystemObject = true;
    this.engine.scene.add(this._dragGhost);

    tc.attach(this._dragGhost);
    tc.setMode('translate');
    tc.setSpace('world');

    this._dragStartQuats.clear();
    const chain = this._getChain(handle.userData.bone);
    chain.forEach((b) => this._dragStartQuats.set(b.uuid, b.quaternion.clone()));

    if (!this._tcHooked && tc) {
      tc.addEventListener('objectChange', () => this._onGizmoMove());
      this._tcHooked = true;
    }
  }

  detachGizmo() {
    const tc = this.engine.transformControls;
    if (tc && this._dragGhost) tc.detach();
    if (this._dragGhost) {
      this.engine.scene.remove(this._dragGhost);
      this._dragGhost = null;
    }
    this._dragStartQuats.clear();
  }

  /**
   * Placement chain: every bone from the selected joint UP to the root.
   * For FK we rotate only the deepest bone's parent chain up to its direct
   * parent (the joint itself moves its children).
   */
  _getChain(bone) {
    const chain = [];
    let cur = bone;
    while (cur && cur.isBone) {
      chain.push(cur);
      if (cur === this.bones.get('hips')) break;
      cur = cur.parent;
    }
    return chain;
  }

  /** Parent chain of a joint, sorted root -> leaf (needed by CCD). */
  _getParentChain(bone) {
    const chain = [];
    let cur = bone.parent;
    while (cur && cur.isBone) {
      chain.unshift(cur);
      if (cur === this.bones.get('hips')) break;
      cur = cur.parent;
    }
    return chain;
  }

  // ------------------------------------------------------------------ //
  // Drag solving
  // ------------------------------------------------------------------ //

  _onGizmoMove() {
    if (!this.selectedKey || !this._dragGhost) return;
    const bone = this.bones.get(this.selectedKey);
    if (!bone) return;
    const targetWorld = this._dragGhost.position.clone();

    if (!bone.parent) return;

    if (this.mode === 'ik' && this.chainDepth > 1) {
      // CCD pulls the whole chain so the joint TIP reaches the target.
      this._ccdSolve(bone, targetWorld, Math.max(2, this.chainDepth));
      this.character.updateMatrixWorld(true);
      this.update();
      return;
    }

    // FK: rotate the bone so its own axis points from the bone HEAD to the
    // dragged position of its TIP. Its children follow via the hierarchy.
    const head = bone.getWorldPosition(new THREE.Vector3());
    const dir = targetWorld.clone().sub(head);
    if (dir.lengthSq() < 1e-8) return;

    this._aimBoneAt(bone, dir.normalize());
    this.character.updateMatrixWorld(true);
    this.update();
  }

  /** Rotate a bone in its parent space so its own direction matches dirWorld. */
  _aimBoneAt(bone, dirWorld) {
    const parentQ = bone.parent.getWorldQuaternion(new THREE.Quaternion());
    const localDir = dirWorld.clone().applyQuaternion(parentQ.clone().invert());
    const restLocalDir = this._boneRestDirInParent(bone);
    const delta = new THREE.Quaternion().setFromUnitVectors(restLocalDir, localDir);
    const restQ = this.restQuats.get(bone.uuid) || new THREE.Quaternion();
    bone.quaternion.copy(delta.multiply(restQ));
  }

  _boneRestDirInParent(bone) {
    // Direction from bone to its first bone-child in bone-local space
    const child = bone.children.find((c) => c.isBone);
    if (child && child.position.lengthSq() > 1e-10) {
      const v = child.position.clone().normalize();
      const restQ = this.restQuats.get(bone.uuid) || new THREE.Quaternion();
      return v.applyQuaternion(restQ);
    }
    // Fallback: bone's own direction towards its local +Y
    return new THREE.Vector3(0, 1, 0);
  }

  /** Simple CCD IK over the chain above the dragged bone. */
  _ccdSolve(endBone, targetWorld, iterations) {
    const chain = this._getChain(endBone).slice(1); // skip end bone itself
    for (let it = 0; it < iterations; it++) {
      for (const joint of chain) {
        if (!joint.parent) continue;
        const jointPos = joint.getWorldPosition(new THREE.Vector3());
        const endPos = endBone.getWorldPosition(new THREE.Vector3());
        const toEnd = endPos.clone().sub(jointPos).normalize();
        const toTarget = targetWorld.clone().sub(jointPos).normalize();

        const axis = new THREE.Vector3().crossVectors(toEnd, toTarget);
        if (axis.lengthSq() < 1e-9) continue;
        axis.normalize();
        const angle = Math.acos(THREE.MathUtils.clamp(toEnd.dot(toTarget), -1, 1));
        if (angle < 1e-4) continue;

        // Apply rotation in joint parent space
        const parentQ = joint.parent.getWorldQuaternion(new THREE.Quaternion());
        const localAxis = axis.applyQuaternion(parentQ.clone().invert());
        const q = new THREE.Quaternion().setFromAxisAngle(localAxis, angle);
        joint.quaternion.premultiply(q);
        joint.updateMatrixWorld(true);
      }
      this.character.updateMatrixWorld(true);
    }
  }

  // ------------------------------------------------------------------ //
  // Actions
  // ------------------------------------------------------------------ //

  resetBone(key) {
    const bone = this.bones.get(key);
    if (!bone) return;
    const q = this.restQuats.get(bone.uuid);
    if (q) bone.quaternion.copy(q);
    this.character.updateMatrixWorld(true);
    this.update();
  }

  /**
   * Bake the manually-edited skeleton into a static AnimationClip so the pose
   * survives mixer playback / export. Returns the clip (1 keyframe at t=0).
   */
  bakeToClip(name = 'ManualPose') {
    if (!this.character) return null;
    const bones = [];
    this.character.traverse((o) => { if (o.isBone) bones.push(o); });
    const tracks = [];
    const times = new Float32Array([0]);
    for (const b of bones) {
      tracks.push(new THREE.QuaternionKeyframeTrack(
        `${b.name}.quaternion`, times,
        new Float32Array([b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w])
      ));
      const restP = this.restPositions.get(b.uuid);
      if (restP && !restP.equals(b.position)) {
        tracks.push(new THREE.VectorKeyframeTrack(
          `${b.name}.position`, times,
          new Float32Array([b.position.x, b.position.y, b.position.z])
        ));
      }
    }
    return new THREE.AnimationClip(name, 0, tracks);
  }

  resetAll() {
    this.character.traverse((o) => {
      if (o.isBone) {
        const q = this.restQuats.get(o.uuid);
        const p = this.restPositions.get(o.uuid);
        if (q) o.quaternion.copy(q);
        if (p) o.position.copy(p);
      }
    });
    this.character.updateMatrixWorld(true);
    this.update();
  }

  mirrorLR() {
    const pairs = [
      ['leftArm', 'rightArm'], ['leftForearm', 'rightForearm'], ['leftHand', 'rightHand'],
      ['leftShoulder', 'rightShoulder'],
      ['leftUpLeg', 'rightUpLeg'], ['leftLeg', 'rightLeg'], ['leftFoot', 'rightFoot'],
    ];
    for (const [a, b] of pairs) {
      const bA = this.bones.get(a);
      const bB = this.bones.get(b);
      if (!bA || !bB) continue;
      const qa = bA.quaternion.clone();
      const qb = bB.quaternion.clone();
      // Mirror: flip Y & Z of the quaternion (X-axis mirror)
      bA.quaternion.set(qb.x, -qb.y, -qb.z, qb.w);
      bB.quaternion.set(qa.x, -qa.y, -qa.z, qa.w);
    }
    this.character.updateMatrixWorld(true);
    this.update();
  }

  /** Snapshot the current pose so the mocap clip can be offset by it. */
  exportPose() {
    const out = { name: 'manual_pose', bones: {} };
    this.character.traverse((o) => {
      if (o.isBone) {
        out.bones[o.name] = [
          +o.quaternion.x.toFixed(5), +o.quaternion.y.toFixed(5),
          +o.quaternion.z.toFixed(5), +o.quaternion.w.toFixed(5),
        ];
      }
    });
    return out;
  }

  /** Offsets to add on top of a mocap clip (used by the retargeter). */
  getPoseOffsets() {
    const offsets = new Map();
    for (const [, bone] of this.bones.entries()) {
      if (!bone) continue;
      const rest = this.restQuats.get(bone.uuid);
      if (!rest) continue;
      offsets.set(bone.name, bone.quaternion.clone());
    }
    return offsets;
  }

  dispose() {
    this.enable(false);
    this.disposeHandles();
    this.character = null;
  }
}
