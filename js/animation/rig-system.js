/**
 * Web Blender Studio - Humanoid Rigging, Skeleton Armature & Pose Engine
 * Features:
 *  - Standard Humanoid Skeleton creation (Mixamo / glTF compatible)
 *  - Procedural Articulated Anatomical Mannequin generator
 *  - Analytical Two-Bone Inverse Kinematics (Two-Bone IK) with Pole Vectors for Arms & Legs
 *  - Interactive Pose Mode with Octahedral Bone Visualizers & Bone Shaft Hit Proxies
 *  - Standardized, twist-free 17+ Pose Presets (T-Pose, Combat Guard, Military Salute,
 *    Praying Pose, Hero Victory, Natural Idle, Sprint Run, etc.) for both Mannequin & Mixamo rigs
 *  - Standard Blender 4.x Weight Paint Visualizer (Heatmap: Blue -> Cyan -> Green -> Yellow -> Red)
 *  - Local/Character-space Quaternion math for frame-independent posing & mirroring
 * File: js/animation/rig-system.js
 */

import * as THREE from 'three';
import { computeLaplacianBoneHeatWeights, validateSkinWeights } from './bone-heat.js';
import { syncVertexGroupsFromSkinAttributes } from './vertex-groups.js';
import {
  listSkeletonTemplates as _listSkeletonTemplates,
  getSkeletonTemplate as _getSkeletonTemplate,
  buildSkeletonFromTemplate as _buildSkeletonFromTemplate,
  fitHumanoidSkeletonToMesh as _fitHumanoidSkeletonToMesh,
  analyzeHumanoidMeshSilhouette as _analyzeHumanoidMeshSilhouette,
} from './skeleton-templates.js';

/**
 * Undo/Redo command for Weight Paint brush strokes & batch operations.
 */
export class WeightPaintCommand {
  constructor(mesh, bone, oldIndices, oldWeights, newIndices, newWeights, onUpdate, description = 'Weight Paint') {
    this.mesh = mesh;
    this.bone = bone;
    this.oldIndices = new Uint16Array(oldIndices);
    this.oldWeights = new Float32Array(oldWeights);
    this.newIndices = new Uint16Array(newIndices);
    this.newWeights = new Float32Array(newWeights);
    this.onUpdate = onUpdate;
    this.description = description;
    this.bytes = this.oldIndices.byteLength + this.oldWeights.byteLength + this.newIndices.byteLength + this.newWeights.byteLength;
  }

  execute() {
    this._apply(this.newIndices, this.newWeights);
  }

  undo() {
    this._apply(this.oldIndices, this.oldWeights);
  }

  _apply(indices, weights) {
    const geom = this.mesh?.geometry;
    if (!geom?.attributes?.skinIndex || !geom?.attributes?.skinWeight) return;
    geom.attributes.skinIndex.array.set(indices);
    geom.attributes.skinWeight.array.set(weights);
    geom.attributes.skinIndex.needsUpdate = true;
    geom.attributes.skinWeight.needsUpdate = true;
    syncVertexGroupsFromSkinAttributes(this.mesh);
    if (this.onUpdate) this.onUpdate(this.mesh, this.bone);
  }
}

/**
 * Undo/Redo command for skeleton bone poses (IK/FK gizmo drag or reset/pose).
 */
export class PoseChangeCommand {
  constructor(skeleton, beforeQuats, afterQuats, beforePositions, afterPositions, onUpdate, description = 'Bone Pose') {
    this.skeleton = skeleton;
    this.beforeQuats = beforeQuats.map(q => q.clone());
    this.afterQuats = afterQuats.map(q => q.clone());
    this.beforePositions = beforePositions.map(p => p.clone());
    this.afterPositions = afterPositions.map(p => p.clone());
    this.onUpdate = onUpdate;
    this.description = description;
    this.bytes = (this.beforeQuats.length * 7) * 8;
  }

  execute() {
    this._apply(this.afterQuats, this.afterPositions);
  }

  undo() {
    this._apply(this.beforeQuats, this.beforePositions);
  }

  _apply(quats, positions) {
    const bones = this.skeleton?.bones || [];
    for (let i = 0; i < bones.length; i++) {
      if (quats[i]) bones[i].quaternion.copy(quats[i]);
      if (positions[i]) bones[i].position.copy(positions[i]);
      bones[i].updateMatrixWorld(true);
    }
    if (this.onUpdate) this.onUpdate(this.skeleton);
  }
}

/**
 * Undo/Redo command for Edit Bone Mode hierarchy/rest edits (add/extrude/delete/reparent/move).
 */
export class EditArmatureCommand {
  constructor(rigSystem, skeleton, beforeSnap, afterSnap, description = 'Edit Armature') {
    this.rigSystem = rigSystem;
    this.skeleton = skeleton;
    this.beforeSnap = beforeSnap;
    this.afterSnap = afterSnap;
    this.description = description;
    this.bytes = (beforeSnap?.bones?.length || 1) * 128;
  }

  execute() {
    this.rigSystem?._restoreArmatureSnapshot(this.skeleton, this.afterSnap);
  }

  undo() {
    this.rigSystem?._restoreArmatureSnapshot(this.skeleton, this.beforeSnap);
  }
}

/**
 * Undo/Redo command for Auto-Skin / Weight Transfer mesh replacement.
 */
export class AutoSkinCommand {
  constructor(rigSystem, oldMesh, newMesh, skeleton, description = 'Auto-Skin Mesh') {
    this.rigSystem = rigSystem;
    this.oldMesh = oldMesh;
    this.newMesh = newMesh;
    this.skeleton = skeleton;
    this.parent = oldMesh?.parent || newMesh?.parent || null;
    this.description = description;
    const count = newMesh?.geometry?.attributes?.position?.count || 0;
    this.bytes = count * 32;
  }

  execute() {
    this._swap(this.oldMesh, this.newMesh, this.newMesh);
  }

  undo() {
    this._swap(this.newMesh, this.oldMesh, this.oldMesh);
  }

  _swap(fromObj, toObj, activeTarget) {
    if (!fromObj || !toObj) return;
    const sm = this.rigSystem?._getSceneManager?.();
    const targetParent = fromObj.parent || this.parent;
    if (sm) {
      const fromKey = fromObj.userData?.id || fromObj.uuid;
      if (fromKey && sm.objects?.has(fromKey)) {
        sm.removeObject(fromObj, false, false);
      } else if (fromObj.parent) {
        fromObj.parent.remove(fromObj);
      }
      if (toObj.parent !== targetParent && targetParent) {
        targetParent.add(toObj);
      }
      sm.addObject(toObj, toObj.parent || targetParent || null, true, false);
      sm.select(toObj, false);
    } else if (targetParent) {
      if (fromObj.parent) fromObj.parent.remove(fromObj);
      if (toObj.parent !== targetParent) targetParent.add(toObj);
    }
    if (this.rigSystem) {
      this.rigSystem.activeCharacter = activeTarget;
      if (this.skeleton) {
        this.rigSystem.createSkeletonVisualizer(this.skeleton, activeTarget);
      }
    }
  }
}

export class RigSystem {
  constructor(options = {}) {
    this.THREE = options.THREE || THREE || (typeof window !== 'undefined' ? window.THREE : null);
    this.scene = options.scene || null;
    this.engine = options.engine || null;
    this.sceneManager = options.sceneManager || null;
    this.activeSkeleton = null;
    this.activeCharacter = null;
    this.activeBone = null;
    this.isPoseMode = false;
    this.skeletonHelper = null;
    this.jointHandlesGroup = null;
    this.boneDisplayMode = 'octahedral'; // 'octahedral' | 'stick' | 'hidden'
    this.customPoses = this._loadCustomPoses();

    // Edit Bone Mode State
    this.isEditBoneMode = false;
    this.editArmature = null;
    this.editSkeleton = null;
    this.editBoneRestTransforms = new Map();

    // Two-Bone IK & Constraints State
    this.isIKEnabled = false;
    this.pinFeetIK = true;
    this.constraintsEnabled = true;
    this._isSolvingIK = false;
    this._evaluatingConstraints = false;
    this.ikHandlesGroup = null;
    this.ikChains = new Map(); // chainName -> { upper, mid, end, targetHandle, poleHandle, guideLine, pinnedWorldQuat }
    this.chainBlends = new Map(); // chainKey -> 0..1 (1 = full IK, 0 = full FK)
    this.activeIKHandle = null;

    // Weight Paint State & Interactive Brush
    this.isWeightPaintMode = false;
    this.weightPaintMesh = null;
    this.weightBrush = {
      mode: 'add', // 'add' | 'subtract' | 'replace' | 'smooth'
      radius: 0.22,
      strength: 0.5,
      symmetryX: true,
    };
    this._isWeightBrushing = false;
    this._weightStrokeConsumed = false;
    this._weightCursor = null;
    this._weightMirrorCursor = null;
    this._weightAdjacencyCache = new WeakMap();
    this._weightRaycaster = new this.THREE.Raycaster();
    this._weightPointer = new this.THREE.Vector2();
    this._strokeStartSkinIndices = null;
    this._strokeStartSkinWeights = null;
    this._weightCanvasBound = null;
    this._onWeightPointerDownBound = (e) => this._handleWeightPointerDown(e);
    this._onWeightPointerMoveBound = (e) => this._handleWeightPointerMove(e);
    this._onWeightPointerUpBound = (e) => this._handleWeightPointerUp(e);
  }

  // =========================================================================
  // 1. STANDARD HUMANOID ARMATURE DEFINITIONS (Mixamo / glTF Standard)
  // =========================================================================

  /**
   * Generates a standard Humanoid Skeleton bone hierarchy with default bind pose
   */
  createHumanoidArmature(height = 1.8, options = {}) {
    const THREE = this.THREE;
    const scale = height / 1.8;

    const bones = [];
    const boneMap = new Map();

    const addBone = (name, parentName, relPos) => {
      const bone = new THREE.Bone();
      bone.name = name;
      bone.position.set(relPos.x * scale, relPos.y * scale, relPos.z * scale);

      if (parentName && boneMap.has(parentName)) {
        boneMap.get(parentName).add(bone);
      }
      bones.push(bone);
      boneMap.set(name, bone);
      return bone;
    };

    // Root Pelvis / Hips
    const hips = addBone('Hips', null, { x: 0, y: 0.98, z: 0 });

    // Spine & Head chain
    addBone('Spine', 'Hips', { x: 0, y: 0.16, z: 0 });
    addBone('Spine1', 'Spine', { x: 0, y: 0.18, z: 0 });
    addBone('Spine2', 'Spine1', { x: 0, y: 0.16, z: 0 }); // Chest
    addBone('Neck', 'Spine2', { x: 0, y: 0.12, z: 0 });
    addBone('Head', 'Neck', { x: 0, y: 0.14, z: 0.02 });

    // Left Arm chain (Character faces +Z, left side is +X)
    addBone('LeftShoulder', 'Spine2', { x: 0.09, y: 0.08, z: 0 });
    addBone('LeftArm', 'LeftShoulder', { x: 0.18, y: 0, z: 0 }); // UpperArm
    addBone('LeftForeArm', 'LeftArm', { x: 0.28, y: 0, z: 0 }); // Elbow
    addBone('LeftHand', 'LeftForeArm', { x: 0.26, y: 0, z: 0 }); // Wrist

    // Right Arm chain
    addBone('RightShoulder', 'Spine2', { x: -0.09, y: 0.08, z: 0 });
    addBone('RightArm', 'RightShoulder', { x: -0.18, y: 0, z: 0 });
    addBone('RightForeArm', 'RightArm', { x: -0.28, y: 0, z: 0 });
    addBone('RightHand', 'RightForeArm', { x: -0.26, y: 0, z: 0 });

    // Full 5-Finger Articulated Chains (Thumb, Index, Middle, Ring, Pinky) for Left & Right Hands
    ['Left', 'Right'].forEach((side) => {
      const s = side === 'Left' ? 1 : -1;
      const hand = `${side}Hand`;
      // Thumb (3 phalanges)
      addBone(`${hand}Thumb1`, hand, { x: s * 0.025, y: -0.012, z: 0.028 });
      addBone(`${hand}Thumb2`, `${hand}Thumb1`, { x: s * 0.028, y: -0.008, z: 0.018 });
      addBone(`${hand}Thumb3`, `${hand}Thumb2`, { x: s * 0.024, y: -0.006, z: 0.014 });
      // 4 Fingers (Index, Middle, Ring, Pinky)
      const fingerOffsetsZ = { Index: 0.028, Middle: 0.010, Ring: -0.008, Pinky: -0.025 };
      Object.entries(fingerOffsetsZ).forEach(([fName, zOff]) => {
        addBone(`${hand}${fName}1`, hand, { x: s * 0.075, y: 0, z: zOff });
        addBone(`${hand}${fName}2`, `${hand}${fName}1`, { x: s * 0.034, y: 0, z: 0 });
        addBone(`${hand}${fName}3`, `${hand}${fName}2`, { x: s * 0.026, y: 0, z: 0 });
      });
    });

    // Left Leg chain
    addBone('LeftUpLeg', 'Hips', { x: 0.12, y: -0.06, z: 0 }); // Thigh
    addBone('LeftLeg', 'LeftUpLeg', { x: 0, y: -0.44, z: 0 }); // Knee
    addBone('LeftFoot', 'LeftLeg', { x: 0, y: -0.42, z: 0 }); // Ankle
    addBone('LeftToeBase', 'LeftFoot', { x: 0, y: -0.06, z: 0.12 }); // Toe

    // Right Leg chain
    addBone('RightUpLeg', 'Hips', { x: -0.12, y: -0.06, z: 0 });
    addBone('RightLeg', 'RightUpLeg', { x: 0, y: -0.44, z: 0 });
    addBone('RightFoot', 'RightLeg', { x: 0, y: -0.42, z: 0 });
    addBone('RightToeBase', 'RightFoot', { x: 0, y: -0.06, z: 0.12 });

    // Record initial rest bind orientations
    bones.forEach((b) => {
      b.userData.restEuler = b.rotation.clone();
      b.userData.restQuat = b.quaternion.clone();
    });

    const skeleton = new THREE.Skeleton(bones);
    this.activeSkeleton = skeleton;

    const armatureGroup = new THREE.Group();
    armatureGroup.name = 'Humanoid_Armature';
    armatureGroup.add(hips);
    armatureGroup.userData.skeleton = skeleton;
    armatureGroup.userData.isArmature = true;

    if (options?.addToScene !== false) {
      const sm = this._getSceneManager();
      const targetScene = this.scene || (typeof window !== 'undefined' ? window.scene : null);
      if (sm && typeof sm.addObject === 'function') {
        sm.addObject(armatureGroup, options?.parent || null, false, false);
      } else if (targetScene && typeof targetScene.add === 'function') {
        targetScene.add(armatureGroup);
      }
    }

    // Attach SkeletonHelper & Joint Handles
    this.createSkeletonVisualizer(skeleton, armatureGroup);

    return { armatureGroup, skeleton, bones, boneMap };
  }

  /**
   * List all built-in multi-asset skeleton templates (humanoid, quadruped,
   * bird, fish, serpent, arachnid, vehicle).
   */
  listSkeletonTemplates(category = null) {
    return _listSkeletonTemplates(category);
  }

  /**
   * Create a standardized armature from any skeleton template ID
   * ('humanoid_standard', 'humanoid_pro', 'quadruped', 'bird', 'fish', 'serpent', 'arachnid', 'vehicle').
   */
  createSkeletonFromTemplate(templateId = 'humanoid_pro', options = {}) {
    const built = _buildSkeletonFromTemplate(templateId, options);
    const { armatureGroup, skeleton, bones, boneMap, template } = built;

    if (options?.position) {
      armatureGroup.position.set(
        Number(options.position.x) || 0,
        Number(options.position.y) || 0,
        Number(options.position.z) || 0,
      );
    }

    this.activeSkeleton = skeleton;
    if (options?.addToScene !== false) {
      const sm = this._getSceneManager();
      const targetScene = this.scene || (typeof window !== 'undefined' ? window.scene : null);
      if (sm && typeof sm.addObject === 'function') {
        sm.addObject(armatureGroup, options?.parent || null, false, false);
      } else if (targetScene && typeof targetScene.add === 'function') {
        targetScene.add(armatureGroup);
      }
    }

    armatureGroup.updateMatrixWorld(true);
    skeleton.calculateInverses();
    this.createSkeletonVisualizer(skeleton, armatureGroup);

    return { armatureGroup, skeleton, bones, boneMap, template };
  }

  /**
   * Automatically fit and bind a humanoid skeleton (56-bone Pro or 22-bone Standard)
   * onto any uploaded static 3D character Mesh or multi-mesh Group.
   * Uses vertex cross-section silhouette analysis to detect exact height, leg split,
   * shoulder span, and T-Pose vs A-Pose rest angle before solving Cotangent Bone Heat weights.
   */
  autoRigCharacter(target, options = {}) {
    const THREE = this.THREE;
    if (!target) return null;

    const templateId = options.templateId || 'humanoid_pro';
    const skinMode = options.mode || 'heat';
    const sm = this._getSceneManager();
    const scene = this.scene || (typeof window !== 'undefined' ? window.scene : null);

    target.updateMatrixWorld(true);

    // Collect all bindable static meshes (skip helper/gizmo/already-skinned unless forced)
    const meshes = [];
    if (target.isMesh && (!target.isSkinnedMesh || options.reRig)) {
      meshes.push(target);
    } else if (typeof target.traverse === 'function') {
      target.traverse((o) => {
        if (!o.isMesh) return;
        if (o.userData?.isSkeletonHelper || o.userData?.isJointHandle || o.userData?.isIKHandle) return;
        if (o.isSkinnedMesh && !options.reRig) return;
        if (o.geometry?.attributes?.position?.count >= 8) {
          meshes.push(o);
        }
      });
    }
    if (meshes.length === 0) return null;

    // 1. Fit skeleton precisely to the character's 3D silhouette (or template scaling for non-humanoid)
    const isHumanoid = templateId === 'humanoid_pro' || templateId === 'humanoid_standard';
    const built = isHumanoid
      ? _fitHumanoidSkeletonToMesh(target, { templateId, name: `${target.name || 'Character'}_Rig` })
      : _buildSkeletonFromTemplate(templateId, {
        size: new THREE.Box3().setFromObject(target).getSize(new THREE.Vector3()).y || undefined,
        name: `${target.name || 'Asset'}_Rig`,
      });

    const { armatureGroup, skeleton, bones, boneMap, silhouette } = built;

    // Attach armature root cleanly under a unified rigged Group if target was a single Mesh
    let rigRoot = target;
    if (target.isMesh) {
      const parent = target.parent;
      const wrapper = new THREE.Group();
      wrapper.name = `${target.name || 'Character'}_Rigged`;
      wrapper.userData.isSkinnedCharacter = true;
      wrapper.userData.skeleton = skeleton;
      wrapper.userData.skeletonTemplate = templateId;
      if (parent && !parent.isScene) {
        parent.add(wrapper);
      } else if (sm && typeof sm.addObject === 'function') {
        sm.addObject(wrapper, null, false, false);
      } else if (scene) {
        scene.add(wrapper);
      }
      wrapper.attach(target);
      wrapper.add(armatureGroup);
      rigRoot = wrapper;
    } else {
      target.add(armatureGroup);
      target.userData = target.userData || {};
      target.userData.isSkinnedCharacter = true;
      target.userData.skeleton = skeleton;
      target.userData.skeletonTemplate = templateId;
    }

    rigRoot.updateMatrixWorld(true);
    skeleton.calculateInverses();
    this.activeSkeleton = skeleton;
    this.activeCharacter = rigRoot;

    // 2. Skin every mesh in the hierarchy to the shared fitted skeleton
    const skinnedMeshes = [];
    const weightReports = [];
    for (const m of meshes) {
      const skinned = this.autoSkinMesh(m, skeleton, {
        mode: skinMode,
        recordUndo: false,
      });
      if (skinned) {
        skinnedMeshes.push(skinned);
        weightReports.push(validateSkinWeights(skinned.geometry, skeleton.bones.length));
      }
    }

    if (skinnedMeshes.length === 0) return null;

    rigRoot.updateMatrixWorld(true);
    skeleton.calculateInverses();
    if (options.showVisualizer !== false) {
      this.createSkeletonVisualizer(skeleton, rigRoot);
    }

    const totalVertices = weightReports.reduce((s, r) => s + r.vertexCount, 0);
    const unboundVertices = weightReports.reduce((s, r) => s + r.unboundCount, 0);
    const nanVertices = weightReports.reduce((s, r) => s + r.nanCount, 0);
    const maxSumDrift = Math.max(0, ...weightReports.map((r) => r.maxSumDrift));

    return {
      character: rigRoot,
      armatureGroup,
      skeleton,
      bones,
      boneMap,
      skinnedMeshes,
      silhouette: silhouette || _analyzeHumanoidMeshSilhouette(rigRoot),
      templateId,
      quality: {
        valid: unboundVertices === 0 && nanVertices === 0 && maxSumDrift < 0.02,
        meshCount: skinnedMeshes.length,
        boneCount: skeleton.bones.length,
        totalVertices,
        unboundVertices,
        nanVertices,
        maxSumDrift,
      },
    };
  }

  // =========================================================================
  // 1B. EDIT BONE MODE (Blender Edit Armature & Hierarchy Modifier)
  // =========================================================================

  _getSceneManager() {
    return this.sceneManager || (typeof window !== 'undefined' ? window.sceneManager : null);
  }

  _getEngine() {
    return this.engine || (typeof window !== 'undefined' ? window.engine : null);
  }

  _resolveSkeletonAndRoot(armature = null) {
    let target = armature || this.editArmature || this.activeCharacter || this._getSceneManager()?.getActiveObject?.();
    if (target && !target.isObject3D && !target.isSkeleton && target.armatureGroup?.isObject3D) {
      target = target.armatureGroup;
    }
    let skeleton = this.editSkeleton || this.activeSkeleton || null;
    if (target) {
      if (target.isSkeleton) {
        skeleton = target;
      } else if (target.userData?.skeleton) {
        skeleton = target.userData.skeleton;
      } else if (target.skeleton) {
        skeleton = target.skeleton;
      } else if (typeof target.traverse === 'function') {
        target.traverse((c) => {
          if (!skeleton && (c.skeleton || c.userData?.skeleton)) {
            skeleton = c.skeleton || c.userData.skeleton;
          }
        });
      }
    }
    let root = (target && target.isObject3D) ? target : null;
    if (!root && skeleton?.bones?.[0]) {
      let cur = skeleton.bones[0];
      while (cur.parent && !cur.parent.isScene) cur = cur.parent;
      root = cur;
    }
    return { skeleton, root };
  }

  _resolveBoneArg(skeleton, boneOrName) {
    if (!skeleton?.bones) return null;
    if (typeof boneOrName === 'number') return skeleton.bones[boneOrName] || null;
    if (typeof boneOrName === 'string') {
      const lower = boneOrName.toLowerCase();
      return skeleton.bones.find(b => b.name.toLowerCase() === lower)
        || skeleton.bones.find(b => RigSystem.cleanBoneName(b.name).toLowerCase() === lower)
        || null;
    }
    if (boneOrName?.isBone && skeleton.bones.includes(boneOrName)) return boneOrName;
    return null;
  }

  _findBoundSkinnedMeshes(skeleton) {
    const meshes = [];
    const scene = this.scene || (typeof window !== 'undefined' ? window.scene : null);
    if (scene && typeof scene.traverse === 'function') {
      scene.traverse((o) => {
        if (o.isSkinnedMesh && o.skeleton === skeleton && !meshes.includes(o)) {
          meshes.push(o);
        }
      });
    }
    if (this.weightPaintMesh?.isSkinnedMesh && this.weightPaintMesh.skeleton === skeleton && !meshes.includes(this.weightPaintMesh)) {
      meshes.push(this.weightPaintMesh);
    }
    if (this.activeCharacter?.isSkinnedMesh && this.activeCharacter.skeleton === skeleton && !meshes.includes(this.activeCharacter)) {
      meshes.push(this.activeCharacter);
    }
    return meshes;
  }

  _refreshVisualizerAndInverses(skeleton, armatureRoot = null) {
    if (!skeleton?.bones?.length) return;
    skeleton.bones.forEach((b) => {
      b.userData.restEuler = b.rotation.clone();
      b.userData.restQuat = b.quaternion.clone();
      b.userData.restCharQuat = null;
    });
    const top = armatureRoot || this._findCharacterRoot(skeleton.bones[0], skeleton.bones);
    if (top?.updateMatrixWorld) top.updateMatrixWorld(true);
    skeleton.calculateInverses();
    this.createSkeletonVisualizer(skeleton, top);
    this.updateSkeletonHelper();
    if (this.isIKEnabled) {
      this.setupTwoBoneIK(top);
    }
  }

  _snapshotArmature(skeleton) {
    if (!skeleton?.bones) return null;
    const boneSet = new Set(skeleton.bones);
    const meshes = this._findBoundSkinnedMeshes(skeleton).map((m) => ({
      mesh: m,
      skinIndex: m.geometry?.attributes?.skinIndex ? new Uint16Array(m.geometry.attributes.skinIndex.array) : null,
      skinWeight: m.geometry?.attributes?.skinWeight ? new Float32Array(m.geometry.attributes.skinWeight.array) : null,
    }));
    const rootParents = skeleton.bones.map((b) => {
      if (b.parent && !boneSet.has(b.parent)) return b.parent;
      return null;
    });
    return {
      bones: skeleton.bones.slice(),
      entries: skeleton.bones.map((b, idx) => ({
        bone: b,
        name: b.name,
        parent: b.parent && boneSet.has(b.parent) ? b.parent : null,
        externalParent: rootParents[idx],
        position: b.position.clone(),
        quaternion: b.quaternion.clone(),
        scale: b.scale.clone(),
        useConnect: Boolean(b.userData?.useConnect),
        tailLocal: Array.isArray(b.userData?.tailLocal) ? b.userData.tailLocal.slice(0, 3) : null,
      })),
      meshes,
    };
  }

  _restoreArmatureSnapshot(skeleton, snap) {
    if (!skeleton || !snap) return false;
    const THREE = this.THREE;
    // Detach all bones in snapshot + current skeleton first cleanly
    const allBones = new Set([...(skeleton.bones || []), ...(snap.bones || [])]);
    allBones.forEach((b) => {
      if (b.parent) b.parent.remove(b);
    });
    skeleton.bones.length = 0;
    for (const entry of snap.entries) {
      const b = entry.bone;
      b.name = entry.name;
      b.position.copy(entry.position);
      b.quaternion.copy(entry.quaternion);
      b.scale.copy(entry.scale);
      b.userData = b.userData || {};
      b.userData.useConnect = Boolean(entry.useConnect);
      if (Array.isArray(entry.tailLocal)) b.userData.tailLocal = entry.tailLocal.slice(0, 3);
      else delete b.userData.tailLocal;
      const targetParent = entry.parent || entry.externalParent;
      if (targetParent) targetParent.add(b);
      skeleton.bones.push(b);
    }
    skeleton.boneInverses = skeleton.bones.map(() => new THREE.Matrix4());
    for (const ms of snap.meshes || []) {
      const g = ms.mesh?.geometry;
      if (g?.attributes?.skinIndex && ms.skinIndex) {
        g.attributes.skinIndex.array.set(ms.skinIndex);
        g.attributes.skinIndex.needsUpdate = true;
      }
      if (g?.attributes?.skinWeight && ms.skinWeight) {
        g.attributes.skinWeight.array.set(ms.skinWeight);
        g.attributes.skinWeight.needsUpdate = true;
      }
    }
    this._refreshVisualizerAndInverses(skeleton, this.editArmature || this.activeCharacter);
    if (this.activeBone && !skeleton.bones.includes(this.activeBone)) {
      this.activeBone = skeleton.bones[0] || null;
    }
    if (this.activeBone && this.isEditBoneMode) {
      this.selectBone(this.activeBone);
    }
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('blender:edit-bone-updated', { detail: { bones: skeleton.bones } }));
    }
    return true;
  }

  _syncViewportModeUI(mode, emitEvent = true) {
    if (typeof document !== 'undefined') {
      const sel = document.getElementById('viewport-mode');
      const opt = sel?.querySelector(`option[value="${mode}"]`);
      if (sel && opt) {
        opt.hidden = false;
        sel.value = mode;
      }
      const modeIndicator = document.getElementById('mode-indicator-text');
      if (modeIndicator) {
        const labels = {
          'object': 'Object Mode',
          'edit-bone': 'Edit Bone',
          'weight-paint': 'Weight Paint',
          'pose': 'Pose Mode',
        };
        if (labels[mode]) modeIndicator.textContent = labels[mode];
      }
    }
    if (emitEvent && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('blender:mode-changed', {
        detail: { mode }
      }));
    }
  }

  /**
   * Enters Edit Bone mode for modifying skeleton bone rest positions & hierarchy
   * @param {THREE.Object3D} [armature]
   */
  enterEditBoneMode(armature = null) {
    const { skeleton, root } = this._resolveSkeletonAndRoot(armature);
    if (!skeleton) {
      console.warn('[RigSystem] enterEditBoneMode: No active skeleton found.');
      return false;
    }

    if (this.isWeightPaintMode) this.disableWeightPaintMode();
    if (this.isIKEnabled) this.setIKEnabled(false);
    if (typeof window !== 'undefined') {
      if (window.editMode?.isActive) window.editMode.exit();
      if (window.sculptMode?.isActive) window.sculptMode.exit();
      if (window.paintMode?.isActive) window.paintMode.exit();
    }

    this.isEditBoneMode = true;
    this.editArmature = root;
    this.editSkeleton = skeleton;
    this.activeSkeleton = skeleton;
    if (root) this.activeCharacter = root;

    this.editBoneRestTransforms = new Map();
    skeleton.bones.forEach((b) => {
      // Snap to rest pose during Edit Mode so proportions reflect bind pose
      if (b.userData?.restQuat) b.quaternion.copy(b.userData.restQuat);
      this.editBoneRestTransforms.set(b.name, {
        position: b.position.clone(),
        quaternion: b.quaternion.clone(),
        scale: b.scale.clone()
      });
    });

    this.createSkeletonVisualizer(skeleton, root);
    if (!this.activeBone || !skeleton.bones.includes(this.activeBone)) {
      this.activeBone = skeleton.bones[0] || null;
    }
    if (this.activeBone) {
      this.selectBone(this.activeBone);
    }

    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('blender:edit-bone-mode-changed', {
        detail: { active: true, bonesCount: skeleton.bones.length }
      }));
    }
    this._syncViewportModeUI('edit-bone');
    console.log(`[RigSystem] Entered Edit Bone Mode for armature (${skeleton.bones.length} bones).`);
    return true;
  }

  setEditBoneMode(enabled, armature = null) {
    return enabled ? this.enterEditBoneMode(armature) : this.exitEditBoneMode();
  }

  /**
   * Exits Edit Bone mode and recalculates skeleton bind pose & inverse matrices
   */
  exitEditBoneMode() {
    if (!this.isEditBoneMode) return false;

    const skel = this.editSkeleton || this.activeSkeleton;
    const arm = this.editArmature || this.activeCharacter;
    this.isEditBoneMode = false;

    if (skel) {
      this._refreshVisualizerAndInverses(skel, arm);
      if (this.activeBone && this.isPoseMode) {
        this.selectBone(this.activeBone);
      } else {
        const engine = this._getEngine();
        if (engine?.transformControls && arm && engine.transformControls.object?.isBone) {
          engine.transformControls.detach();
        }
      }
    }

    this.editArmature = null;
    this.editSkeleton = null;
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('blender:edit-bone-mode-changed', {
        detail: { active: false }
      }));
    }
    const nextMode = this.isWeightPaintMode ? 'weight-paint' : (this.isPoseMode ? 'pose' : 'object');
    this._syncViewportModeUI(nextMode);
    if (nextMode === 'object') {
      const eng = this._getEngine();
      eng?.updateActiveGizmo?.(eng.sceneManager?.getActiveObject?.() || arm);
    }
    console.log('[RigSystem] Exited Edit Bone Mode. Updated bind pose & inverses.');
    return true;
  }

  /**
   * Adds a new bone to the skeleton hierarchy in Edit Bone Mode
   * @param {string|THREE.Bone} parent - Parent bone or name
   * @param {string} name - New bone name
   * @param {THREE.Vector3|number[]} [headPos] - Position offset relative to parent
   * @param {THREE.Vector3|number[]} [tailPos] - Tail position
   * @param {{ recordUndo?: boolean }} [options]
   * @returns {THREE.Bone|null}
   */
  addBone(parent, name, headPos = null, tailPos = null, options = {}) {
    const THREE = this.THREE;
    const skeleton = this.editSkeleton || this.activeSkeleton;
    if (!skeleton) {
      console.warn('[RigSystem] addBone: No active skeleton found.');
      return null;
    }

    let parentBone = null;
    if (typeof parent === 'string') {
      parentBone = skeleton.bones.find(b => b.name.toLowerCase() === parent.toLowerCase());
    } else if (parent && parent.isBone) {
      parentBone = parent;
    } else {
      parentBone = skeleton.bones[0];
    }

    if (!parentBone) {
      console.warn(`[RigSystem] addBone: Parent bone "${parent}" not found.`);
      return null;
    }

    const beforeSnap = options.recordUndo !== false ? this._snapshotArmature(skeleton) : null;

    const newBone = new THREE.Bone();
    newBone.name = name || `Bone_${skeleton.bones.length}`;

    if (headPos) {
      if (Array.isArray(headPos)) newBone.position.set(headPos[0], headPos[1], headPos[2]);
      else newBone.position.copy(headPos);
    } else {
      newBone.position.set(0, 0.15, 0);
    }

    parentBone.add(newBone);
    skeleton.bones.push(newBone);
    skeleton.boneInverses.push(new THREE.Matrix4());
    this._refreshVisualizerAndInverses(skeleton, this.editArmature || this.activeCharacter);

    if (tailPos && newBone.userData) {
      newBone.userData.tailOffset = Array.isArray(tailPos)
        ? new THREE.Vector3(tailPos[0], tailPos[1], tailPos[2])
        : tailPos.clone();
    }

    const sm = this._getSceneManager();
    if (beforeSnap && sm?.executeCommand) {
      const afterSnap = this._snapshotArmature(skeleton);
      sm.executeCommand(new EditArmatureCommand(this, skeleton, beforeSnap, afterSnap, `Add Bone ${newBone.name}`));
    }
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('blender:edit-bone-updated', { detail: { bones: skeleton.bones, bone: newBone } }));
    }

    console.log(`[RigSystem] Added bone "${newBone.name}" to parent "${parentBone.name}" (Total bones: ${skeleton.bones.length})`);
    return newBone;
  }

  /**
   * Extrudes a child bone from baseBone along its chain direction (Blender 'E' in Edit Armature).
   */
  extrudeBone(baseBoneOrName = null, offset = null, newName = null, options = {}) {
    const THREE = this.THREE;
    const skeleton = this.editSkeleton || this.activeSkeleton;
    if (!skeleton?.bones?.length) return null;

    const baseBone = this._resolveBoneArg(skeleton, baseBoneOrName || this.activeBone) || skeleton.bones[0];
    let localOffset;
    if (offset) {
      localOffset = Array.isArray(offset) ? new THREE.Vector3(offset[0], offset[1], offset[2]) : offset.clone();
    } else if (baseBone.position.lengthSq() > 1e-4 && baseBone.parent?.isBone) {
      localOffset = baseBone.position.clone().normalize().multiplyScalar(Math.max(0.12, Math.min(0.30, baseBone.position.length() * 0.85)));
    } else {
      localOffset = new THREE.Vector3(0, 0.16, 0);
    }

    let candidate = newName || `${baseBone.name}_Tip`;
    let suffix = 1;
    while (skeleton.bones.some(b => b.name === candidate)) {
      candidate = `${newName || baseBone.name}_Tip_${suffix++}`;
    }

    const created = this.addBone(baseBone, candidate, localOffset, null, options);
    if (created) {
      created.userData = created.userData || {};
      created.userData.useConnect = options.connect !== false;
      baseBone.userData = baseBone.userData || {};
      baseBone.userData.tailLocal = [created.position.x, created.position.y, created.position.z];
      this.selectBone(created);
    }
    return created;
  }

  /**
   * Deletes a bone in Edit Mode, safely re-parenting children & remapping skinIndex weights.
   */
  deleteBone(boneOrName = null, options = {}) {
    const THREE = this.THREE;
    const skeleton = this.editSkeleton || this.activeSkeleton;
    if (!skeleton?.bones || skeleton.bones.length <= 1) return false;

    const target = this._resolveBoneArg(skeleton, boneOrName || this.activeBone);
    if (!target) return false;
    const delIdx = skeleton.bones.indexOf(target);
    if (delIdx === -1) return false;

    const parent = target.parent;
    if (!parent) return false;

    const beforeSnap = options.recordUndo !== false ? this._snapshotArmature(skeleton) : null;

    // Preserve world transforms when re-parenting direct child bones
    const childBones = target.children.filter(c => c.isBone);
    const fallbackIdx = parent.isBone ? skeleton.bones.indexOf(parent) : (delIdx === 0 ? 1 : 0);

    for (const cb of childBones) {
      if (typeof parent.attach === 'function') parent.attach(cb);
      else {
        target.remove(cb);
        parent.add(cb);
      }
    }

    parent.remove(target);
    skeleton.bones.splice(delIdx, 1);
    skeleton.boneInverses = skeleton.bones.map(() => new THREE.Matrix4());

    // Remap skinIndex references on any bound SkinnedMesh so indices never dangle
    const newFallbackIdx = fallbackIdx > delIdx ? fallbackIdx - 1 : Math.max(0, fallbackIdx);
    for (const smMesh of this._findBoundSkinnedMeshes(skeleton)) {
      const idxAttr = smMesh.geometry?.attributes?.skinIndex;
      if (!idxAttr) continue;
      for (let i = 0; i < idxAttr.count; i++) {
        for (let slot = 0; slot < 4; slot++) {
          const val = idxAttr.getComponent(i, slot);
          if (val === delIdx) idxAttr.setComponent(i, slot, newFallbackIdx);
          else if (val > delIdx) idxAttr.setComponent(i, slot, val - 1);
        }
      }
      idxAttr.needsUpdate = true;
    }

    this._refreshVisualizerAndInverses(skeleton, this.editArmature || this.activeCharacter);
    if (this.activeBone === target || !skeleton.bones.includes(this.activeBone)) {
      this.activeBone = (parent.isBone ? parent : skeleton.bones[0]) || null;
    }
    if (this.activeBone) this.selectBone(this.activeBone);

    const sm = this._getSceneManager();
    if (beforeSnap && sm?.executeCommand) {
      const afterSnap = this._snapshotArmature(skeleton);
      sm.executeCommand(new EditArmatureCommand(this, skeleton, beforeSnap, afterSnap, `Delete Bone ${target.name}`));
    }
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('blender:edit-bone-updated', { detail: { bones: skeleton.bones } }));
    }
    return true;
  }

  /**
   * Re-parents a bone cleanly with cycle prevention and optional world-position preservation.
   * Pass newParentOrName = null to re-parent to the Armature root object.
   */
  reparentBone(childOrName, newParentOrName, options = {}) {
    const skeleton = this.editSkeleton || this.activeSkeleton;
    if (!skeleton?.bones) return false;
    const child = this._resolveBoneArg(skeleton, childOrName);
    if (!child) return false;

    let newParent = null;
    if (newParentOrName === null || newParentOrName === '') {
      const top = this.editArmature || this._findCharacterRoot(skeleton.bones[0], skeleton.bones);
      newParent = (top && top !== child) ? top : skeleton.bones[0]?.parent;
      while (newParent?.isBone && newParent.parent && !newParent.parent.isScene) {
        newParent = newParent.parent;
      }
    } else {
      newParent = this._resolveBoneArg(skeleton, newParentOrName);
    }
    if (!newParent || child === newParent) return false;

    // Cycle check: newParent cannot be a descendant of child
    let walk = newParent;
    while (walk) {
      if (walk === child) return false;
      walk = walk.parent;
    }

    const beforeSnap = options.recordUndo !== false ? this._snapshotArmature(skeleton) : null;
    const preserveWorld = options.preserveWorld !== false;
    if (preserveWorld && typeof newParent.attach === 'function') {
      newParent.attach(child);
    } else {
      if (child.parent) child.parent.remove(child);
      newParent.add(child);
    }

    this._refreshVisualizerAndInverses(skeleton, this.editArmature || this.activeCharacter);
    const sm = this._getSceneManager();
    if (beforeSnap && sm?.executeCommand) {
      const afterSnap = this._snapshotArmature(skeleton);
      sm.executeCommand(new EditArmatureCommand(this, skeleton, beforeSnap, afterSnap, `Reparent ${child.name} -> ${newParent.name || 'Root'}`));
    }
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('blender:edit-bone-updated', { detail: { bones: skeleton.bones, bone: child } }));
    }
    return true;
  }

  /**
   * Renames a bone uniquely within the active skeleton.
   */
  renameBone(boneOrName, newName) {
    const clean = String(newName || '').trim();
    const skeleton = this.editSkeleton || this.activeSkeleton;
    if (!clean || !skeleton?.bones) return false;
    const bone = this._resolveBoneArg(skeleton, boneOrName || this.activeBone);
    if (!bone) return false;
    if (skeleton.bones.some(b => b !== bone && b.name === clean)) return false;
    const prevName = bone.name;
    bone.name = clean;
    const storageRoot = this._resolveArmatureStorageRoot(this.editArmature || this.activeCharacter || skeleton);
    if (Array.isArray(storageRoot?.userData?.boneCollections)) {
      for (const col of storageRoot.userData.boneCollections) {
        if (Array.isArray(col.bones)) {
          col.bones = col.bones.map((bn) => (bn === prevName ? clean : bn));
        }
      }
    }
    this.createSkeletonVisualizer(skeleton, this.editArmature || this.activeCharacter);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('blender:edit-bone-updated', { detail: { bones: skeleton.bones, bone } }));
    }
    return true;
  }

  /**
   * Mirrors Left <-> Right edited bone positions across X = 0 (supports Mixamo, UE5 _l/_r, .L/.R, VRM).
   */
  symmetrizeBones(direction = 'left_to_right', options = {}) {
    const skeleton = this.editSkeleton || this.activeSkeleton;
    if (!skeleton?.bones) return 0;
    const rig = this._prepareRig(this.editArmature || this.activeCharacter || skeleton);
    if (!rig) return 0;

    const beforeSnap = options.recordUndo !== false ? this._snapshotArmature(skeleton) : null;
    const wantLeftSource = direction !== 'right_to_left';

    let mirrored = 0;
    skeleton.bones.forEach((src, srcIdx) => {
      const side = RigSystem.detectBoneSide(src.name);
      if ((wantLeftSource && side !== 1) || (!wantLeftSource && side !== -1)) return;
      const dstIdx = this._findMirrorBoneIndex(skeleton, srcIdx);
      const dst = dstIdx !== srcIdx ? skeleton.bones[dstIdx] : null;
      if (!dst || dst === src) return;
      dst.position.set(-src.position.x, src.position.y, src.position.z);
      dst.quaternion.set(src.quaternion.x, -src.quaternion.y, -src.quaternion.z, src.quaternion.w).normalize();
      mirrored++;
    });

    if (mirrored > 0) {
      this._refreshVisualizerAndInverses(skeleton, rig.root);
      const sm = this._getSceneManager();
      if (beforeSnap && sm?.executeCommand) {
        const afterSnap = this._snapshotArmature(skeleton);
        sm.executeCommand(new EditArmatureCommand(this, skeleton, beforeSnap, afterSnap, 'Symmetrize Bones X'));
      }
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('blender:edit-bone-updated', { detail: { bones: skeleton.bones } }));
      }
    }
    return mirrored;
  }

  /**
   * Rotates a bone's local roll around its main chain axis without displacing its child bone tip.
   */
  setBoneRoll(boneOrName, rollRad = 0, options = {}) {
    const THREE = this.THREE;
    const skeleton = this.editSkeleton || this.activeSkeleton;
    if (!skeleton?.bones) return false;
    const bone = this._resolveBoneArg(skeleton, boneOrName || this.activeBone);
    if (!bone) return false;

    const beforeSnap = options.recordUndo !== false ? this._snapshotArmature(skeleton) : null;
    const childBone = bone.children.find(c => c.isBone);
    const localAxis = (childBone && childBone.position.lengthSq() > 1e-6)
      ? childBone.position.clone().normalize()
      : new THREE.Vector3(0, 1, 0);

    const prevRoll = Number(bone.userData.boneRollRad) || 0;
    const deltaAngle = Number(rollRad) - prevRoll;
    if (Math.abs(deltaAngle) < 1e-6) return true;

    const qRoll = new THREE.Quaternion().setFromAxisAngle(localAxis, deltaAngle);
    const qInv = qRoll.clone().invert();
    bone.quaternion.multiply(qRoll).normalize();
    bone.children.forEach((c) => {
      if (c.isBone) {
        c.position.applyQuaternion(qInv);
        c.quaternion.premultiply(qInv).normalize();
      }
    });
    bone.userData.boneRollRad = Number(rollRad);

    this._refreshVisualizerAndInverses(skeleton, this.editArmature || this.activeCharacter);
    const sm = this._getSceneManager();
    if (beforeSnap && sm?.executeCommand) {
      const afterSnap = this._snapshotArmature(skeleton);
      sm.executeCommand(new EditArmatureCommand(this, skeleton, beforeSnap, afterSnap, `Bone Roll ${bone.name}`));
    }
    return true;
  }

  /**
   * Aligns bone rest axes cleanly along parent-to-child chain with deterministic +Z/+Y pole roll.
   */
  recalculateBoneRoll(armatureOrSkeleton = null, options = {}) {
    const THREE = this.THREE;
    const { skeleton, root } = this._resolveSkeletonAndRoot(armatureOrSkeleton);
    if (!skeleton?.bones?.length) return 0;

    const beforeSnap = options.recordUndo !== false ? this._snapshotArmature(skeleton) : null;
    const targetUpWorld = new THREE.Vector3(0, 0, 1);
    let updated = 0;

    skeleton.bones.forEach((bone) => {
      const childBone = bone.children.find(c => c.isBone);
      if (!childBone || childBone.position.lengthSq() < 1e-5) return;
      bone.updateMatrixWorld(true);
      const axisLocal = childBone.position.clone().normalize();
      const bWorldQ = bone.getWorldQuaternion(new THREE.Quaternion());
      const axisWorld = axisLocal.clone().applyQuaternion(bWorldQ).normalize();
      // Desired perpendicular forward reference projected orthogonal to bone axis
      const refHint = Math.abs(axisWorld.dot(targetUpWorld)) > 0.92
        ? new THREE.Vector3(0, 1, 0)
        : targetUpWorld;
      const desiredForward = refHint.clone().addScaledVector(axisWorld, -refHint.dot(axisWorld)).normalize();
      // Current bone local +Z in world projected orthogonal to axisWorld
      const curFwd = new THREE.Vector3(0, 0, 1).applyQuaternion(bWorldQ);
      const curProj = curFwd.clone().addScaledVector(axisWorld, -curFwd.dot(axisWorld));
      if (curProj.lengthSq() < 1e-5) return;
      curProj.normalize();
      const dot = Math.max(-1, Math.min(1, curProj.dot(desiredForward)));
      const cross = new THREE.Vector3().crossVectors(curProj, desiredForward);
      const signedAngle = Math.atan2(cross.dot(axisWorld), dot);
      if (Math.abs(signedAngle) > 1e-4) {
        const qRoll = new THREE.Quaternion().setFromAxisAngle(axisLocal, signedAngle);
        const qInv = qRoll.clone().invert();
        bone.quaternion.multiply(qRoll).normalize();
        bone.children.forEach((c) => {
          if (c.isBone) {
            c.position.applyQuaternion(qInv);
            c.quaternion.premultiply(qInv).normalize();
          }
        });
        bone.userData.boneRollRad = (Number(bone.userData.boneRollRad) || 0) + signedAngle;
        updated++;
      }
    });

    if (updated > 0) {
      this._refreshVisualizerAndInverses(skeleton, root);
      const sm = this._getSceneManager();
      if (beforeSnap && sm?.executeCommand) {
        const afterSnap = this._snapshotArmature(skeleton);
        sm.executeCommand(new EditArmatureCommand(this, skeleton, beforeSnap, afterSnap, 'Recalculate Bone Roll'));
      }
    }
    return updated;
  }

  // =========================================================================
  // 1C. CONNECTED BONES (use_connect) & BONE COLLECTIONS
  // =========================================================================

  _resolveArmatureStorageRoot(armatureOrSkeleton = null) {
    const target = armatureOrSkeleton || this.editArmature || this.activeCharacter || this._getSceneManager()?.getActiveObject?.();
    if (target?.isBone && typeof target.traverseAncestors === 'function') {
      let arm = null;
      let top = target;
      target.traverseAncestors((a) => {
        if (a && !a.isScene) {
          top = a;
          if (!arm && (a.userData?.isArmature || a.userData?.skeleton || a.userData?.boneCollections)) {
            arm = a;
          }
        }
      });
      if (arm || top) return arm || top;
    }
    const { skeleton, root } = this._resolveSkeletonAndRoot(armatureOrSkeleton);
    const firstBone = skeleton?.bones?.[0];
    if (firstBone) {
      let cur = firstBone.parent;
      while (cur && cur.isBone) cur = cur.parent;
      if (cur && !cur.isScene && cur.userData) return cur;
      if (!root?.userData && firstBone.userData) return firstBone;
    }
    if (root?.userData) return root;
    return skeleton || root || null;
  }

  getBoneConnected(boneOrName) {
    const skeleton = this.editSkeleton || this.activeSkeleton;
    const bone = boneOrName?.isBone ? boneOrName : this._resolveBoneArg(skeleton, boneOrName || this.activeBone);
    return Boolean(bone?.userData?.useConnect);
  }

  setBoneConnected(boneOrName, connected = true, options = {}) {
    const THREE = this.THREE;
    const skeleton = this.editSkeleton || this.activeSkeleton;
    const bone = boneOrName?.isBone ? boneOrName : this._resolveBoneArg(skeleton, boneOrName || this.activeBone);
    if (!bone) return false;

    const next = Boolean(connected);
    const beforeSnap = (options.recordUndo !== false && skeleton) ? this._snapshotArmature(skeleton) : null;
    bone.userData = bone.userData || {};
    bone.userData.useConnect = next;

    if (next && bone.parent?.isBone) {
      const p = bone.parent;
      p.userData = p.userData || {};
      let targetTail = null;
      if (Array.isArray(p.userData.tailLocal) && p.userData.tailLocal.length >= 3) {
        targetTail = new THREE.Vector3(p.userData.tailLocal[0], p.userData.tailLocal[1], p.userData.tailLocal[2]);
      } else {
        const sibling = p.children.find((c) => c.isBone && c !== bone);
        if (sibling) targetTail = sibling.position.clone();
      }
      if (targetTail && options.snap !== false) {
        bone.position.copy(targetTail);
      } else {
        p.userData.tailLocal = [bone.position.x, bone.position.y, bone.position.z];
      }
    }

    if (skeleton) {
      const top = this.editArmature || this.activeCharacter || this._findCharacterRoot(skeleton.bones[0], skeleton.bones);
      if (top?.updateMatrixWorld) top.updateMatrixWorld(true);
      if (typeof skeleton.calculateInverses === 'function') skeleton.calculateInverses();
      this.createSkeletonVisualizer(skeleton, top);
      this.updateSkeletonHelper();
      const sm = this._getSceneManager();
      if (beforeSnap && sm?.executeCommand) {
        const afterSnap = this._snapshotArmature(skeleton);
        sm.executeCommand(new EditArmatureCommand(this, skeleton, beforeSnap, afterSnap, `${next ? 'Connect' : 'Disconnect'} ${bone.name}`));
      }
    }
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('blender:edit-bone-updated', { detail: { bones: skeleton?.bones || [], bone } }));
    }
    return true;
  }

  _ensureBoneCollections(armature = null) {
    const storage = this._resolveArmatureStorageRoot(armature);
    if (!storage) return { storage: null, list: [] };
    storage.userData = storage.userData || {};
    if (!Array.isArray(storage.userData.boneCollections)) {
      storage.userData.boneCollections = [];
    }
    return { storage, list: storage.userData.boneCollections };
  }

  _applyBoneCollectionVisibility(armature = null) {
    const { skeleton } = this._resolveSkeletonAndRoot(armature);
    if (!skeleton?.bones) return;
    const { list } = this._ensureBoneCollections(armature);

    const boneColStates = new Map();
    for (const col of list) {
      for (const bn of col.bones || []) {
        if (!boneColStates.has(bn)) boneColStates.set(bn, []);
        boneColStates.get(bn).push(col.visible !== false);
      }
    }

    skeleton.bones.forEach((b) => {
      b.userData = b.userData || {};
      const visFlags = boneColStates.get(b.name);
      const hidden = Array.isArray(visFlags) && visFlags.length > 0 ? !visFlags.some(Boolean) : false;
      b.userData.hiddenByCollection = hidden;
      b.children.forEach((c) => {
        if (c.userData?.isBoneJoint) c.visible = !hidden && this.boneDisplayMode !== 'hidden';
        else if (c.userData?.isBoneHitProxy) c.visible = !hidden && this.boneDisplayMode === 'octahedral';
      });
    });
  }

  getBoneCollections(armature = null) {
    const { list } = this._ensureBoneCollections(armature);
    return list;
  }

  createBoneCollection(name, armature = null, boneNames = []) {
    const clean = String(name || '').trim() || 'Collection';
    const { list } = this._ensureBoneCollections(armature);
    let unique = clean;
    let suffix = 1;
    while (list.some((c) => c.name === unique)) {
      unique = `${clean}.${String(suffix++).padStart(3, '0')}`;
    }
    const { skeleton } = this._resolveSkeletonAndRoot(armature);
    const bones = [];
    for (const bArg of boneNames || []) {
      const b = this._resolveBoneArg(skeleton, bArg);
      const bName = b ? b.name : (typeof bArg === 'string' ? bArg : null);
      if (bName && !bones.includes(bName)) bones.push(bName);
    }
    const entry = { name: unique, visible: true, bones };
    list.push(entry);
    this._applyBoneCollectionVisibility(armature);
    return entry;
  }

  deleteBoneCollection(nameOrIndex, armature = null) {
    const { list } = this._ensureBoneCollections(armature);
    const idx = typeof nameOrIndex === 'number'
      ? (nameOrIndex >= 0 && nameOrIndex < list.length ? nameOrIndex : -1)
      : list.findIndex((c) => c.name === nameOrIndex);
    if (idx === -1) return false;
    list.splice(idx, 1);
    this._applyBoneCollectionVisibility(armature);
    return true;
  }

  assignBoneToCollection(boneOrName, collectionName, armature = null) {
    const { skeleton } = this._resolveSkeletonAndRoot(armature);
    const bone = boneOrName?.isBone ? boneOrName : this._resolveBoneArg(skeleton, boneOrName || this.activeBone);
    const boneName = bone ? bone.name : (typeof boneOrName === 'string' ? boneOrName : null);
    if (!boneName) return false;
    const { list } = this._ensureBoneCollections(armature);
    let col = list.find((c) => c.name === collectionName);
    if (!col) col = this.createBoneCollection(collectionName, armature);
    if (!col.bones.includes(boneName)) col.bones.push(boneName);
    this._applyBoneCollectionVisibility(armature);
    return true;
  }

  removeBoneFromCollection(boneOrName, collectionName, armature = null) {
    const { skeleton } = this._resolveSkeletonAndRoot(armature);
    const bone = boneOrName?.isBone ? boneOrName : this._resolveBoneArg(skeleton, boneOrName || this.activeBone);
    const boneName = bone ? bone.name : (typeof boneOrName === 'string' ? boneOrName : null);
    if (!boneName) return false;
    const { list } = this._ensureBoneCollections(armature);
    const col = list.find((c) => c.name === collectionName);
    if (!col) return false;
    const idx = col.bones.indexOf(boneName);
    if (idx === -1) return false;
    col.bones.splice(idx, 1);
    this._applyBoneCollectionVisibility(armature);
    return true;
  }

  setBoneCollectionVisibility(collectionName, visible, armature = null) {
    const { list } = this._ensureBoneCollections(armature);
    const col = list.find((c) => c.name === collectionName);
    if (!col) return false;
    col.visible = Boolean(visible);
    this._applyBoneCollectionVisibility(armature);
    return true;
  }

  selectBoneCollection(collectionName, armature = null) {
    const { skeleton } = this._resolveSkeletonAndRoot(armature);
    const { list } = this._ensureBoneCollections(armature);
    const col = list.find((c) => c.name === collectionName);
    if (!col || !skeleton?.bones) return [];
    const matched = col.bones
      .map((bn) => this._resolveBoneArg(skeleton, bn))
      .filter((b) => Boolean(b) && !b.userData?.hiddenByCollection);
    if (matched.length > 0) this.selectBone(matched[0]);
    return matched;
  }

  onEditBoneMoved(bone) {
    const skeleton = this.editSkeleton || this.activeSkeleton;
    if (!skeleton || !bone) return;
    if (bone.userData?.useConnect && bone.parent?.isBone) {
      bone.parent.userData = bone.parent.userData || {};
      bone.parent.userData.tailLocal = [bone.position.x, bone.position.y, bone.position.z];
      bone.parent.children.forEach((sib) => {
        if (sib.isBone && sib !== bone && sib.userData?.useConnect) {
          sib.position.copy(bone.position);
        }
      });
    }
    skeleton.bones.forEach((b) => {
      b.userData.restEuler = b.rotation.clone();
      b.userData.restQuat = b.quaternion.clone();
      b.userData.restCharQuat = null;
    });
    const top = this.editArmature || this.activeCharacter || this._findCharacterRoot(skeleton.bones[0], skeleton.bones);
    if (top?.updateMatrixWorld) top.updateMatrixWorld(true);
    skeleton.calculateInverses();
    this.updateSkeletonHelper();
    // Rebuild octahedral hit proxies on moved bone and its parent without detaching gizmo
    const toRebuild = [bone, bone.parent?.isBone ? bone.parent : null].filter(Boolean);
    const avgLen = this._computeMedianBoneLength(skeleton);
    toRebuild.forEach((b) => {
      [...b.children].forEach((c) => {
        if (c.userData?.isBoneHitProxy) b.remove(c);
      });
      const childBone = b.children.find(c => c.isBone);
      if (childBone) {
        const boneLength = childBone.position.length();
        if (boneLength > 1e-3) {
          const octa = this._createOctahedralBoneMesh(boneLength, childBone.position, avgLen);
          octa.name = `Octa_${b.name}`;
          octa.userData.isBoneHitProxy = true;
          octa.userData.isSystemObject = true;
          octa.userData.isHelper = true;
          octa.userData.selectable = false;
          octa.userData.targetBone = b;
          octa.visible = this.boneDisplayMode === 'octahedral';
          octa.renderOrder = 997;
          b.add(octa);
        }
      }
    });
  }

  _computeMedianBoneLength(skeleton) {
    const lens = [];
    for (const b of skeleton?.bones || []) {
      const childBone = b.children.find(c => c.isBone);
      if (childBone) {
        const l = childBone.position.length();
        if (l > 1e-4) lens.push(l);
      }
    }
    if (lens.length === 0) return 0.25;
    lens.sort((a, b) => a - b);
    return lens[Math.floor(lens.length / 2)];
  }

  // =========================================================================
  // 2. BONE VISUALIZER & INTERACTIVE POSE MODE SELECTION
  // =========================================================================

  /**
   * Controls bone display style: 'octahedral' | 'stick' | 'hidden'.
   */
  setBoneDisplayMode(mode = 'octahedral') {
    const next = ['octahedral', 'stick', 'hidden'].includes(mode) ? mode : 'octahedral';
    this.boneDisplayMode = next;
    if (this.skeletonHelper) {
      this.skeletonHelper.visible = next !== 'hidden';
    }
    const skel = this.editSkeleton || this.activeSkeleton;
    if (skel?.bones) {
      skel.bones.forEach((b) => {
        const hidden = Boolean(b.userData?.hiddenByCollection);
        b.children.forEach((c) => {
          if (c.userData?.isBoneJoint) c.visible = !hidden && next !== 'hidden';
          else if (c.userData?.isBoneHitProxy) c.visible = !hidden && next === 'octahedral';
        });
      });
    }
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('blender:bone-display-changed', { detail: { mode: next } }));
    }
    return next;
  }

  /**
   * Builds accurate SkeletonHelper lines, interactive Joint spheres, and
   * iconic Blender Octahedral Bone meshes (marked as system helpers so Outliner & GLB export stay clean).
   */
  createSkeletonVisualizer(skeleton, rootObject = null) {
    const THREE = this.THREE;
    const scene = this.scene || (typeof window !== 'undefined' ? window.scene : null);

    // Remove and dispose old helper if present
    if (this.skeletonHelper) {
      if (this.skeletonHelper.parent) {
        this.skeletonHelper.parent.remove(this.skeletonHelper);
      }
      this.skeletonHelper.geometry?.dispose?.();
      if (Array.isArray(this.skeletonHelper.material)) {
        this.skeletonHelper.material.forEach((m) => m?.dispose?.());
      } else {
        this.skeletonHelper.material?.dispose?.();
      }
      this.skeletonHelper = null;
    }

    const candidate = (rootObject?.armatureGroup?.isObject3D ? rootObject.armatureGroup : rootObject)
      || skeleton?.bones?.[0]
      || this.activeCharacter;
    const target = candidate?.isObject3D ? candidate : (skeleton?.bones?.[0] || null);
    if (!target) return null;

    // 1. Native Three.js SkeletonHelper
    const helper = new THREE.SkeletonHelper(target);
    helper.material.linewidth = 2;
    helper.material.depthTest = false; // X-Ray mode (In Front)
    helper.material.transparent = true;
    helper.material.opacity = 0.85;
    helper.renderOrder = 998;
    helper.name = 'Skeleton_Helper_Lines';
    helper.userData.isSystemObject = true;
    helper.userData.isHelper = true;
    helper.userData.isSkeletonHelper = true;
    helper.userData.targetRoot = target;
    helper.userData.selectable = false;
    helper.visible = this.boneDisplayMode !== 'hidden';

    if (scene) {
      scene.add(helper);
    }
    this.skeletonHelper = helper;

    // Adaptive joint & octahedron sizing handles both 1.8m mannequins and 100cm Mixamo rigs
    const medianLen = this._computeMedianBoneLength(skeleton);
    const jointRadius = Math.max(0.015, Math.min(medianLen * 0.16, medianLen * 0.22));
    const jointGeom = new THREE.SphereGeometry(jointRadius, 14, 10);
    const jointMat = new THREE.MeshBasicMaterial({
      color: this.isEditBoneMode ? 0x2ecc71 : 0xf39c12,
      depthTest: false,
      transparent: true,
      opacity: 0.95
    });

    skeleton.bones.forEach((bone) => {
      // Safe child removal (does not corrupt parent back-references)
      const prevProxies = bone.children.filter(c => c.userData?.isBoneJoint || c.userData?.isBoneHitProxy);
      prevProxies.forEach(c => bone.remove(c));

      // 2. Clickable joint sphere (hidden from Outliner & GLB/FBX export via isSystemObject)
      const jointMesh = new THREE.Mesh(jointGeom, jointMat.clone());
      jointMesh.name = `Joint_${bone.name}`;
      jointMesh.userData.isBoneJoint = true;
      jointMesh.userData.isSystemObject = true;
      jointMesh.userData.isHelper = true;
      jointMesh.userData.selectable = false;
      jointMesh.userData.targetBone = bone;
      const hiddenByCol = Boolean(bone.userData?.hiddenByCollection);
      jointMesh.visible = !hiddenByCol && this.boneDisplayMode !== 'hidden';
      jointMesh.renderOrder = 999;
      bone.add(jointMesh);

      // 3. Blender-style Octahedral Bone shaft hit proxy connecting bone to child
      const childBone = bone.children.find(c => c.isBone);
      if (childBone) {
        const boneLength = childBone.position.length();
        if (boneLength > 1e-3) {
          const octaMesh = this._createOctahedralBoneMesh(boneLength, childBone.position, medianLen);
          octaMesh.name = `Octa_${bone.name}`;
          octaMesh.userData.isBoneHitProxy = true;
          octaMesh.userData.isSystemObject = true;
          octaMesh.userData.isHelper = true;
          octaMesh.userData.selectable = false;
          octaMesh.userData.targetBone = bone;
          octaMesh.visible = !hiddenByCol && this.boneDisplayMode === 'octahedral';
          octaMesh.renderOrder = 997;
          bone.add(octaMesh);
        }
      }
    });

    return helper;
  }

  /**
   * Creates a Blender-style tapered octahedral bone geometry stretching to childPosition
   */
  _createOctahedralBoneMesh(length, childPos, medianLen = 0.25) {
    const THREE = this.THREE;
    const geom = new THREE.BufferGeometry();
    const w = Math.min(medianLen * 0.19, length * 0.16); // waist radius scales cleanly with rig units
    const swell = length * 0.22; // position of waist along shaft

    // Vertices: Root (0,0,0), Waist (+X, -X, +Z, -Z at swell), Tip (0, length, 0)
    // We orient along +Y then rotate to match childPos
    const positions = new Float32Array([
      // 4 bottom triangles (Root to Waist)
      0, 0, 0,  w, swell, 0,  0, swell, w,
      0, 0, 0,  0, swell, w,  -w, swell, 0,
      0, 0, 0,  -w, swell, 0, 0, swell, -w,
      0, 0, 0,  0, swell, -w, w, swell, 0,
      // 4 top triangles (Waist to Tip)
      w, swell, 0,  0, length, 0,  0, swell, w,
      0, swell, w,  0, length, 0,  -w, swell, 0,
      -w, swell, 0, 0, length, 0,  0, swell, -w,
      0, swell, -w, 0, length, 0,  w, swell, 0
    ]);

    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.computeVertexNormals();

    const mat = new THREE.MeshBasicMaterial({
      color: this.isEditBoneMode ? 0x2ecc71 : 0xe67e22,
      wireframe: true,
      transparent: true,
      opacity: 0.35,
      depthTest: false
    });

    const mesh = new THREE.Mesh(geom, mat);

    // Rotate local +Y to align with childPos vector
    const dir = childPos.clone().normalize();
    const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    mesh.quaternion.copy(quat);

    return mesh;
  }

  /**
   * Select a bone interactively in Pose Mode or Edit Bone Mode
   */
  selectBone(bone) {
    if (!bone) return;
    this.activeBone = bone;

    // Highlight active joint sphere & octahedral proxy in cyan (#00cec9)
    const skel = this.editSkeleton || this.activeSkeleton;
    const baseJointHex = this.isEditBoneMode ? 0x2ecc71 : 0xf39c12;
    const baseOctaHex = this.isEditBoneMode ? 0x2ecc71 : 0xe67e22;
    if (skel) {
      skel.bones.forEach((b) => {
        const isSelected = b === bone;
        b.children.forEach((c) => {
          if (c.userData?.isBoneJoint && c.material) {
            c.material.color.setHex(isSelected ? 0x00cec9 : baseJointHex);
            c.scale.setScalar(isSelected ? 1.3 : 1.0);
          } else if (c.userData?.isBoneHitProxy && c.material) {
            c.material.color.setHex(isSelected ? 0x00cec9 : baseOctaHex);
            c.material.opacity = isSelected ? 0.75 : 0.35;
          }
        });
      });
    }

    // Attach TransformControls: detach during Weight Paint so gizmo spheres don't intercept brush strokes
    const engine = this._getEngine();
    if (engine?.transformControls) {
      if (this.isWeightPaintMode) {
        engine.transformControls.detach();
      } else if (this.isEditBoneMode) {
        engine.transformControls.setSpace('local');
        engine.transformControls.setMode('translate');
        engine.transformControls.attach(bone);
      } else {
        engine.transformControls.setSpace('local');
        engine.transformControls.setMode('rotate');
        engine.transformControls.attach(bone);
      }
    }

    // If Weight Paint mode is active, refresh heatmap for the newly selected bone
    if (this.isWeightPaintMode) {
      this.updateWeightPaint(bone);
    }

    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('blender:bone-selected', {
        detail: { bone, boneName: bone.name }
      }));
      if (window.codeEditor) {
        window.codeEditor.log('info', this.isEditBoneMode
          ? `🧱 Edit Bone [${bone.name}]: Drag gizmo (G), Press E to Extrude, X to Delete.`
          : `🦴 Selected bone [${bone.name}]. Use the Rotate Gizmo or press R to pose.`);
      }
    }
  }

  onBoneRotated(bone) {
    if (this.constraintsEnabled && !this._evaluatingConstraints) {
      this.evaluateConstraints(this.activeCharacter || bone);
    }
    this.ikChains.forEach((chain, key) => {
      if (this.getChainIKBlend(key) < 0.99 &&
          (bone === chain.upper || bone === chain.mid || bone === chain.end)) {
        chain.fkPose = {
          upper: chain.upper.quaternion.clone(),
          mid: chain.mid.quaternion.clone(),
          end: chain.end.quaternion.clone(),
        };
      }
    });
    if (this.isIKEnabled && !this._isSolvingIK) {
      const bName = bone ? RigSystem.cleanBoneName(bone.name).toLowerCase() : '';
      const isRootMove = bone && (/^(hips|pelvis|root|spine)$/i.test(bName) || !bone.parent?.isBone);
      if (this.pinFeetIK && isRootMove) {
        this._isSolvingIK = true;
        try {
          ['leftLeg', 'rightLeg'].forEach((key) => {
            const chain = this.ikChains.get(key);
            if (!chain) return;
            this.solveTwoBoneIK(
              chain.upper,
              chain.mid,
              chain.end,
              chain.targetHandle.position,
              chain.poleHandle.position,
              true,
              chain.targetHandle.userData?.pinnedWorldQuat || null,
              { ikBlend: this.getChainIKBlend(key) }
            );
            chain.mid.updateMatrixWorld(true);
            const midPos = new this.THREE.Vector3().setFromMatrixPosition(chain.mid.matrixWorld);
            chain.guideLine.geometry.setFromPoints([midPos, chain.poleHandle.position]);
            chain.guideLine.computeLineDistances();
          });
        } finally {
          this._isSolvingIK = false;
        }
        this.updateIKHandlesPositions(['leftArm', 'rightArm']);
      } else {
        this.updateIKHandlesPositions();
      }
    }
    this.updateSkeletonHelper();
  }

  setPinFeetIK(enabled) {
    this.pinFeetIK = !!enabled;
    return this.pinFeetIK;
  }

  // =========================================================================
  // 3. ANALYTICAL TWO-BONE INVERSE KINEMATICS (Two-Bone IK Engine)
  // =========================================================================

  /**
   * Gold-standard analytical Law of Cosines Two-Bone IK solver with Pole Vector,
   * Soft-IK near max extension, and optional End-Bone orientation locking.
   */
  solveTwoBoneIK(upperBone, midBone, endBone, targetWorldPos, poleWorldPos = null, alignEndBone = false, targetWorldQuat = null, options = {}) {
    const THREE = this.THREE;
    if (!upperBone || !midBone || !endBone || !targetWorldPos) return false;

    const ikBlend = options?.ikBlend !== undefined
      ? Math.max(0, Math.min(1, Number(options.ikBlend)))
      : 1.0;
    if (ikBlend <= 1e-6) return true;

    const blendFK = ikBlend < 1 - 1e-6;
    const fkUpperQ = blendFK ? upperBone.quaternion.clone() : null;
    const fkMidQ = blendFK ? midBone.quaternion.clone() : null;
    const fkEndQ = blendFK ? endBone.quaternion.clone() : null;

    // Ensure all matrices are up-to-date
    upperBone.parent?.updateMatrixWorld(true);
    upperBone.updateMatrixWorld(true);
    midBone.updateMatrixWorld(true);
    endBone.updateMatrixWorld(true);

    const posA = new THREE.Vector3().setFromMatrixPosition(upperBone.matrixWorld);
    const posB = new THREE.Vector3().setFromMatrixPosition(midBone.matrixWorld);
    const posC = new THREE.Vector3().setFromMatrixPosition(endBone.matrixWorld);
    const posT = targetWorldPos.clone();
    const preservedEndQuat = (alignEndBone && !targetWorldQuat)
      ? endBone.getWorldQuaternion(new THREE.Quaternion())
      : targetWorldQuat;

    // 1. Segment lengths
    const L1 = posA.distanceTo(posB);
    const L2 = posB.distanceTo(posC);
    if (L1 < 1e-4 || L2 < 1e-4) return false;

    // 2. Vector from A (Upper) to Target T with Soft-IK anti-pop roll-off near max reach
    const vecAT = posT.clone().sub(posA);
    const distAT = vecAT.length();
    const totalLen = L1 + L2;
    const maxReach = totalLen * 0.9999;
    const minReach = Math.max(1e-4, Math.abs(L1 - L2) * 1.0001);
    let softDist = distAT;
    if (options?.softIK !== false) {
      const softStart = totalLen * 0.965;
      const softSpan = Math.max(1e-4, maxReach - softStart);
      if (distAT > softStart) {
        softDist = softStart + softSpan * (1.0 - Math.exp(-(distAT - softStart) / softSpan));
      }
    }
    const d = Math.max(minReach, Math.min(softDist, maxReach));
    const dirAT = distAT > 1e-6 ? vecAT.clone().normalize() : new THREE.Vector3(0, -1, 0);

    // 3. Pole Vector & Bend Plane
    let poleDir = new THREE.Vector3();
    if (poleWorldPos) {
      poleDir.copy(poleWorldPos).sub(posA);
    } else {
      // Natural default: bend along current limb flexion or character forward/backward
      const currentBend = posB.clone().sub(posA.clone().lerp(posC, 0.5));
      poleDir = currentBend.lengthSq() > 1e-5 ? currentBend : new THREE.Vector3(0, 0, 1);
    }

    // Project poleDir onto plane perpendicular to dirAT
    const poleDot = poleDir.dot(dirAT);
    const normalPole = poleDir.clone().sub(dirAT.clone().multiplyScalar(poleDot));
    if (normalPole.lengthSq() < 1e-6) {
      const fallback = Math.abs(dirAT.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
      normalPole.copy(fallback).sub(dirAT.clone().multiplyScalar(fallback.dot(dirAT)));
    }
    normalPole.normalize();

    // 4. Law of Cosines for Joint A (angle alpha between dirAT and solved UpperBone)
    const cosAlpha = Math.max(-1, Math.min(1, (L1 * L1 + d * d - L2 * L2) / (2 * L1 * d)));
    const sinAlpha = Math.sqrt(Math.max(0, 1 - cosAlpha * cosAlpha));

    // Target position for MidBone (Joint B) in world space
    const targetMidPos = posA.clone()
      .add(dirAT.clone().multiplyScalar(L1 * cosAlpha))
      .add(normalPole.clone().multiplyScalar(L1 * sinAlpha));

    // 5. Orient UpperBone in World Space (guard against 180-degree opposite unit vectors)
    const parentWorldQuat = upperBone.parent
      ? upperBone.parent.getWorldQuaternion(new THREE.Quaternion())
      : new THREE.Quaternion();

    const safeFromUnitVectors = (from, to) => {
      const q = new THREE.Quaternion();
      const dDot = from.dot(to);
      if (dDot < -0.9999) {
        let ortho = new THREE.Vector3(1, 0, 0).cross(from);
        if (ortho.lengthSq() < 1e-5) ortho = new THREE.Vector3(0, 1, 0).cross(from);
        ortho.normalize();
        return q.setFromAxisAngle(ortho, Math.PI);
      }
      return q.setFromUnitVectors(from, to);
    };

    // Current upper bone direction in world space
    const currUpperDir = posB.clone().sub(posA).normalize();
    const targUpperDir = targetMidPos.clone().sub(posA).normalize();

    // Shortest arc rotation from current direction to target direction
    const origUpperWorldQuat = upperBone.getWorldQuaternion(new THREE.Quaternion());
    const qUpperAim = safeFromUnitVectors(currUpperDir, targUpperDir);
    let worldUpperQuat = qUpperAim.clone().multiply(origUpperWorldQuat);

    // Twist upperBone around targUpperDir only when current limb already defines a non-collinear bend plane
    const currLowerDir = posC.clone().sub(posB);
    if (currLowerDir.lengthSq() > 1e-6) {
      currLowerDir.normalize();
      const crossOrig = new THREE.Vector3().crossVectors(currUpperDir, currLowerDir);
      if (crossOrig.lengthSq() > 1e-4) {
        const curPoleWorld = currUpperDir.clone().sub(currLowerDir).applyQuaternion(qUpperAim);
        const curPoleProj = curPoleWorld.sub(targUpperDir.clone().multiplyScalar(curPoleWorld.dot(targUpperDir)));
        const desPoleProj = normalPole.clone().sub(targUpperDir.clone().multiplyScalar(normalPole.dot(targUpperDir)));
        if (curPoleProj.lengthSq() > 1e-6 && desPoleProj.lengthSq() > 1e-6) {
          curPoleProj.normalize();
          desPoleProj.normalize();
          const dotP = Math.max(-1, Math.min(1, curPoleProj.dot(desPoleProj)));
          const crossP = new THREE.Vector3().crossVectors(curPoleProj, desPoleProj);
          const twistAngle = Math.atan2(crossP.dot(targUpperDir), dotP);
          if (Math.abs(twistAngle) > 1e-4) {
            const qTwist = new THREE.Quaternion().setFromAxisAngle(targUpperDir, twistAngle);
            worldUpperQuat = qTwist.multiply(worldUpperQuat);
          }
        }
      }
    }

    // Convert UpperBone world quaternion to local quaternion
    upperBone.quaternion.copy(parentWorldQuat.clone().invert().multiply(worldUpperQuat));
    upperBone.updateMatrixWorld(true);

    // 6. Orient MidBone in World Space
    const newMidWorldPos = new THREE.Vector3().setFromMatrixPosition(midBone.matrixWorld);
    const newEndWorldPos = new THREE.Vector3().setFromMatrixPosition(endBone.matrixWorld);

    const posTEffective = posA.clone().addScaledVector(dirAT, d);
    const currMidDir = newEndWorldPos.clone().sub(newMidWorldPos).normalize();
    const targMidDir = posTEffective.clone().sub(newMidWorldPos).normalize();

    const qMidAim = safeFromUnitVectors(currMidDir, targMidDir);
    const worldMidQuat = qMidAim.multiply(midBone.getWorldQuaternion(new THREE.Quaternion()));

    const upperWorldQuat = upperBone.getWorldQuaternion(new THREE.Quaternion());
    midBone.quaternion.copy(upperWorldQuat.clone().invert().multiply(worldMidQuat));
    midBone.updateMatrixWorld(true);

    if (alignEndBone && preservedEndQuat) {
      const midWorldAfter = midBone.getWorldQuaternion(new THREE.Quaternion());
      endBone.quaternion.copy(midWorldAfter.invert().multiply(preservedEndQuat));
    }

    if (blendFK) {
      const ikUpperQ = upperBone.quaternion.clone();
      const ikMidQ = midBone.quaternion.clone();
      const ikEndQ = endBone.quaternion.clone();
      upperBone.quaternion.copy(fkUpperQ).slerp(ikUpperQ, ikBlend).normalize();
      midBone.quaternion.copy(fkMidQ).slerp(ikMidQ, ikBlend).normalize();
      endBone.quaternion.copy(fkEndQ).slerp(ikEndQ, ikBlend).normalize();
      upperBone.updateMatrixWorld(true);
      midBone.updateMatrixWorld(true);
    }
    endBone.updateMatrixWorld(true);

    return true;
  }

  /**
   * Initializes interactive Two-Bone IK chains & handles for character
   */
  setupTwoBoneIK(character = null) {
    const THREE = this.THREE;
    const scene = this.scene || (typeof window !== 'undefined' ? window.scene : null);
    const rig = this._prepareRig(character || this.activeCharacter);
    if (!rig || !scene) return false;

    // Clean up and dispose existing IK group if any
    if (this.ikHandlesGroup) {
      if (this.ikHandlesGroup.parent) {
        this.ikHandlesGroup.parent.remove(this.ikHandlesGroup);
      }
      this.ikHandlesGroup.traverse?.((node) => {
        node.geometry?.dispose?.();
        if (Array.isArray(node.material)) node.material.forEach((m) => m?.dispose?.());
        else node.material?.dispose?.();
      });
      this.ikHandlesGroup = null;
    }
    this.ikChains.clear();
    this.chainBlends?.clear?.();
    this.activeIKHandle = null;

    const ikGroup = new THREE.Group();
    ikGroup.name = 'IK_Controls_Group';
    ikGroup.userData.isSystemObject = true;
    ikGroup.userData.isIKHandlesGroup = true;
    ikGroup.userData.targetRoot = (character && character.isObject3D ? character : null) || rig.root || this.activeCharacter || null;

    const boneAliases = {
      LeftUpLeg: ['leftupleg', 'thigh_l', 'upperleg_l', 'hip_l', 'j_bip_l_upperleg'],
      LeftLeg: ['leftleg', 'calf_l', 'shin_l', 'knee_l', 'lowerleg_l', 'j_bip_l_lowerleg'],
      LeftFoot: ['leftfoot', 'foot_l', 'ankle_l', 'j_bip_l_foot'],
      RightUpLeg: ['rightupleg', 'thigh_r', 'upperleg_r', 'hip_r', 'j_bip_r_upperleg'],
      RightLeg: ['rightleg', 'calf_r', 'shin_r', 'knee_r', 'lowerleg_r', 'j_bip_r_lowerleg'],
      RightFoot: ['rightfoot', 'foot_r', 'ankle_r', 'j_bip_r_foot'],
      LeftArm: ['leftarm', 'leftupperarm', 'upperarm_l', 'shoulder_l', 'j_bip_l_upperarm'],
      LeftForeArm: ['leftforearm', 'forearm_l', 'lowerarm_l', 'elbow_l', 'j_bip_l_lowerarm'],
      LeftHand: ['lefthand', 'hand_l', 'wrist_l', 'j_bip_l_hand'],
      RightArm: ['rightarm', 'rightupperarm', 'upperarm_r', 'shoulder_r', 'j_bip_r_upperarm'],
      RightForeArm: ['rightforearm', 'forearm_r', 'lowerarm_r', 'elbow_r', 'j_bip_r_lowerarm'],
      RightHand: ['righthand', 'hand_r', 'wrist_r', 'j_bip_r_hand'],
    };

    const findBone = (name) => {
      const direct = rig.boneMap.get(RigSystem.cleanBoneName(name)) || rig.boneMap.get(name);
      if (direct) return direct;
      const alts = boneAliases[name] || [];
      for (const b of rig.bones) {
        const clean = RigSystem.cleanBoneName(b.name).toLowerCase();
        if (alts.includes(clean) || alts.includes(b.name.toLowerCase())) return b;
      }
      return null;
    };

    // Chain configurations: [chainKey, upperName, midName, endName, defaultPoleOffset, color]
    const chainConfigs = [
      {
        key: 'leftLeg',
        upper: 'LeftUpLeg',
        mid: 'LeftLeg',
        end: 'LeftFoot',
        poleOffset: new THREE.Vector3(0, 0, 0.45), // Knee points forward (+Z)
        color: 0x2ecc71,
        isFoot: true
      },
      {
        key: 'rightLeg',
        upper: 'RightUpLeg',
        mid: 'RightLeg',
        end: 'RightFoot',
        poleOffset: new THREE.Vector3(0, 0, 0.45),
        color: 0x2ecc71,
        isFoot: true
      },
      {
        key: 'leftArm',
        upper: 'LeftArm',
        mid: 'LeftForeArm',
        end: 'LeftHand',
        poleOffset: new THREE.Vector3(0, 0, -0.45), // Elbow points backward (-Z)
        color: 0x00cec9,
        isFoot: false
      },
      {
        key: 'rightArm',
        upper: 'RightArm',
        mid: 'RightForeArm',
        end: 'RightHand',
        poleOffset: new THREE.Vector3(0, 0, -0.45),
        color: 0x00cec9,
        isFoot: false
      }
    ];

    chainConfigs.forEach((cfg) => {
      const upper = findBone(cfg.upper);
      const mid = findBone(cfg.mid);
      const end = findBone(cfg.end);
      if (!upper || !mid || !end) return;

      upper.updateMatrixWorld(true);
      mid.updateMatrixWorld(true);
      end.updateMatrixWorld(true);

      const endPos = new THREE.Vector3().setFromMatrixPosition(end.matrixWorld);
      const midPos = new THREE.Vector3().setFromMatrixPosition(mid.matrixWorld);

      // Target Handle Gizmo
      let handleGeom;
      if (cfg.isFoot) {
        handleGeom = new THREE.BoxGeometry(0.12, 0.08, 0.22);
      } else {
        handleGeom = new THREE.OctahedronGeometry(0.08, 0);
      }
      const handleMat = new THREE.MeshBasicMaterial({
        color: cfg.color,
        wireframe: true,
        depthTest: false,
        transparent: true,
        opacity: 0.95
      });
      const targetHandle = new THREE.Mesh(handleGeom, handleMat);
      targetHandle.name = `IK_Target_${cfg.key}`;
      targetHandle.position.copy(endPos);
      targetHandle.renderOrder = 1000;
      targetHandle.userData.isIKHandle = true;
      targetHandle.userData.isSystemObject = true;
      targetHandle.userData.isHelper = true;
      targetHandle.userData.chainKey = cfg.key;
      targetHandle.userData.handleType = 'target';
      targetHandle.userData.pinnedWorldQuat = end.getWorldQuaternion(new THREE.Quaternion()).clone();
      ikGroup.add(targetHandle);

      // Pole Handle Gizmo
      const polePos = midPos.clone().add(cfg.poleOffset);
      const poleGeom = new THREE.SphereGeometry(0.04, 12, 8);
      const poleMat = new THREE.MeshBasicMaterial({
        color: 0xf39c12,
        wireframe: true,
        depthTest: false,
        transparent: true,
        opacity: 0.85
      });
      const poleHandle = new THREE.Mesh(poleGeom, poleMat);
      poleHandle.name = `IK_Pole_${cfg.key}`;
      poleHandle.position.copy(polePos);
      poleHandle.renderOrder = 1000;
      poleHandle.userData.isIKHandle = true;
      poleHandle.userData.isSystemObject = true;
      poleHandle.userData.isHelper = true;
      poleHandle.userData.chainKey = cfg.key;
      poleHandle.userData.handleType = 'pole';
      ikGroup.add(poleHandle);

      // Dashed Guide Line connecting Mid Joint to Pole
      const lineGeom = new THREE.BufferGeometry().setFromPoints([midPos, polePos]);
      const lineMat = new THREE.LineDashedMaterial({
        color: 0xe67e22,
        dashSize: 0.04,
        gapSize: 0.02,
        depthTest: false,
        transparent: true,
        opacity: 0.6
      });
      const guideLine = new THREE.Line(lineGeom, lineMat);
      guideLine.computeLineDistances();
      guideLine.renderOrder = 998;
      guideLine.userData.isSystemObject = true;
      guideLine.userData.isHelper = true;
      guideLine.userData.selectable = false;
      ikGroup.add(guideLine);

      this.ikChains.set(cfg.key, {
        upper,
        mid,
        end,
        targetHandle,
        poleHandle,
        guideLine,
        config: cfg,
        fkPose: {
          upper: upper.quaternion.clone(),
          mid: mid.quaternion.clone(),
          end: end.quaternion.clone(),
        }
      });
    });

    scene.add(ikGroup);
    this.ikHandlesGroup = ikGroup;
    this.ikHandlesGroup.visible = this.isIKEnabled;
    return true;
  }

  /**
   * Toggles Two-Bone IK active state and gizmo visibility
   */
  setIKEnabled(enabled) {
    this.isIKEnabled = !!enabled;
    if (this.isIKEnabled && (!this.ikHandlesGroup || this.ikChains.size === 0)) {
      this.setupTwoBoneIK();
    }
    if (this.ikHandlesGroup) {
      this.ikHandlesGroup.visible = this.isIKEnabled;
      if (this.isIKEnabled) {
        this.updateIKHandlesPositions();
      }
    }
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('blender:ik-mode-changed', {
        detail: { isIKEnabled: this.isIKEnabled }
      }));
    }
    return this.isIKEnabled;
  }

  /**
   * Snaps IK handles to current bone positions (optionally scoped to chainKeys subset).
   */
  updateIKHandlesPositions(chainKeys = null) {
    if (!this.isIKEnabled) return;
    const THREE = this.THREE;
    const keys = Array.isArray(chainKeys) ? chainKeys : null;
    this.ikChains.forEach((chain, key) => {
      if (keys && !keys.includes(key)) return;
      chain.end.updateMatrixWorld(true);
      chain.mid.updateMatrixWorld(true);
      const endPos = new THREE.Vector3().setFromMatrixPosition(chain.end.matrixWorld);
      const midPos = new THREE.Vector3().setFromMatrixPosition(chain.mid.matrixWorld);
      chain.targetHandle.position.copy(endPos);
      chain.targetHandle.userData.pinnedWorldQuat = chain.end.getWorldQuaternion(new THREE.Quaternion()).clone();

      // Update guide line
      const points = [midPos, chain.poleHandle.position];
      chain.guideLine.geometry.setFromPoints(points);
      chain.guideLine.computeLineDistances();
    });
  }

  /**
   * Handles interactive dragging of an IK Target or Pole handle
   */
  getChainIKBlend(chainKey) {
    if (!this.chainBlends.has(chainKey)) return 1.0;
    return this.chainBlends.get(chainKey);
  }

  setChainIKBlend(chainKey, blend = 1.0, options = {}) {
    const THREE = this.THREE;
    const b = Math.max(0, Math.min(1, Number(blend) || 0));
    const keys = chainKey ? [chainKey] : Array.from(this.ikChains.keys());
    keys.forEach((k) => {
      this.chainBlends.set(k, b);
      if (options.apply === false) return;
      const chain = this.ikChains.get(k);
      if (!chain) return;
      if (chain.fkPose) {
        chain.upper.quaternion.copy(chain.fkPose.upper);
        chain.mid.quaternion.copy(chain.fkPose.mid);
        chain.end.quaternion.copy(chain.fkPose.end);
        chain.upper.updateMatrixWorld(true);
        chain.mid.updateMatrixWorld(true);
        chain.end.updateMatrixWorld(true);
      }
      if (b > 1e-6) {
        const isFoot = Boolean(chain.config?.isFoot);
        const targetQuat = (isFoot && chain.targetHandle.userData?.pinnedWorldQuat)
          ? chain.targetHandle.userData.pinnedWorldQuat
          : null;
        this.solveTwoBoneIK(
          chain.upper,
          chain.mid,
          chain.end,
          chain.targetHandle.position,
          chain.poleHandle.position,
          isFoot,
          targetQuat,
          { ikBlend: b }
        );
      }
      chain.mid.updateMatrixWorld(true);
      const midPos = new THREE.Vector3().setFromMatrixPosition(chain.mid.matrixWorld);
      chain.guideLine?.geometry?.setFromPoints([midPos, chain.poleHandle.position]);
      chain.guideLine?.computeLineDistances?.();
    });
    this.updateSkeletonHelper();
    return b;
  }

  snapIKToFK(chainKey = null) {
    const THREE = this.THREE;
    if (this.ikChains.size === 0) this.setupTwoBoneIK();
    const keys = chainKey ? [chainKey] : Array.from(this.ikChains.keys());
    let snapped = 0;
    keys.forEach((key) => {
      const chain = this.ikChains.get(key);
      if (!chain) return;
      chain.upper.updateMatrixWorld(true);
      chain.mid.updateMatrixWorld(true);
      chain.end.updateMatrixWorld(true);
      const posA = new THREE.Vector3().setFromMatrixPosition(chain.upper.matrixWorld);
      const posB = new THREE.Vector3().setFromMatrixPosition(chain.mid.matrixWorld);
      const posC = new THREE.Vector3().setFromMatrixPosition(chain.end.matrixWorld);

      chain.targetHandle.position.copy(posC);
      chain.targetHandle.userData.pinnedWorldQuat = chain.end.getWorldQuaternion(new THREE.Quaternion()).clone();

      const ac = posC.clone().sub(posA);
      const acLen = ac.length();
      const dist = Math.max(0.25, (posA.distanceTo(posB) + posB.distanceTo(posC)) * 0.5);
      let polePos = null;
      if (acLen > 1e-5) {
        const dirAC = ac.divideScalar(acLen);
        const proj = posA.clone().addScaledVector(dirAC, posB.clone().sub(posA).dot(dirAC));
        const bend = posB.clone().sub(proj);
        if (bend.lengthSq() > 1e-6) {
          polePos = posB.clone().addScaledVector(bend.normalize(), dist);
        }
      }
      if (!polePos) {
        polePos = posB.clone().add(chain.config?.poleOffset || new THREE.Vector3(0, 0, 0.45));
      }
      chain.poleHandle.position.copy(polePos);
      chain.guideLine?.geometry?.setFromPoints([posB, polePos]);
      chain.guideLine?.computeLineDistances?.();
      chain.fkPose = {
        upper: chain.upper.quaternion.clone(),
        mid: chain.mid.quaternion.clone(),
        end: chain.end.quaternion.clone(),
      };
      this.chainBlends.set(key, 1.0);
      snapped++;
    });
    this.updateSkeletonHelper();
    return snapped;
  }

  snapFKToIK(chainKey = null) {
    if (this.ikChains.size === 0) this.setupTwoBoneIK();
    const keys = chainKey ? [chainKey] : Array.from(this.ikChains.keys());
    let snapped = 0;
    keys.forEach((key) => {
      const chain = this.ikChains.get(key);
      if (!chain) return;
      if (this.getChainIKBlend(key) < 1 - 1e-6) {
        this.setChainIKBlend(key, 1.0);
      }
      chain.upper.updateMatrixWorld(true);
      chain.mid.updateMatrixWorld(true);
      chain.end.updateMatrixWorld(true);
      chain.fkPose = {
        upper: chain.upper.quaternion.clone(),
        mid: chain.mid.quaternion.clone(),
        end: chain.end.quaternion.clone(),
      };
      this.chainBlends.set(key, 0.0);
      snapped++;
    });
    this.updateSkeletonHelper();
    return snapped;
  }

  onIKHandleMoved(handle) {
    if (!handle || !handle.userData?.chainKey) return;
    const chainKey = handle.userData.chainKey;
    const chain = this.ikChains.get(chainKey);
    if (!chain) return;

    const THREE = this.THREE;
    const ikBlend = this.getChainIKBlend(chainKey);
    this._isSolvingIK = true;
    try {
      const isFoot = Boolean(chain.config?.isFoot);
      const targetQuat = (isFoot && chain.targetHandle.userData?.pinnedWorldQuat)
        ? chain.targetHandle.userData.pinnedWorldQuat
        : null;

      if (ikBlend < 1 - 1e-6 && chain.fkPose) {
        chain.upper.quaternion.copy(chain.fkPose.upper);
        chain.mid.quaternion.copy(chain.fkPose.mid);
        chain.end.quaternion.copy(chain.fkPose.end);
        chain.upper.updateMatrixWorld(true);
        chain.mid.updateMatrixWorld(true);
        chain.end.updateMatrixWorld(true);
      }

      this.solveTwoBoneIK(
        chain.upper,
        chain.mid,
        chain.end,
        chain.targetHandle.position,
        chain.poleHandle.position,
        isFoot,
        targetQuat,
        { ikBlend }
      );

      if (this.constraintsEnabled && !this._evaluatingConstraints) {
        this.evaluateConstraints(this.activeCharacter || chain.upper);
      }

      if (handle.userData.handleType === 'target' && !isFoot) {
        chain.end.updateMatrixWorld(true);
        chain.targetHandle.userData.pinnedWorldQuat = chain.end.getWorldQuaternion(new THREE.Quaternion()).clone();
      }
    } finally {
      this._isSolvingIK = false;
    }

    // Update guide line
    chain.mid.updateMatrixWorld(true);
    const midPos = new THREE.Vector3().setFromMatrixPosition(chain.mid.matrixWorld);
    chain.guideLine.geometry.setFromPoints([midPos, chain.poleHandle.position]);
    chain.guideLine.computeLineDistances();

    this.updateSkeletonHelper();
  }

  /**
   * Selects an IK Handle and attaches TransformControls in Translate mode
   */
  selectIKHandle(handle) {
    if (!handle) return;
    this.activeIKHandle = handle;

    if (this.ikHandlesGroup) {
      this.ikHandlesGroup.traverse((o) => {
        if (o.userData?.isIKHandle && o.material) {
          const isSelected = o === handle;
          o.material.color.setHex(isSelected ? 0xffffff : (o.userData.handleType === 'target' ? 0x2ecc71 : 0xf39c12));
        }
      });
    }

    if (typeof window !== 'undefined' && window.engine && window.engine.transformControls) {
      window.engine.transformControls.setSpace('world');
      window.engine.transformControls.setMode('translate');
      window.engine.transformControls.attach(handle);
    }
  }

  // =========================================================================
  // 4. WEIGHT PAINT VISUALIZER (Blender Heatmap: Blue -> Green -> Yellow -> Red)
  // =========================================================================

  /**
   * Toggles Weight Paint mode on the active skinned character
   */
  toggleWeightPaintMode(characterOrEnable = null, boneOrIndex = null) {
    if (typeof characterOrEnable === 'boolean') {
      if (!characterOrEnable) {
        return this.disableWeightPaintMode();
      }
      return this.enableWeightPaintMode(null, boneOrIndex);
    }
    if (this.isWeightPaintMode) {
      return this.disableWeightPaintMode();
    } else {
      return this.enableWeightPaintMode(characterOrEnable, boneOrIndex);
    }
  }

  /**
   * Enables Weight Paint inspection & interactive brush mode
   */
  enableWeightPaintMode(character = null, bone = null) {
    let char = character;
    if (typeof char === 'boolean' || !char) {
      char = this.activeCharacter || (typeof window !== 'undefined' && window.sceneManager ? window.sceneManager.getActiveObject() : null);
    }
    if (!char && typeof window !== 'undefined' && window.scene) {
      char = window.scene.children.find(c => c.userData?.isCharacter || c.userData?.isArmature || c.isSkinnedMesh);
    }

    if (!char || typeof char.traverse !== 'function') {
      console.warn('[RigSystem] No valid character selected for Weight Paint');
      this.isWeightPaintMode = false;
      return false;
    }

    let skinnedMesh = null;
    char.traverse((c) => {
      if (!skinnedMesh && c.isSkinnedMesh) skinnedMesh = c;
    });

    if (!skinnedMesh) {
      console.warn('[RigSystem] No SkinnedMesh found in character hierarchy for Weight Paint inspection');
      if (typeof window !== 'undefined' && window.codeEditor) {
        window.codeEditor.log('warn', '⚠️ No SkinnedMesh found for Weight Paint view. Run Auto-Skin first.');
      }
      this.isWeightPaintMode = false;
      return false;
    }

    if (this.isEditBoneMode) {
      this.exitEditBoneMode();
    }
    if (typeof window !== 'undefined') {
      if (window.editMode?.isActive) window.editMode.exit();
      if (window.sculptMode?.isActive) window.sculptMode.exit();
      if (window.paintMode?.isActive) window.paintMode.exit();
    }

    this.isWeightPaintMode = true;
    this.weightPaintMesh = skinnedMesh;

    const skeleton = skinnedMesh.skeleton || this.activeSkeleton || (char.userData && char.userData.skeleton);
    let targetBone = null;
    if (typeof bone === 'number' && skeleton && skeleton.bones) {
      targetBone = skeleton.bones[bone] || skeleton.bones[0];
    } else if (typeof bone === 'string' && skeleton && skeleton.bones) {
      targetBone = skeleton.bones.find(b => b.name.toLowerCase() === bone.toLowerCase()) || skeleton.bones[0];
    } else if (bone && bone.isBone) {
      targetBone = bone;
    } else {
      targetBone = this.activeBone || (skeleton && skeleton.bones ? skeleton.bones[0] : null);
    }

    if (skinnedMesh.userData._hadOriginalColorAttr === undefined) {
      const existingColor = skinnedMesh.geometry?.attributes?.color;
      skinnedMesh.userData._hadOriginalColorAttr = Boolean(existingColor);
      if (existingColor) {
        skinnedMesh.userData._origColorArray = Array.from(existingColor.array);
      }
    }
    if (!skinnedMesh.userData._origMaterial) {
      skinnedMesh.userData._origMaterial = skinnedMesh.material;
    }

    if (!skinnedMesh.userData._weightPaintMat) {
      skinnedMesh.userData._weightPaintMat = new this.THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.5,
        metalness: 0.1,
        wireframe: false
      });
    }

    skinnedMesh.material = skinnedMesh.userData._weightPaintMat;

    if (targetBone) {
      this.selectBone(targetBone);
    }
    this.updateWeightPaint(targetBone);
    this._ensureWeightCursor();
    this._getEngine()?.transformControls?.detach?.();
    this._attachWeightPaintCanvasEvents();
    this._syncViewportModeUI('weight-paint');

    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('blender:weight-paint-mode-changed', {
        detail: {
          active: true,
          bone: targetBone?.name,
          brush: { ...this.weightBrush },
        }
      }));
      if (window.codeEditor) {
        window.codeEditor.log('info', '🎨 Enabled Weight Paint Brush (Left-drag on mesh to paint, [ / ] radius)');
      }
    }
    return true;
  }

  /**
   * Disables Weight Paint mode and restores original materials
   */
  disableWeightPaintMode() {
    this.isWeightPaintMode = false;
    this._isWeightBrushing = false;
    this._weightStrokeConsumed = false;
    this._strokeStartSkinIndices = null;
    this._strokeStartSkinWeights = null;
    this._hideWeightCursor();
    this._detachWeightPaintCanvasEvents();

    const eng = this._getEngine();
    if (eng?.controls && eng.controls.enabled === false) {
      eng.controls.enabled = true;
    }

    if (this.weightPaintMesh) {
      if (this.weightPaintMesh.userData._origMaterial) {
        this.weightPaintMesh.material = this.weightPaintMesh.userData._origMaterial;
        delete this.weightPaintMesh.userData._origMaterial;
      }
      if (!this.weightPaintMesh.userData._hadOriginalColorAttr && this.weightPaintMesh.geometry?.attributes?.color) {
        this.weightPaintMesh.geometry.deleteAttribute('color');
      } else if (this.weightPaintMesh.userData._hadOriginalColorAttr && Array.isArray(this.weightPaintMesh.userData._origColorArray)) {
        const cAttr = this.weightPaintMesh.geometry?.attributes?.color;
        if (cAttr && cAttr.array.length === this.weightPaintMesh.userData._origColorArray.length) {
          cAttr.array.set(this.weightPaintMesh.userData._origColorArray);
          cAttr.needsUpdate = true;
        }
      }
      delete this.weightPaintMesh.userData._origColorArray;
      delete this.weightPaintMesh.userData._hadOriginalColorAttr;
    }
    const prevWeightMesh = this.weightPaintMesh;
    this.weightPaintMesh = null;

    if (this.isPoseMode && this.activeBone) {
      this.selectBone(this.activeBone);
    } else if (!this.isEditBoneMode) {
      eng?.updateActiveGizmo?.(eng.sceneManager?.getActiveObject?.() || prevWeightMesh || this.activeCharacter);
      eng?.updateSelectionHelper?.();
    }
    this._syncViewportModeUI(this.isEditBoneMode ? 'edit-bone' : (this.isPoseMode ? 'pose' : 'object'));

    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('blender:weight-paint-mode-changed', {
        detail: { active: false }
      }));
      if (window.codeEditor) {
        window.codeEditor.log('info', '🎨 Disabled Weight Paint view');
      }
    }
    return false;
  }

  /**
   * Updates Weight Paint brush parameters and syncs cursor/UI.
   */
  setWeightBrush(options = {}) {
    if (options.mode && ['add', 'subtract', 'replace', 'smooth'].includes(options.mode)) {
      this.weightBrush.mode = options.mode;
    }
    if (Number.isFinite(options.radius)) {
      this.weightBrush.radius = Math.max(0.01, Math.min(2.0, options.radius));
    }
    if (Number.isFinite(options.strength)) {
      this.weightBrush.strength = Math.max(0.01, Math.min(1.0, options.strength));
    }
    if (typeof options.symmetryX === 'boolean') {
      this.weightBrush.symmetryX = options.symmetryX;
    }

    if (this._weightCursor) {
      const r = this.weightBrush.radius;
      this._weightCursor.scale.set(r, r, r);
    }
    if (this._weightMirrorCursor) {
      const r = this.weightBrush.radius;
      this._weightMirrorCursor.scale.set(r, r, r);
      if (!this.weightBrush.symmetryX) this._weightMirrorCursor.visible = false;
    }

    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('blender:weight-brush-changed', {
        detail: { ...this.weightBrush }
      }));
    }
    return { ...this.weightBrush };
  }

  _ensureWeightCursor() {
    const scene = this.scene || (typeof window !== 'undefined' ? window.scene : null);
    if (!scene || !this.THREE) return;
    const THREE = this.THREE;
    if (!this._weightCursor) {
      const geom = new THREE.RingGeometry(0.90, 1.0, 32);
      const mat = new THREE.MeshBasicMaterial({
        color: 0x22ff99,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.9,
        depthTest: false,
      });
      this._weightCursor = new THREE.Mesh(geom, mat);
      this._weightCursor.name = '__WeightBrushCursor';
      this._weightCursor.renderOrder = 9999;
      this._weightCursor.visible = false;
      this._weightCursor.raycast = () => {};
      this._weightCursor.userData.isHelper = true;
      this._weightCursor.userData.isRigVisualizer = true;
      scene.add(this._weightCursor);
    }
    if (!this._weightMirrorCursor) {
      const geom = new THREE.RingGeometry(0.92, 1.0, 32);
      const mat = new THREE.MeshBasicMaterial({
        color: 0xff55cc,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.65,
        depthTest: false,
      });
      this._weightMirrorCursor = new THREE.Mesh(geom, mat);
      this._weightMirrorCursor.name = '__WeightBrushMirrorCursor';
      this._weightMirrorCursor.renderOrder = 9999;
      this._weightMirrorCursor.visible = false;
      this._weightMirrorCursor.raycast = () => {};
      this._weightMirrorCursor.userData.isHelper = true;
      this._weightMirrorCursor.userData.isRigVisualizer = true;
      scene.add(this._weightMirrorCursor);
    }
    const r = this.weightBrush.radius;
    this._weightCursor.scale.set(r, r, r);
    this._weightMirrorCursor.scale.set(r, r, r);
  }

  _hideWeightCursor() {
    if (this._weightCursor) this._weightCursor.visible = false;
    if (this._weightMirrorCursor) this._weightMirrorCursor.visible = false;
  }

  _updateWeightCursor(hit) {
    if (!hit || !this.weightPaintMesh) {
      this._hideWeightCursor();
      return;
    }
    this._ensureWeightCursor();
    const THREE = this.THREE;
    const r = this.weightBrush.radius;
    const normalWorld = new THREE.Vector3(0, 0, 1);
    if (hit.face?.normal) {
      normalWorld.copy(hit.face.normal).transformDirection(this.weightPaintMesh.matrixWorld).normalize();
    }
    const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), normalWorld);

    if (this._weightCursor) {
      this._weightCursor.position.copy(hit.point).addScaledVector(normalWorld, 0.003);
      this._weightCursor.quaternion.copy(quat);
      this._weightCursor.scale.set(r, r, r);
      this._weightCursor.visible = true;
    }

    if (this._weightMirrorCursor) {
      if (this.weightBrush.symmetryX) {
        const localHit = this.weightPaintMesh.worldToLocal(hit.point.clone());
        localHit.x = -localHit.x;
        const mirrorWorld = this.weightPaintMesh.localToWorld(localHit);
        const mirrorNormal = normalWorld.clone();
        mirrorNormal.x = -mirrorNormal.x;
        mirrorNormal.normalize();
        const mQuat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), mirrorNormal);
        this._weightMirrorCursor.position.copy(mirrorWorld).addScaledVector(mirrorNormal, 0.003);
        this._weightMirrorCursor.quaternion.copy(mQuat);
        this._weightMirrorCursor.scale.set(r, r, r);
        this._weightMirrorCursor.visible = true;
      } else {
        this._weightMirrorCursor.visible = false;
      }
    }
  }

  _attachWeightPaintCanvasEvents() {
    const dom = this._getEngine()?.renderer?.domElement;
    if (!dom || this._weightCanvasBound === dom) return;
    this._detachWeightPaintCanvasEvents();
    this._weightCanvasBound = dom;
    dom.addEventListener('pointerdown', this._onWeightPointerDownBound, true);
    dom.addEventListener('pointermove', this._onWeightPointerMoveBound, true);
    window.addEventListener('pointerup', this._onWeightPointerUpBound, true);
  }

  _detachWeightPaintCanvasEvents() {
    const dom = this._weightCanvasBound;
    if (dom) {
      dom.removeEventListener('pointerdown', this._onWeightPointerDownBound, true);
      dom.removeEventListener('pointermove', this._onWeightPointerMoveBound, true);
      this._weightCanvasBound = null;
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('pointerup', this._onWeightPointerUpBound, true);
    }
  }

  _hitToRestLocalPoint(skinnedMesh, hit) {
    const THREE = this.THREE;
    const posAttr = skinnedMesh?.geometry?.attributes?.position;
    if (posAttr && hit.face && typeof skinnedMesh.getVertexPosition === 'function') {
      const a = hit.face.a;
      const b = hit.face.b;
      const c = hit.face.c;
      if (a < posAttr.count && b < posAttr.count && c < posAttr.count) {
        const pa = skinnedMesh.getVertexPosition(a, new THREE.Vector3());
        const pb = skinnedMesh.getVertexPosition(b, new THREE.Vector3());
        const pc = skinnedMesh.getVertexPosition(c, new THREE.Vector3());
        const hitLocal = skinnedMesh.worldToLocal(hit.point.clone());
        const bary = new THREE.Vector3();
        if (THREE.Triangle.getBarycoord(hitLocal, pa, pb, pc, bary)) {
          if (Number.isFinite(bary.x) && Number.isFinite(bary.y) && Number.isFinite(bary.z)) {
            return new THREE.Vector3(
              posAttr.getX(a) * bary.x + posAttr.getX(b) * bary.y + posAttr.getX(c) * bary.z,
              posAttr.getY(a) * bary.x + posAttr.getY(b) * bary.y + posAttr.getY(c) * bary.z,
              posAttr.getZ(a) * bary.x + posAttr.getZ(b) * bary.y + posAttr.getZ(c) * bary.z,
            );
          }
        }
      }
    }
    skinnedMesh.updateMatrixWorld(true);
    return skinnedMesh.worldToLocal(hit.point.clone());
  }

  _raycastWeightMesh(clientX, clientY) {
    const eng = this._getEngine();
    const camera = eng?.camera;
    const dom = eng?.renderer?.domElement;
    if (!camera || !dom || !this.weightPaintMesh) return null;

    const rect = dom.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    this._weightPointer.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    );
    this._weightRaycaster.setFromCamera(this._weightPointer, camera);

    this.weightPaintMesh.updateMatrixWorld(true);
    const hits = this._weightRaycaster.intersectObject(this.weightPaintMesh, false);
    if (!hits || hits.length === 0) return null;
    const meshHit = hits[0];

    // If user clicks a bone handle closer/explicitly, allow bone selection instead of painting
    if (this.jointHandlesGroup && !this._isWeightBrushing) {
      const jointHits = this._weightRaycaster.intersectObject(this.jointHandlesGroup, true);
      if (jointHits.length > 0 && jointHits[0].distance <= meshHit.distance + 0.08) {
        return null;
      }
    }
    return meshHit;
  }

  _handleWeightPointerDown(e) {
    if (!this.isWeightPaintMode || !this.weightPaintMesh) return;
    if (e.button !== 0 || e.altKey || e.metaKey) return;
    const eng = this._getEngine();
    if (eng?.transformControls?.dragging || eng?.transformControls?.axis) return;

    this.weightPaintMesh.computeBoundingSphere?.();
    const hit = this._raycastWeightMesh(e.clientX, e.clientY);
    if (!hit) return;

    const geom = this.weightPaintMesh.geometry;
    const skinIdx = geom?.attributes?.skinIndex;
    const skinW = geom?.attributes?.skinWeight;
    const bone = this.activeBone || this.weightPaintMesh.skeleton?.bones?.[0];
    if (!skinIdx || !skinW || !bone) return;

    e.stopImmediatePropagation?.();
    e.stopPropagation();

    this._isWeightBrushing = true;
    this._weightStrokeConsumed = true;
    this._strokeStartSkinIndices = new Uint16Array(skinIdx.array);
    this._strokeStartSkinWeights = new Float32Array(skinW.array);

    if (eng?.controls) eng.controls.enabled = false;

    this._updateWeightCursor(hit);
    const restLocalPt = this._hitToRestLocalPoint(this.weightPaintMesh, hit);
    this.paintWeight(
      this.weightPaintMesh,
      bone,
      hit.point,
      this.weightBrush.radius,
      this.weightBrush.strength,
      this.weightBrush.mode,
      { localPoint: restLocalPt, symmetryX: this.weightBrush.symmetryX }
    );
  }

  _handleWeightPointerMove(e) {
    if (!this.isWeightPaintMode || !this.weightPaintMesh) return;
    const hit = this._raycastWeightMesh(e.clientX, e.clientY);
    if (hit) {
      this._updateWeightCursor(hit);
    } else {
      this._hideWeightCursor();
    }

    if (!this._isWeightBrushing || !hit) return;
    e.stopImmediatePropagation?.();
    e.stopPropagation();

    const bone = this.activeBone || this.weightPaintMesh.skeleton?.bones?.[0];
    if (!bone) return;
    const restLocalPt = this._hitToRestLocalPoint(this.weightPaintMesh, hit);
    this.paintWeight(
      this.weightPaintMesh,
      bone,
      hit.point,
      this.weightBrush.radius,
      this.weightBrush.strength,
      this.weightBrush.mode,
      { localPoint: restLocalPt, symmetryX: this.weightBrush.symmetryX }
    );
  }

  _handleWeightPointerUp() {
    if (!this._isWeightBrushing) {
      this._weightStrokeConsumed = false;
      return;
    }
    this._isWeightBrushing = false;
    setTimeout(() => {
      this._weightStrokeConsumed = false;
    }, 0);

    const eng = this._getEngine();
    if (eng?.controls) eng.controls.enabled = true;

    const mesh = this.weightPaintMesh;
    const geom = mesh?.geometry;
    const bone = this.activeBone || mesh?.skeleton?.bones?.[0] || null;
    if (mesh && geom?.attributes?.skinIndex && geom?.attributes?.skinWeight && this._strokeStartSkinWeights) {
      const curIdx = geom.attributes.skinIndex.array;
      const curW = geom.attributes.skinWeight.array;
      let changed = false;
      for (let i = 0; i < curW.length; i++) {
        if (Math.abs(curW[i] - this._strokeStartSkinWeights[i]) > 1e-6 || curIdx[i] !== this._strokeStartSkinIndices[i]) {
          changed = true;
          break;
        }
      }
      const sm = this._getSceneManager();
      if (changed) {
        syncVertexGroupsFromSkinAttributes(mesh);
      }
      if (changed && sm?.executeCommand) {
        const cmd = new WeightPaintCommand(
          mesh,
          bone,
          this._strokeStartSkinIndices,
          this._strokeStartSkinWeights,
          curIdx,
          curW,
          (m, b) => {
            if (this.isWeightPaintMode && this.weightPaintMesh === m) {
              this.updateWeightPaint(b || this.activeBone);
            }
          },
          `Weight Paint (${this.weightBrush.mode})`
        );
        sm.executeCommand(cmd);
      }
    }

    this._strokeStartSkinIndices = null;
    this._strokeStartSkinWeights = null;
  }

  /**
   * Recalculates vertex color heatmap for the selected bone
   */
  updateWeightPaint(bone = null) {
    if (!this.isWeightPaintMode || !this.weightPaintMesh) return;
    const mesh = this.weightPaintMesh;
    const geom = mesh.geometry;
    const skeleton = mesh.skeleton;
    if (!geom || !skeleton) return;

    let targetBone = bone || this.activeBone || skeleton.bones[0];
    let boneIndex = -1;
    if (typeof targetBone === 'number') {
      boneIndex = targetBone;
      targetBone = skeleton.bones[boneIndex] || skeleton.bones[0];
    } else if (typeof targetBone === 'string') {
      boneIndex = skeleton.bones.findIndex(b => b.name.toLowerCase() === targetBone.toLowerCase());
      if (boneIndex !== -1) targetBone = skeleton.bones[boneIndex];
    } else if (targetBone && targetBone.isBone) {
      boneIndex = skeleton.bones.indexOf(targetBone);
      if (boneIndex === -1) {
        boneIndex = skeleton.bones.findIndex(b => b.name === targetBone.name);
      }
    }
    if (boneIndex === -1) return;

    const skinIndexAttr = geom.attributes.skinIndex;
    const skinWeightAttr = geom.attributes.skinWeight;
    const posAttr = geom.attributes.position;
    if (!skinIndexAttr || !skinWeightAttr || !posAttr) return;

    const vertexCount = posAttr.count;
    let colorAttr = geom.attributes.color;
    if (!colorAttr || colorAttr.count !== vertexCount) {
      const colors = new Float32Array(vertexCount * 3);
      colorAttr = new this.THREE.BufferAttribute(colors, 3);
      geom.setAttribute('color', colorAttr);
    }

    const colors = colorAttr.array;
    const tmpColor = new this.THREE.Color();

    for (let i = 0; i < vertexCount; i++) {
      let weight = 0.0;
      for (let j = 0; j < 4; j++) {
        const idx = skinIndexAttr.getComponent(i, j);
        if (idx === boneIndex) {
          weight += skinWeightAttr.getComponent(i, j);
        }
      }
      weight = Math.max(0.0, Math.min(1.0, weight));
      this._getBlenderHeatmapColor(weight, tmpColor);
      colors[i * 3 + 0] = tmpColor.r;
      colors[i * 3 + 1] = tmpColor.g;
      colors[i * 3 + 2] = tmpColor.b;
    }

    colorAttr.needsUpdate = true;
  }

  _getBlenderHeatmapColor(w, colorOut) {
    w = Math.max(0.0, Math.min(1.0, w));
    if (w <= 0.25) {
      const t = w / 0.25;
      colorOut.setRGB(0.0, 0.7 * t, 0.8 + 0.2 * t);
    } else if (w <= 0.5) {
      const t = (w - 0.25) / 0.25;
      colorOut.setRGB(0.0, 0.7 + 0.3 * t, 1.0 - 0.9 * t);
    } else if (w <= 0.75) {
      const t = (w - 0.5) / 0.25;
      colorOut.setRGB(t, 1.0 - 0.1 * t, 0.1 * (1.0 - t));
    } else {
      const t = (w - 0.75) / 0.25;
      colorOut.setRGB(1.0, 0.9 * (1.0 - t), 0.0);
    }
    return colorOut;
  }

  _findMirrorBoneIndex(skeleton, boneIdx) {
    const bones = skeleton?.bones;
    if (!bones || !bones[boneIdx]) return boneIdx;
    const name = bones[boneIdx].name || '';
    const clean = RigSystem.cleanBoneName(name);
    const swapPairs = [
      [/Left/g, 'Right', /Right/g, 'Left'],
      [/left/g, 'right', /right/g, 'left'],
      [/\.L$/g, '.R', /\.R$/g, '.L'],
      [/\.l$/g, '.r', /\.r$/g, '.l'],
      [/_L$/g, '_R', /_R$/g, '_L'],
      [/_l$/g, '_r', /_r$/g, '_l'],
      [/^L_/g, 'R_', /^R_/g, 'L_'],
      [/^l_/g, 'r_', /^r_/g, 'l_'],
      [/_L_/g, '_R_', /_R_/g, '_L_'],
      [/_l_/g, '_r_', /_r_/g, '_l_'],
      [/J_Bip_L_/gi, 'J_Bip_R_', /J_Bip_R_/gi, 'J_Bip_L_'],
    ];

    const candidates = new Set();
    for (const [reL, repL, reR, repR] of swapPairs) {
      if (reL.test(name)) candidates.add(name.replace(reL, repL));
      else if (reR.test(name)) candidates.add(name.replace(reR, repR));
      if (reL.test(clean)) candidates.add(clean.replace(reL, repL));
      else if (reR.test(clean)) candidates.add(clean.replace(reR, repR));
    }
    if (candidates.size === 0) return boneIdx;

    for (let i = 0; i < bones.length; i++) {
      if (i === boneIdx) continue;
      const bn = bones[i].name;
      const bc = RigSystem.cleanBoneName(bn);
      if (candidates.has(bn) || candidates.has(bc)) {
        return i;
      }
    }
    const candidatesLower = new Set(Array.from(candidates).map(c => c.toLowerCase()));
    for (let i = 0; i < bones.length; i++) {
      if (i === boneIdx) continue;
      const bn = bones[i].name.toLowerCase();
      const bc = RigSystem.cleanBoneName(bn).toLowerCase();
      if (candidatesLower.has(bn) || candidatesLower.has(bc)) {
        return i;
      }
    }
    return boneIdx;
  }

  _buildVertexAdjacency(geom) {
    if (!geom?.attributes?.position) return null;
    const cached = this._weightAdjacencyCache.get(geom);
    if (cached && cached.vertexCount === geom.attributes.position.count) {
      return cached;
    }

    const pos = geom.attributes.position;
    const n = pos.count;
    const neighbors = Array.from({ length: n }, () => new Set());
    const idx = geom.index;

    const addEdge = (a, b) => {
      if (a === b || a < 0 || b < 0 || a >= n || b >= n) return;
      neighbors[a].add(b);
      neighbors[b].add(a);
    };

    if (idx) {
      for (let i = 0; i + 2 < idx.count; i += 3) {
        const a = idx.getX(i), b = idx.getX(i + 1), c = idx.getX(i + 2);
        addEdge(a, b);
        addEdge(b, c);
        addEdge(c, a);
      }
    } else {
      for (let i = 0; i + 2 < n; i += 3) {
        addEdge(i, i + 1);
        addEdge(i + 1, i + 2);
        addEdge(i + 2, i);
      }
    }

    // Group UV/split seam twins sharing identical rest coordinates
    const bucket = new Map();
    for (let i = 0; i < n; i++) {
      const k = `${Math.round(pos.getX(i) * 1e4)}_${Math.round(pos.getY(i) * 1e4)}_${Math.round(pos.getZ(i) * 1e4)}`;
      let list = bucket.get(k);
      if (!list) {
        list = [];
        bucket.set(k, list);
      }
      list.push(i);
    }
    const twins = Array.from({ length: n }, (_, i) => {
      const k = `${Math.round(pos.getX(i) * 1e4)}_${Math.round(pos.getY(i) * 1e4)}_${Math.round(pos.getZ(i) * 1e4)}`;
      return bucket.get(k) || [i];
    });
    for (let i = 0; i < n; i++) {
      for (const tw of twins[i]) {
        if (tw !== i) {
          for (const nb of neighbors[tw]) neighbors[i].add(nb);
        }
      }
    }

    const entry = {
      vertexCount: n,
      neighbors: neighbors.map((s) => Array.from(s)),
      twins,
    };
    this._weightAdjacencyCache.set(geom, entry);
    return entry;
  }

  _getVertexBoneWeight(skinIndexAttr, skinWeightAttr, vertIdx, boneIdx) {
    let w = 0;
    for (let s = 0; s < 4; s++) {
      if (skinIndexAttr.getComponent(vertIdx, s) === boneIdx) {
        w += skinWeightAttr.getComponent(vertIdx, s);
      }
    }
    return w;
  }

  _applyVertexBoneWeight(skinIndexAttr, skinWeightAttr, vertIdx, boneIdx, targetWeight, fallbackBoneIdx = 0) {
    const targetW = Math.max(0.0, Math.min(1.0, targetWeight));
    const indices = [
      skinIndexAttr.getX(vertIdx),
      skinIndexAttr.getY(vertIdx),
      skinIndexAttr.getZ(vertIdx),
      skinIndexAttr.getW(vertIdx)
    ];
    const weights = [
      skinWeightAttr.getX(vertIdx),
      skinWeightAttr.getY(vertIdx),
      skinWeightAttr.getZ(vertIdx),
      skinWeightAttr.getW(vertIdx)
    ];

    // Collapse any duplicate slots of boneIdx first
    let primarySlot = -1;
    for (let s = 0; s < 4; s++) {
      if (indices[s] === boneIdx) {
        if (primarySlot === -1) {
          primarySlot = s;
        } else {
          weights[primarySlot] += weights[s];
          weights[s] = 0;
        }
      }
    }

    if (primarySlot === -1) {
      if (targetW <= 1e-6) return false;
      let minSlot = 0;
      for (let s = 1; s < 4; s++) {
        if (weights[s] < weights[minSlot]) minSlot = s;
      }
      primarySlot = minSlot;
      indices[primarySlot] = boneIdx;
      weights[primarySlot] = 0;
    }

    let otherSum = 0;
    for (let s = 0; s < 4; s++) {
      if (s !== primarySlot) otherSum += Math.max(0, weights[s]);
    }

    const rem = 1.0 - targetW;
    if (otherSum > 1e-5) {
      const scale = rem / otherSum;
      for (let s = 0; s < 4; s++) {
        weights[s] = s === primarySlot ? targetW : Math.max(0, weights[s]) * scale;
      }
    } else if (rem > 1e-5 && fallbackBoneIdx !== boneIdx && fallbackBoneIdx >= 0) {
      // Transfer subtracted weight cleanly to parent / fallback bone
      let fbSlot = -1;
      for (let s = 0; s < 4; s++) {
        if (s !== primarySlot && indices[s] === fallbackBoneIdx) {
          fbSlot = s;
          break;
        }
      }
      if (fbSlot === -1) {
        fbSlot = primarySlot === 0 ? 1 : 0;
      }
      for (let s = 0; s < 4; s++) {
        if (s === primarySlot) {
          weights[s] = targetW;
        } else if (s === fbSlot) {
          indices[s] = fallbackBoneIdx;
          weights[s] = rem;
        } else {
          weights[s] = 0;
        }
      }
    } else {
      for (let s = 0; s < 4; s++) {
        weights[s] = s === primarySlot ? 1.0 : 0.0;
      }
    }

    skinIndexAttr.setXYZW(vertIdx, indices[0], indices[1], indices[2], indices[3]);
    skinWeightAttr.setXYZW(vertIdx, weights[0], weights[1], weights[2], weights[3]);
    return true;
  }

  /**
   * Interactive Weight Paint Brush (Blender Weight Brush)
   * Supports 'add' | 'subtract' | 'replace' | 'smooth' modes + optional symmetryX & posed barycentric rest point.
   */
  paintWeight(mesh, bone, worldPoint, radius = 0.25, strength = 0.5, mode = 'add', options = {}) {
    const THREE = this.THREE;
    const targetMesh = mesh || this.weightPaintMesh;
    if (!targetMesh || !targetMesh.isSkinnedMesh) {
      console.warn('[RigSystem] paintWeight: Target must be a SkinnedMesh.');
      return { updatedVertices: 0 };
    }

    const skeleton = targetMesh.skeleton || this.activeSkeleton;
    if (!skeleton || !skeleton.bones || skeleton.bones.length === 0) return { updatedVertices: 0 };

    let targetBone = null;
    let boneIdx = -1;
    if (typeof bone === 'number') {
      boneIdx = bone;
      targetBone = skeleton.bones[boneIdx];
    } else if (typeof bone === 'string') {
      boneIdx = skeleton.bones.findIndex(b => b.name.toLowerCase() === bone.toLowerCase());
      targetBone = skeleton.bones[boneIdx];
    } else if (bone && bone.isBone) {
      targetBone = bone;
      boneIdx = skeleton.bones.indexOf(bone);
      if (boneIdx === -1) boneIdx = skeleton.bones.findIndex(b => b.name === bone.name);
    }

    if (boneIdx === -1 || !targetBone) {
      console.warn('[RigSystem] paintWeight: Target bone not found in mesh skeleton.');
      return { updatedVertices: 0 };
    }

    const geom = targetMesh.geometry;
    const posAttr = geom.attributes.position;
    const skinIndexAttr = geom.attributes.skinIndex;
    const skinWeightAttr = geom.attributes.skinWeight;
    if (!posAttr || !skinIndexAttr || !skinWeightAttr) return { updatedVertices: 0 };

    let localBrushCenter;
    if (options?.localPoint?.isVector3) {
      localBrushCenter = options.localPoint.clone();
    } else {
      const brushCenter = Array.isArray(worldPoint)
        ? new THREE.Vector3(...worldPoint)
        : (worldPoint?.isVector3 ? worldPoint : new THREE.Vector3());
      targetMesh.updateMatrixWorld(true);
      localBrushCenter = targetMesh.worldToLocal(brushCenter.clone());
    }

    // Adapt world radius cleanly to mesh local scale (supports 0.01 Mixamo rigs and 1.0 unit rigs)
    targetMesh.updateMatrixWorld(true);
    const worldScale = new THREE.Vector3();
    targetMesh.getWorldScale(worldScale);
    const avgScale = Math.max(1e-4, (Math.abs(worldScale.x) + Math.abs(worldScale.y) + Math.abs(worldScale.z)) / 3);
    const localRadius = Math.max(1e-5, radius / avgScale);

    const applyStrokeForBone = (centerLocal, bIdx) => {
      const parentBone = skeleton.bones[bIdx]?.parent;
      let fallbackIdx = parentBone?.isBone ? skeleton.bones.indexOf(parentBone) : -1;
      if (fallbackIdx === -1 || fallbackIdx === bIdx) {
        fallbackIdx = bIdx === 0 && skeleton.bones.length > 1 ? 1 : 0;
      }

      const vertexCount = posAttr.count;
      const tempV = new THREE.Vector3();
      const adj = mode === 'smooth' ? this._buildVertexAdjacency(geom) : null;
      const preWeights = mode === 'smooth'
        ? Float32Array.from({ length: vertexCount }, (_, vi) => this._getVertexBoneWeight(skinIndexAttr, skinWeightAttr, vi, bIdx))
        : null;

      let count = 0;
      for (let i = 0; i < vertexCount; i++) {
        tempV.fromBufferAttribute(posAttr, i);
        const dist = tempV.distanceTo(centerLocal);
        if (dist > localRadius) continue;

        const t = dist / localRadius;
        const falloff = 0.5 * (1 + Math.cos(Math.PI * t)) * Math.max(0, Math.min(1, strength));
        const curW = preWeights ? preWeights[i] : this._getVertexBoneWeight(skinIndexAttr, skinWeightAttr, i, bIdx);

        let nextW = curW;
        if (mode === 'subtract') {
          nextW = Math.max(0.0, curW - falloff);
        } else if (mode === 'replace') {
          const factor = 0.5 * (1 + Math.cos(Math.PI * t));
          nextW = curW + (Math.max(0, Math.min(1, strength)) - curW) * factor;
        } else if (mode === 'smooth' && adj) {
          const nbs = adj.neighbors[i];
          if (nbs.length > 0) {
            let sum = 0;
            for (let k = 0; k < nbs.length; k++) sum += preWeights[nbs[k]];
            const avg = sum / nbs.length;
            nextW = curW + (avg - curW) * falloff;
          }
        } else {
          // 'add'
          nextW = Math.min(1.0, curW + falloff);
        }

        if (this._applyVertexBoneWeight(skinIndexAttr, skinWeightAttr, i, bIdx, nextW, fallbackIdx)) {
          count++;
        }
      }
      return count;
    };

    let updatedCount = applyStrokeForBone(localBrushCenter, boneIdx);

    if (options?.symmetryX) {
      const mirrorCenter = localBrushCenter.clone();
      mirrorCenter.x = -mirrorCenter.x;
      const mirrorBoneIdx = this._findMirrorBoneIndex(skeleton, boneIdx);
      if (mirrorBoneIdx !== boneIdx || mirrorCenter.distanceToSquared(localBrushCenter) > 1e-8) {
        updatedCount += applyStrokeForBone(mirrorCenter, mirrorBoneIdx);
      }
    }

    if (updatedCount > 0) {
      skinIndexAttr.needsUpdate = true;
      skinWeightAttr.needsUpdate = true;
      if (this.isWeightPaintMode && !options?.skipHeatmapUpdate) {
        this.updateWeightPaint(targetBone);
      }
    }

    return { updatedVertices: updatedCount };
  }

  brushWeight(mesh, bone, worldPoint, radius, strength, mode, options = {}) {
    return this.paintWeight(mesh, bone, worldPoint, radius, strength, mode, options);
  }

  /**
   * Normalizes all vertex weights on a SkinnedMesh so every vertex sums to 1.0 and uses valid bone indices.
   */
  normalizeWeights(mesh = null, recordUndo = false) {
    const targetMesh = mesh || this.weightPaintMesh || this.activeCharacter;
    const geom = targetMesh?.geometry;
    const skinIdx = geom?.attributes?.skinIndex;
    const skinW = geom?.attributes?.skinWeight;
    const boneCount = targetMesh?.skeleton?.bones?.length || 1;
    if (!skinIdx || !skinW) return { vertexCount: 0, normalizedCount: 0 };

    const oldIdx = recordUndo ? new Uint16Array(skinIdx.array) : null;
    const oldW = recordUndo ? new Float32Array(skinW.array) : null;

    const n = geom.attributes.position.count;
    let normalizedCount = 0;

    for (let i = 0; i < n; i++) {
      const idxs = [skinIdx.getX(i), skinIdx.getY(i), skinIdx.getZ(i), skinIdx.getW(i)];
      const ws = [skinW.getX(i), skinW.getY(i), skinW.getZ(i), skinW.getW(i)];

      // Clamp valid indices & non-negative weights, collapse duplicate bone indices
      for (let s = 0; s < 4; s++) {
        if (idxs[s] < 0 || idxs[s] >= boneCount || !Number.isFinite(ws[s]) || ws[s] <= 0) {
          ws[s] = 0;
          idxs[s] = Math.max(0, Math.min(boneCount - 1, idxs[s] || 0));
        }
        for (let t = 0; t < s; t++) {
          if (idxs[s] === idxs[t] && ws[s] > 0) {
            ws[t] += ws[s];
            ws[s] = 0;
          }
        }
      }

      const sum = ws[0] + ws[1] + ws[2] + ws[3];
      if (sum <= 1e-6) {
        skinIdx.setXYZW(i, 0, 0, 0, 0);
        skinW.setXYZW(i, 1, 0, 0, 0);
        normalizedCount++;
      } else {
        if (Math.abs(sum - 1.0) > 1e-5) normalizedCount++;
        const inv = 1.0 / sum;
        skinIdx.setXYZW(i, idxs[0], idxs[1], idxs[2], idxs[3]);
        skinW.setXYZW(i, ws[0] * inv, ws[1] * inv, ws[2] * inv, ws[3] * inv);
      }
    }

    skinIdx.needsUpdate = true;
    skinW.needsUpdate = true;
    if (normalizedCount > 0) syncVertexGroupsFromSkinAttributes(targetMesh);
    if (this.isWeightPaintMode && this.weightPaintMesh === targetMesh) {
      this.updateWeightPaint(this.activeBone);
    }

    const sm = this._getSceneManager();
    if (recordUndo && sm?.executeCommand && normalizedCount > 0) {
      sm.executeCommand(new WeightPaintCommand(
        targetMesh,
        this.activeBone,
        oldIdx,
        oldW,
        skinIdx.array,
        skinW.array,
        (m, b) => { if (this.isWeightPaintMode && this.weightPaintMesh === m) this.updateWeightPaint(b); },
        'Normalize Weights'
      ));
    }
    return { vertexCount: n, normalizedCount };
  }

  /**
   * Topological Laplacian smoothing for bone weights (single bone or full mesh).
   */
  smoothWeights(mesh = null, bone = null, iterations = 1, factor = 0.5, recordUndo = true) {
    const targetMesh = mesh || this.weightPaintMesh || this.activeCharacter;
    const geom = targetMesh?.geometry;
    const skeleton = targetMesh?.skeleton || this.activeSkeleton;
    const pos = geom?.attributes?.position;
    const skinIdx = geom?.attributes?.skinIndex;
    const skinW = geom?.attributes?.skinWeight;
    if (!pos || !skinIdx || !skinW || !skeleton?.bones?.length) return { updatedVertices: 0 };

    const adj = this._buildVertexAdjacency(geom);
    if (!adj) return { updatedVertices: 0 };

    let targetBoneIdx = -1;
    let targetBoneObj = null;
    if (bone !== null && bone !== undefined) {
      targetBoneObj = this._resolveBoneArg(skeleton, bone);
      targetBoneIdx = targetBoneObj ? skeleton.bones.indexOf(targetBoneObj) : -1;
    }

    const oldIdx = recordUndo ? new Uint16Array(skinIdx.array) : null;
    const oldW = recordUndo ? new Float32Array(skinW.array) : null;

    const n = pos.count;
    const iters = Math.max(1, Math.min(8, Math.round(iterations)));
    const alpha = Math.max(0.05, Math.min(1.0, factor));

    for (let it = 0; it < iters; it++) {
      if (targetBoneIdx !== -1) {
        const snap = Float32Array.from({ length: n }, (_, vi) =>
          this._getVertexBoneWeight(skinIdx, skinW, vi, targetBoneIdx)
        );
        const parentBone = skeleton.bones[targetBoneIdx]?.parent;
        let fallbackIdx = parentBone?.isBone ? skeleton.bones.indexOf(parentBone) : -1;
        if (fallbackIdx === -1 || fallbackIdx === targetBoneIdx) fallbackIdx = 0;
        for (let i = 0; i < n; i++) {
          const nbs = adj.neighbors[i];
          if (nbs.length === 0) continue;
          let sum = 0;
          for (let k = 0; k < nbs.length; k++) sum += snap[nbs[k]];
          const nextW = snap[i] + (sum / nbs.length - snap[i]) * alpha;
          this._applyVertexBoneWeight(skinIdx, skinW, i, targetBoneIdx, nextW, fallbackIdx);
        }
      } else {
        // Full-vertex smooth across all influencing bones
        const nextIndices = new Uint16Array(n * 4);
        const nextWeights = new Float32Array(n * 4);
        for (let i = 0; i < n; i++) {
          const nbs = adj.neighbors[i];
          if (nbs.length === 0) {
            for (let s = 0; s < 4; s++) {
              nextIndices[i * 4 + s] = skinIdx.getComponent(i, s);
              nextWeights[i * 4 + s] = skinW.getComponent(i, s);
            }
            continue;
          }
          const boneAcc = new Map();
          const invSelf = 1.0 - alpha;
          for (let s = 0; s < 4; s++) {
            const w = skinW.getComponent(i, s);
            if (w > 1e-6) {
              const bi = skinIdx.getComponent(i, s);
              boneAcc.set(bi, (boneAcc.get(bi) || 0) + w * invSelf);
            }
          }
          const nbShare = alpha / nbs.length;
          for (let k = 0; k < nbs.length; k++) {
            const nb = nbs[k];
            for (let s = 0; s < 4; s++) {
              const w = skinW.getComponent(nb, s);
              if (w > 1e-6) {
                const bi = skinIdx.getComponent(nb, s);
                boneAcc.set(bi, (boneAcc.get(bi) || 0) + w * nbShare);
              }
            }
          }
          const sorted = Array.from(boneAcc.entries()).sort((a, b) => b[1] - a[1]).slice(0, 4);
          let sum = 0;
          for (const [, w] of sorted) sum += w;
          const invSum = sum > 1e-6 ? 1.0 / sum : 1.0;
          for (let s = 0; s < 4; s++) {
            if (s < sorted.length) {
              nextIndices[i * 4 + s] = sorted[s][0];
              nextWeights[i * 4 + s] = sorted[s][1] * invSum;
            } else {
              nextIndices[i * 4 + s] = 0;
              nextWeights[i * 4 + s] = 0;
            }
          }
        }
        skinIdx.array.set(nextIndices);
        skinW.array.set(nextWeights);
      }
    }

    skinIdx.needsUpdate = true;
    skinW.needsUpdate = true;
    syncVertexGroupsFromSkinAttributes(targetMesh);
    if (this.isWeightPaintMode && this.weightPaintMesh === targetMesh) {
      this.updateWeightPaint(targetBoneObj || this.activeBone);
    }

    const sm = this._getSceneManager();
    if (recordUndo && sm?.executeCommand) {
      sm.executeCommand(new WeightPaintCommand(
        targetMesh,
        targetBoneObj || this.activeBone,
        oldIdx,
        oldW,
        skinIdx.array,
        skinW.array,
        (m, b) => { if (this.isWeightPaintMode && this.weightPaintMesh === m) this.updateWeightPaint(b); },
        'Smooth Weights'
      ));
    }
    return { updatedVertices: n };
  }

  /**
   * Mirrors skin weights across local X = 0 (Left <-> Right) swapping symmetric bones.
   */
  mirrorWeightsX(mesh = null, sourceSide = 'left', tolerance = null, recordUndo = true) {
    const targetMesh = mesh || this.weightPaintMesh || this.activeCharacter;
    const geom = targetMesh?.geometry;
    const skeleton = targetMesh?.skeleton || this.activeSkeleton;
    const pos = geom?.attributes?.position;
    const skinIdx = geom?.attributes?.skinIndex;
    const skinW = geom?.attributes?.skinWeight;
    if (!pos || !skinIdx || !skinW || !skeleton?.bones?.length) return { mirroredVertices: 0 };

    geom.computeBoundingBox();
    const size = geom.boundingBox.getSize(new this.THREE.Vector3());
    const maxDim = Math.max(0.01, size.x, size.y, size.z);
    const centerEps = maxDim * 1e-3;
    const tolSq = Math.pow(tolerance ?? maxDim * 0.08, 2);

    const oldIdx = recordUndo ? new Uint16Array(skinIdx.array) : null;
    const oldW = recordUndo ? new Float32Array(skinW.array) : null;

    const mirrorBoneTable = skeleton.bones.map((_, idx) => this._findMirrorBoneIndex(skeleton, idx));

    const srcFromLeft = sourceSide !== 'right';
    const srcVertices = [];
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      if ((srcFromLeft && x > centerEps) || (!srcFromLeft && x < -centerEps)) {
        srcVertices.push({ idx: i, x, y: pos.getY(i), z: pos.getZ(i) });
      }
    }

    let mirroredCount = 0;
    const newIndices = new Uint16Array(skinIdx.array);
    const newWeights = new Float32Array(skinW.array);

    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const isDst = (srcFromLeft && x < -centerEps) || (!srcFromLeft && x > centerEps);
      if (!isDst) continue;

      const wantedX = -x;
      const y = pos.getY(i);
      const z = pos.getZ(i);
      let bestSrc = -1;
      let bestDistSq = tolSq;

      for (let k = 0; k < srcVertices.length; k++) {
        const sv = srcVertices[k];
        const dx = sv.x - wantedX;
        const dy = sv.y - y;
        const dz = sv.z - z;
        const dSq = dx * dx + dy * dy + dz * dz;
        if (dSq <= bestDistSq) {
          bestDistSq = dSq;
          bestSrc = sv.idx;
        }
      }
      if (bestSrc === -1) continue;

      let sum = 0;
      const ws = [0, 0, 0, 0];
      const idxs = [0, 0, 0, 0];
      for (let s = 0; s < 4; s++) {
        const w = skinW.getComponent(bestSrc, s);
        const bi = skinIdx.getComponent(bestSrc, s);
        idxs[s] = mirrorBoneTable[bi] ?? bi;
        ws[s] = w;
        sum += w;
      }
      const inv = sum > 1e-6 ? 1.0 / sum : 1.0;
      for (let s = 0; s < 4; s++) {
        newIndices[i * 4 + s] = idxs[s];
        newWeights[i * 4 + s] = ws[s] * inv;
      }
      mirroredCount++;
    }

    if (mirroredCount > 0) {
      skinIdx.array.set(newIndices);
      skinW.array.set(newWeights);
      skinIdx.needsUpdate = true;
      skinW.needsUpdate = true;
      syncVertexGroupsFromSkinAttributes(targetMesh);

      if (this.isWeightPaintMode && this.weightPaintMesh === targetMesh) {
        this.updateWeightPaint(this.activeBone);
      }

      const sm = this._getSceneManager();
      if (recordUndo && sm?.executeCommand) {
        sm.executeCommand(new WeightPaintCommand(
          targetMesh,
          this.activeBone,
          oldIdx,
          oldW,
          skinIdx.array,
          skinW.array,
          (m, b) => { if (this.isWeightPaintMode && this.weightPaintMesh === m) this.updateWeightPaint(b); },
          'Mirror Weights X'
        ));
      }
    }
    return { mirroredVertices: mirroredCount };
  }

  /**
   * Prunes negligible bone weights below threshold, caps max influences per vertex (1..4), and renormalizes.
   */
  cleanWeights(mesh = null, threshold = 0.01, maxInfluences = 4, recordUndo = true) {
    const targetMesh = mesh || this.weightPaintMesh || this.activeCharacter;
    const skinIdx = targetMesh?.geometry?.attributes?.skinIndex;
    const skinW = targetMesh?.geometry?.attributes?.skinWeight;
    if (!skinIdx || !skinW) return { cleanedVertices: 0, removedSlots: 0 };

    const count = skinIdx.count;
    const cap = Math.max(1, Math.min(4, Math.floor(maxInfluences || 4)));
    const thresh = Math.max(0, Math.min(0.5, Number(threshold) || 0));

    const oldIdx = recordUndo ? new Uint16Array(skinIdx.array) : null;
    const oldW = recordUndo ? new Float32Array(skinW.array) : null;

    let cleanedVertices = 0;
    let removedSlots = 0;

    for (let i = 0; i < count; i++) {
      const pairs = [];
      let origMaxIdx = 0;
      let origMaxW = -1;
      for (let s = 0; s < 4; s++) {
        const idx = skinIdx.getComponent(i, s);
        const w = skinW.getComponent(i, s);
        if (w > origMaxW) {
          origMaxW = w;
          origMaxIdx = idx;
        }
        if (w >= thresh) {
          pairs.push({ idx, w });
        } else if (w > 1e-6) {
          removedSlots++;
        }
      }

      if (pairs.length === 0) {
        pairs.push({ idx: origMaxIdx, w: 1.0 });
      }
      pairs.sort((a, b) => b.w - a.w);
      if (pairs.length > cap) {
        removedSlots += (pairs.length - cap);
        pairs.length = cap;
      }

      let sum = 0;
      for (let k = 0; k < pairs.length; k++) sum += pairs[k].w;
      const inv = sum > 1e-6 ? 1.0 / sum : 1.0;

      let changed = false;
      for (let s = 0; s < 4; s++) {
        const nextIdx = s < pairs.length ? pairs[s].idx : 0;
        const nextW = s < pairs.length ? pairs[s].w * inv : 0;
        if (skinIdx.getComponent(i, s) !== nextIdx || Math.abs(skinW.getComponent(i, s) - nextW) > 1e-5) {
          changed = true;
        }
        skinIdx.setComponent(i, s, nextIdx);
        skinW.setComponent(i, s, nextW);
      }
      if (changed) cleanedVertices++;
    }

    skinIdx.needsUpdate = true;
    skinW.needsUpdate = true;
    if (cleanedVertices > 0) syncVertexGroupsFromSkinAttributes(targetMesh);
    if (this.isWeightPaintMode && this.weightPaintMesh === targetMesh) {
      this.updateWeightPaint(this.activeBone);
    }

    const sm = this._getSceneManager();
    if (recordUndo && cleanedVertices > 0 && sm?.executeCommand) {
      sm.executeCommand(new WeightPaintCommand(
        targetMesh,
        this.activeBone,
        oldIdx,
        oldW,
        skinIdx.array,
        skinW.array,
        (m, b) => { if (this.isWeightPaintMode && this.weightPaintMesh === m) this.updateWeightPaint(b); },
        'Clean Skin Weights'
      ));
    }

    return { cleanedVertices, removedSlots };
  }

  /**
   * Transfers skin weights and skeleton binding from a rigged source mesh onto a target mesh (e.g. clothing/accessories)
   * using closest-triangle barycentric surface interpolation.
   */
  transferWeights(sourceMesh, targetMesh, options = {}) {
    const THREE = this.THREE;
    const src = sourceMesh || this.activeCharacter;
    const srcSkinned = src?.isSkinnedMesh
      ? src
      : (src?.getObjectByProperty ? src.getObjectByProperty('isSkinnedMesh', true) : null);

    if (!srcSkinned?.geometry?.attributes?.skinIndex || !srcSkinned?.skeleton) {
      console.warn('[RigSystem] transferWeights requires a rigged SkinnedMesh source');
      return null;
    }
    if (!targetMesh?.isMesh || !targetMesh.geometry?.attributes?.position) {
      console.warn('[RigSystem] transferWeights target must be a Mesh with position attribute');
      return null;
    }

    srcSkinned.updateMatrixWorld(true);
    targetMesh.updateMatrixWorld(true);

    const srcGeom = srcSkinned.geometry;
    const srcPos = srcGeom.attributes.position;
    const srcIdx = srcGeom.index;
    const srcSkinIdx = srcGeom.attributes.skinIndex;
    const srcSkinW = srcGeom.attributes.skinWeight;

    const tgtGeom = targetMesh.geometry.clone();
    const tgtPos = tgtGeom.attributes.position;
    const tgtCount = tgtPos.count;

    // Map source vertices into world space for scale/transform-independent correspondence
    const srcVertWorld = new Float32Array(srcPos.count * 3);
    const tmp = new THREE.Vector3();
    for (let i = 0; i < srcPos.count; i++) {
      tmp.fromBufferAttribute(srcPos, i).applyMatrix4(srcSkinned.matrixWorld);
      srcVertWorld[i * 3] = tmp.x;
      srcVertWorld[i * 3 + 1] = tmp.y;
      srcVertWorld[i * 3 + 2] = tmp.z;
    }

    const triCount = srcIdx ? Math.floor(srcIdx.count / 3) : Math.floor(srcPos.count / 3);
    srcGeom.computeBoundingBox();
    const boxSize = srcGeom.boundingBox
      ? srcGeom.boundingBox.getSize(new THREE.Vector3()).multiplyScalar(srcSkinned.scale.y || 1)
      : new THREE.Vector3(1, 1.8, 1);
    const cellSize = Math.max(0.02, Math.max(boxSize.x, boxSize.y, boxSize.z) * 0.08);
    const invCell = 1.0 / cellSize;

    const grid = new Map();
    const triData = [];
    for (let t = 0; t < triCount; t++) {
      const a = srcIdx ? srcIdx.getX(t * 3) : t * 3;
      const b = srcIdx ? srcIdx.getX(t * 3 + 1) : t * 3 + 1;
      const c = srcIdx ? srcIdx.getX(t * 3 + 2) : t * 3 + 2;
      const cx = (srcVertWorld[a * 3] + srcVertWorld[b * 3] + srcVertWorld[c * 3]) / 3;
      const cy = (srcVertWorld[a * 3 + 1] + srcVertWorld[b * 3 + 1] + srcVertWorld[c * 3 + 1]) / 3;
      const cz = (srcVertWorld[a * 3 + 2] + srcVertWorld[b * 3 + 2] + srcVertWorld[c * 3 + 2]) / 3;
      const gx = Math.floor(cx * invCell);
      const gy = Math.floor(cy * invCell);
      const gz = Math.floor(cz * invCell);
      const key = `${gx}_${gy}_${gz}`;
      let list = grid.get(key);
      if (!list) {
        list = [];
        grid.set(key, list);
      }
      list.push(t);
      triData.push(a, b, c);
    }

    const dstIndices = new Uint16Array(tgtCount * 4);
    const dstWeights = new Float32Array(tgtCount * 4);
    const va = new THREE.Vector3();
    const vb = new THREE.Vector3();
    const vc = new THREE.Vector3();
    const tri = new THREE.Triangle();
    const closestPt = new THREE.Vector3();
    const bary = new THREE.Vector3();
    const boneAccum = new Map();

    const readTriIndices = (tIdx, ringRadius, candidates) => {
      const seen = new Set();
      candidates.length = 0;
      const gx = Math.floor(tmp.x * invCell);
      const gy = Math.floor(tmp.y * invCell);
      const gz = Math.floor(tmp.z * invCell);
      for (let dx = -ringRadius; dx <= ringRadius; dx++) {
        for (let dy = -ringRadius; dy <= ringRadius; dy++) {
          for (let dz = -ringRadius; dz <= ringRadius; dz++) {
            const list = grid.get(`${gx + dx}_${gy + dy}_${gz + dz}`);
            if (!list) continue;
            for (let k = 0; k < list.length; k++) {
              const ti = list[k];
              if (!seen.has(ti)) {
                seen.add(ti);
                candidates.push(ti);
              }
            }
          }
        }
      }
      return candidates.length;
    };

    const candidates = [];
    for (let i = 0; i < tgtCount; i++) {
      tmp.fromBufferAttribute(tgtPos, i).applyMatrix4(targetMesh.matrixWorld);

      let found = readTriIndices(i, 1, candidates);
      if (found === 0) found = readTriIndices(i, 3, candidates);

      let bestTri = -1;
      let bestDistSq = Infinity;
      const bestBary = [1, 0, 0];

      const scanList = found > 0 ? candidates : null;
      const scanLen = scanList ? scanList.length : triCount;
      for (let k = 0; k < scanLen; k++) {
        const t = scanList ? scanList[k] : k;
        const ia = triData[t * 3];
        const ib = triData[t * 3 + 1];
        const ic = triData[t * 3 + 2];
        va.set(srcVertWorld[ia * 3], srcVertWorld[ia * 3 + 1], srcVertWorld[ia * 3 + 2]);
        vb.set(srcVertWorld[ib * 3], srcVertWorld[ib * 3 + 1], srcVertWorld[ib * 3 + 2]);
        vc.set(srcVertWorld[ic * 3], srcVertWorld[ic * 3 + 1], srcVertWorld[ic * 3 + 2]);
        tri.set(va, vb, vc);
        tri.closestPointToPoint(tmp, closestPt);
        const dSq = tmp.distanceToSquared(closestPt);
        if (dSq < bestDistSq) {
          bestDistSq = dSq;
          bestTri = t;
          THREE.Triangle.getBarycoord(closestPt, va, vb, vc, bary);
          bestBary[0] = Math.max(0, bary.x || 0);
          bestBary[1] = Math.max(0, bary.y || 0);
          bestBary[2] = Math.max(0, bary.z || 0);
        }
      }

      if (bestTri < 0) continue;
      const triVerts = [triData[bestTri * 3], triData[bestTri * 3 + 1], triData[bestTri * 3 + 2]];
      const bSum = bestBary[0] + bestBary[1] + bestBary[2] || 1;
      boneAccum.clear();

      for (let v = 0; v < 3; v++) {
        const bw = bestBary[v] / bSum;
        if (bw <= 1e-6) continue;
        const sv = triVerts[v];
        for (let s = 0; s < 4; s++) {
          const w = srcSkinW.getComponent(sv, s) * bw;
          if (w <= 1e-6) continue;
          const bi = srcSkinIdx.getComponent(sv, s);
          boneAccum.set(bi, (boneAccum.get(bi) || 0) + w);
        }
      }

      const sorted = Array.from(boneAccum.entries()).sort((a, b) => b[1] - a[1]).slice(0, 4);
      let wSum = 0;
      for (let k = 0; k < sorted.length; k++) wSum += sorted[k][1];
      const invW = wSum > 1e-6 ? 1.0 / wSum : 1.0;

      for (let s = 0; s < 4; s++) {
        dstIndices[i * 4 + s] = s < sorted.length ? sorted[s][0] : 0;
        dstWeights[i * 4 + s] = s < sorted.length ? sorted[s][1] * invW : 0;
      }
    }

    tgtGeom.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(dstIndices, 4));
    tgtGeom.setAttribute('skinWeight', new THREE.Float32BufferAttribute(dstWeights, 4));

    const mat = targetMesh.material
      ? (Array.isArray(targetMesh.material) ? targetMesh.material.map(m => m.clone()) : targetMesh.material.clone())
      : new THREE.MeshStandardMaterial({ color: 0xcccccc });

    const skinnedTarget = new THREE.SkinnedMesh(tgtGeom, mat);
    skinnedTarget.name = targetMesh.name.replace(/_Skinned$/i, '') + '_Skinned';
    skinnedTarget.position.copy(targetMesh.position);
    skinnedTarget.rotation.copy(targetMesh.rotation);
    skinnedTarget.scale.copy(targetMesh.scale);
    skinnedTarget.castShadow = true;
    skinnedTarget.receiveShadow = true;
    skinnedTarget.bind(srcSkinned.skeleton);
    skinnedTarget.userData.isSkinnedCharacter = true;
    skinnedTarget.userData.skeleton = srcSkinned.skeleton;

    if (options?.smoothIterations > 0) {
      this.smoothWeights(skinnedTarget, null, options.smoothIterations, 0.35, false);
    }
    this.cleanWeights(skinnedTarget, 0.005, 4, false);

    return this._finalizeSkinnedMeshSwap(targetMesh, skinnedTarget, srcSkinned.skeleton, options, 'Transfer Weights');
  }

  _finalizeSkinnedMeshSwap(mesh, skinnedMesh, skeleton, options = {}, undoLabel = 'Auto-Skin Mesh') {
    const sm = this._getSceneManager();
    const recordUndo = options?.recordUndo !== false;
    const cmd = new AutoSkinCommand(this, mesh, skinnedMesh, skeleton, undoLabel);
    cmd.execute();
    syncVertexGroupsFromSkinAttributes(skinnedMesh);

    if (sm && recordUndo && typeof sm.executeCommand === 'function') {
      sm.executeCommand(cmd);
    }

    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('blender:mesh-skinned', {
        detail: { skinnedMesh, skeleton }
      }));
      if (window.codeEditor) {
        window.codeEditor.log('success', `✓ ${undoLabel} succeeded for [${mesh.name}]!`);
      }
    }
    return skinnedMesh;
  }

  // =========================================================================
  // 5. AUTO-SKINNING BINDING ENGINE (Geodesic Bone Heat + Seam Welding + Smooth)
  // =========================================================================

  /**
   * Automatically bind any mesh geometry to a skeleton with calculated vertex bone weights.
   * Uses seam-welded Surface-Geodesic Bone Heat (with normal facing check) by default so nearby
   * limbs/fingers do not cross-bleed weights through empty air.
   * Equivalent to Blender's "Ctrl+P -> With Automatic Weights"
   */
  autoSkinMesh(mesh, armatureOrSkeleton, options = {}) {
    const THREE = this.THREE;
    if (!mesh || !mesh.isMesh) {
      console.warn('[RigSystem] Target must be a THREE.Mesh');
      return null;
    }

    let skeleton = null;
    if (armatureOrSkeleton && armatureOrSkeleton.skeleton) {
      skeleton = armatureOrSkeleton.skeleton;
    } else if (armatureOrSkeleton && (armatureOrSkeleton.isSkeleton || Array.isArray(armatureOrSkeleton.bones))) {
      skeleton = armatureOrSkeleton;
    } else if (armatureOrSkeleton?.userData?.skeleton) {
      skeleton = armatureOrSkeleton.userData.skeleton;
    } else if (this.activeSkeleton) {
      skeleton = this.activeSkeleton;
    }

    if (!skeleton || !skeleton.bones || skeleton.bones.length === 0) {
      console.warn('[RigSystem] No skeleton found to bind to mesh');
      return null;
    }

    const scene = this.scene || (typeof window !== 'undefined' ? window.scene : null);
    const sm = this._getSceneManager();
    if (scene) scene.updateMatrixWorld(true);
    if (skeleton.bones && skeleton.bones.length > 0) {
      let rootNode = skeleton.bones[0];
      while (rootNode.parent) rootNode = rootNode.parent;
      if (!rootNode.parent && !rootNode.isScene && !rootNode.isBone && rootNode !== mesh) {
        if (sm && typeof sm.addObject === 'function') {
          sm.addObject(rootNode, null, false, false);
        } else if (scene && typeof scene.add === 'function') {
          scene.add(rootNode);
        }
      }
      rootNode.updateMatrixWorld(true);
    }
    if (mesh.parent) mesh.parent.updateMatrixWorld(true);
    mesh.updateMatrixWorld(true);

    // If mesh has low height resolution (e.g. cylinder with 1 height segment), regenerate with proper segments
    let sourceGeom = mesh.geometry;
    if (sourceGeom.parameters && sourceGeom.type === 'CylinderGeometry' && (sourceGeom.parameters.heightSegments || 1) <= 1) {
      const p = sourceGeom.parameters;
      sourceGeom = new THREE.CylinderGeometry(p.radiusTop, p.radiusBottom, p.height, p.radialSegments || 32, 16);
    }

    const geom = sourceGeom.clone();
    geom.computeVertexNormals();
    geom.computeBoundingBox();
    const posAttr = geom.attributes.position;
    const normAttr = geom.attributes.normal;
    const vertexCount = posAttr.count;
    const bboxSize = geom.boundingBox.getSize(new THREE.Vector3());
    const charScale = Math.max(0.05, bboxSize.y, bboxSize.x, bboxSize.z);
    const minEps = charScale * 0.014;
    const sideDeadband = charScale * 0.03;

    const invMeshMatrix = mesh.matrixWorld.clone().invert();

    // Calculate capsule bone segments in mesh coordinate space
    const boneInfos = skeleton.bones.map((bone, index) => {
      bone.updateMatrixWorld(true);
      const startWorld = new THREE.Vector3().setFromMatrixPosition(bone.matrixWorld);
      const startLocal = startWorld.clone().applyMatrix4(invMeshMatrix);

      const childBones = bone.children.filter(c => c.isBone);
      let endLocal;
      if (childBones.length === 1) {
        childBones[0].updateMatrixWorld(true);
        const endWorld = new THREE.Vector3().setFromMatrixPosition(childBones[0].matrixWorld);
        endLocal = endWorld.clone().applyMatrix4(invMeshMatrix);
      } else if (childBones.length > 1) {
        // Prefer central Spine/Neck child for torso hubs before falling back to first child
        const axialChild = childBones.find(c => /spine|neck|head|chest/i.test(c.name)) || childBones[0];
        axialChild.updateMatrixWorld(true);
        const endWorld = new THREE.Vector3().setFromMatrixPosition(axialChild.matrixWorld);
        endLocal = endWorld.clone().applyMatrix4(invMeshMatrix);
      } else if (bone.parent?.isBone) {
        bone.parent.updateMatrixWorld(true);
        const pWorld = new THREE.Vector3().setFromMatrixPosition(bone.parent.matrixWorld);
        const pLocal = pWorld.clone().applyMatrix4(invMeshMatrix);
        const dir = startLocal.clone().sub(pLocal);
        const len = dir.length();
        endLocal = len > 1e-4
          ? startLocal.clone().addScaledVector(dir.normalize(), Math.min(len * 0.45, charScale * 0.08))
          : startLocal.clone().add(new THREE.Vector3(0, charScale * 0.04, 0));
      } else {
        endLocal = startLocal.clone().add(new THREE.Vector3(0, charScale * 0.05, 0));
      }

      const midX = (startLocal.x + endLocal.x) * 0.5;
      const side = RigSystem.detectBoneSide(bone.name, midX, sideDeadband);

      return {
        index,
        bone,
        startLocal,
        endLocal,
        length: Math.max(1e-4, startLocal.distanceTo(endLocal)),
        side,
      };
    });

    const skinIndices = new Uint16Array(vertexCount * 4);
    const skinWeights = new Float32Array(vertexCount * 4);
    const tempV = new THREE.Vector3();
    const tempN = new THREE.Vector3();
    const tempSeg = new THREE.Line3();
    const closestPt = new THREE.Vector3();
    const vecFromBone = new THREE.Vector3();

    const boneCount = boneInfos.length;
    const skinMode = options?.mode || (vertexCount >= 6 && vertexCount <= 12000 ? 'heat' : 'geodesic');
    const useGeodesic = skinMode !== 'euclidean' && vertexCount >= 6;
    const adj = (useGeodesic && skinMode !== 'heat') ? this._buildVertexAdjacency(geom) : null;

    // Weld normals across coincident seam twins for consistent facing checks on cube/sharp edges
    let weldedNorms = null;
    if (normAttr && adj?.twins) {
      weldedNorms = new Float32Array(vertexCount * 3);
      for (let i = 0; i < vertexCount; i++) {
        let nx = 0, ny = 0, nz = 0;
        for (const tw of adj.twins[i]) {
          nx += normAttr.getX(tw);
          ny += normAttr.getY(tw);
          nz += normAttr.getZ(tw);
        }
        const nLen = Math.hypot(nx, ny, nz);
        if (nLen > 1e-6) {
          weldedNorms[i * 3] = nx / nLen;
          weldedNorms[i * 3 + 1] = ny / nLen;
          weldedNorms[i * 3 + 2] = nz / nLen;
        } else {
          weldedNorms[i * 3] = normAttr.getX(i);
          weldedNorms[i * 3 + 1] = normAttr.getY(i);
          weldedNorms[i * 3 + 2] = normAttr.getZ(i);
        }
      }
    }

    // Build uniform voxel grid of triangles for fast interior line-of-sight bone heat checks
    const idxAttrGeom = geom.index;
    const triCount = idxAttrGeom ? Math.floor(idxAttrGeom.count / 3) : Math.floor(vertexCount / 3);
    const useVisibilityRay = useGeodesic && triCount > 0 && triCount <= 65000;
    let triVerts = null;
    let triGrid = null;
    let rayStamp = null;
    let gridVoxelSize = 1;
    let gridInv = 1;
    let stampId = 0;

    if (useVisibilityRay) {
      triVerts = new Float32Array(triCount * 9);
      triGrid = new Map();
      rayStamp = new Int32Array(triCount);
      gridVoxelSize = Math.max(charScale / 12, 0.015);
      gridInv = 1.0 / gridVoxelSize;

      for (let t = 0; t < triCount; t++) {
        const ia = idxAttrGeom ? idxAttrGeom.getX(t * 3) : t * 3;
        const ib = idxAttrGeom ? idxAttrGeom.getX(t * 3 + 1) : t * 3 + 1;
        const ic = idxAttrGeom ? idxAttrGeom.getX(t * 3 + 2) : t * 3 + 2;
        const ax = posAttr.getX(ia), ay = posAttr.getY(ia), az = posAttr.getZ(ia);
        const bx = posAttr.getX(ib), by = posAttr.getY(ib), bz = posAttr.getZ(ib);
        const cx = posAttr.getX(ic), cy = posAttr.getY(ic), cz = posAttr.getZ(ic);
        const base = t * 9;
        triVerts[base] = ax; triVerts[base + 1] = ay; triVerts[base + 2] = az;
        triVerts[base + 3] = bx; triVerts[base + 4] = by; triVerts[base + 5] = bz;
        triVerts[base + 6] = cx; triVerts[base + 7] = cy; triVerts[base + 8] = cz;

        const minX = Math.floor(Math.min(ax, bx, cx) * gridInv);
        const maxX = Math.floor(Math.max(ax, bx, cx) * gridInv);
        const minY = Math.floor(Math.min(ay, by, cy) * gridInv);
        const maxY = Math.floor(Math.max(ay, by, cy) * gridInv);
        const minZ = Math.floor(Math.min(az, bz, cz) * gridInv);
        const maxZ = Math.floor(Math.max(az, bz, cz) * gridInv);
        for (let gx = minX; gx <= maxX; gx++) {
          for (let gy = minY; gy <= maxY; gy++) {
            for (let gz = minZ; gz <= maxZ; gz++) {
              const key = `${gx}_${gy}_${gz}`;
              let list = triGrid.get(key);
              if (!list) {
                list = [];
                triGrid.set(key, list);
              }
              list.push(t);
            }
          }
        }
      }
    }

    const isSegmentOccluded = (ox, oy, oz, tx, ty, tz) => {
      if (!useVisibilityRay) return false;
      const dx = tx - ox, dy = ty - oy, dz = tz - oz;
      const segLen = Math.hypot(dx, dy, dz);
      if (segLen < 1e-5) return false;
      const invLen = 1.0 / segLen;
      const rdx = dx * invLen, rdy = dy * invLen, rdz = dz * invLen;
      const tMin = segLen * 0.04;
      const tMax = segLen * 0.94;
      stampId++;

      const steps = Math.min(24, Math.max(1, Math.ceil(segLen * gridInv * 2)));
      let prevKey = '';
      for (let st = 0; st <= steps; st++) {
        const s = st / steps;
        const px = ox + dx * s;
        const py = oy + dy * s;
        const pz = oz + dz * s;
        const key = `${Math.floor(px * gridInv)}_${Math.floor(py * gridInv)}_${Math.floor(pz * gridInv)}`;
        if (key === prevKey) continue;
        prevKey = key;
        const list = triGrid.get(key);
        if (!list) continue;
        for (let k = 0; k < list.length; k++) {
          const ti = list[k];
          if (rayStamp[ti] === stampId) continue;
          rayStamp[ti] = stampId;
          const base = ti * 9;
          const ax = triVerts[base], ay = triVerts[base + 1], az = triVerts[base + 2];
          const e1x = triVerts[base + 3] - ax, e1y = triVerts[base + 4] - ay, e1z = triVerts[base + 5] - az;
          const e2x = triVerts[base + 6] - ax, e2y = triVerts[base + 7] - ay, e2z = triVerts[base + 8] - az;
          const hx = rdy * e2z - rdz * e2y;
          const hy = rdz * e2x - rdx * e2z;
          const hz = rdx * e2y - rdy * e2x;
          const det = e1x * hx + e1y * hy + e1z * hz;
          if (det > -1e-7 && det < 1e-7) continue;
          const invDet = 1.0 / det;
          const sx = ox - ax, sy = oy - ay, sz = oz - az;
          const u = invDet * (sx * hx + sy * hy + sz * hz);
          if (u < -1e-4 || u > 1.0001) continue;
          const qx = sy * e1z - sz * e1y;
          const qy = sz * e1x - sx * e1z;
          const qz = sx * e1y - sy * e1x;
          const v = invDet * (rdx * qx + rdy * qy + rdz * qz);
          if (v < -1e-4 || u + v > 1.0001) continue;
          const tHit = invDet * (e2x * qx + e2y * qy + e2z * qz);
          if (tHit > tMin && tHit < tMax) return true;
        }
      }
      return false;
    };

    let usedHeat = false;
    if (skinMode === 'heat' && boneCount > 0) {
      const symCenterX = (geom.boundingBox.min.x + geom.boundingBox.max.x) * 0.5;
      const heatRes = computeLaplacianBoneHeatWeights(
        geom,
        boneInfos.map((b) => ({
          index: b.index,
          startLocal: b.startLocal,
          endLocal: b.endLocal,
          side: b.side > 0 ? 'left' : (b.side < 0 ? 'right' : 'center'),
        })),
        {
          charScale,
          sideDeadband,
          symmetryCenterX: symCenterX,
          isSegmentOccluded,
        }
      );
      if (heatRes?.skinIndices && heatRes?.skinWeights) {
        skinIndices.set(heatRes.skinIndices);
        skinWeights.set(heatRes.skinWeights);
        usedHeat = true;
      }
    }

    if (!usedHeat) {
    // Step A: Evaluate per-vertex Euclidean capsule affinity, normal facing gate, visibility & seed assignment
    const euclidTop4Idx = new Int32Array(vertexCount * 4).fill(0);
    const euclidTop4Dist = new Float32Array(vertexCount * 4).fill(Infinity);
    const seedWinners = Array.from({ length: boneCount }, () => []);
    const boneBestFallback = Array.from({ length: boneCount }, () => ({ vert: -1, score: Infinity, rawD: Infinity }));
    const vertCands = new Array(boneCount);

    for (let i = 0; i < vertexCount; i++) {
      tempV.fromBufferAttribute(posAttr, i);
      if (weldedNorms) {
        tempN.set(weldedNorms[i * 3], weldedNorms[i * 3 + 1], weldedNorms[i * 3 + 2]);
      } else if (normAttr) {
        tempN.fromBufferAttribute(normAttr, i);
      }

      for (let bi = 0; bi < boneCount; bi++) {
        const b = boneInfos[bi];
        tempSeg.set(b.startLocal, b.endLocal);
        const param = tempSeg.closestPointToPointParameter(tempV, true);
        tempSeg.at(param, closestPt);
        vecFromBone.copy(tempV).sub(closestPt);
        const rawLen = vecFromBone.length();
        let d = rawLen;

        const insideSpan = param > 0.04 && param < 0.96;
        d *= insideSpan ? 0.86 : 1.12;

        if (b.side !== 0) {
          if (tempV.x > sideDeadband && b.side < 0) d *= 3.5;
          else if (tempV.x < -sideDeadband && b.side > 0) d *= 3.5;
        }

        let dotN = 1.0;
        if ((weldedNorms || normAttr) && rawLen > 1e-6) {
          dotN = (vecFromBone.x * tempN.x + vecFromBone.y * tempN.y + vecFromBone.z * tempN.z) / rawLen;
        }
        const facingMult = dotN < -0.15 ? 4.5 : (dotN < 0.05 ? 2.0 : 1.0);
        vertCands[bi] = {
          bi,
          boneIndex: b.index,
          rawD: d,
          seedScore: d * facingMult,
          dotN,
          cx: closestPt.x,
          cy: closestPt.y,
          cz: closestPt.z,
        };
      }

      // Rank candidates by raw seed score, then test line-of-sight on top 4 contenders
      vertCands.sort((a, b) => a.seedScore - b.seedScore);
      const topInspect = Math.min(4, boneCount);
      for (let c = 0; c < topInspect; c++) {
        const cand = vertCands[c];
        const occluded = isSegmentOccluded(cand.cx, cand.cy, cand.cz, tempV.x, tempV.y, tempV.z);
        cand.occluded = occluded;
        if (occluded) {
          cand.seedScore *= 8.0;
          cand.rawD *= 6.0;
        } else if (cand.dotN >= -0.05 && c === 0) {
          break;
        }
      }

      // Re-rank and store top-4 Euclidean fallback + pick single best seed bone
      vertCands.sort((a, b) => a.seedScore - b.seedScore);
      const best = vertCands[0];
      if (best && best.dotN >= -0.05) {
        seedWinners[best.bi].push({ vert: i, initDist: best.rawD });
      }
      for (let bi = 0; bi < boneCount; bi++) {
        const c = vertCands[bi];
        if (c.seedScore < boneBestFallback[c.bi].score) {
          boneBestFallback[c.bi].score = c.seedScore;
          boneBestFallback[c.bi].vert = i;
          boneBestFallback[c.bi].rawD = c.rawD;
        }
      }

      // Euclidean top-4 fallback ordered by rawD
      const rawTop = vertCands.slice(0, Math.min(8, boneCount)).sort((a, b) => a.rawD - b.rawD);
      for (let slot = 0; slot < 4; slot++) {
        if (slot < rawTop.length) {
          euclidTop4Dist[i * 4 + slot] = rawTop[slot].rawD;
          euclidTop4Idx[i * 4 + slot] = rawTop[slot].boneIndex;
        }
      }
    }

    let geoIdx = null;
    let geoDist = null;
    const geoReached = new Uint8Array(vertexCount);

    // Step B: Surface-Geodesic Dijkstra propagation along welded edges
    if (useGeodesic && adj?.neighbors) {
      geoIdx = new Int32Array(vertexCount * 4).fill(-1);
      geoDist = new Float32Array(vertexCount * 4).fill(Infinity);

      // Build compact CSR edge graph (seam twins linked with zero traversal cost)
      const edgeStarts = new Int32Array(vertexCount + 1);
      let totalEdges = 0;
      for (let i = 0; i < vertexCount; i++) {
        edgeStarts[i] = totalEdges;
        totalEdges += adj.neighbors[i].size + (adj.twins[i].length > 1 ? adj.twins[i].length - 1 : 0);
      }
      edgeStarts[vertexCount] = totalEdges;

      const edgeTo = new Int32Array(totalEdges);
      const edgeW = new Float32Array(totalEdges);
      let writeCursor = 0;
      for (let i = 0; i < vertexCount; i++) {
        const ax = posAttr.getX(i), ay = posAttr.getY(i), az = posAttr.getZ(i);
        for (const nb of adj.neighbors[i]) {
          edgeTo[writeCursor] = nb;
          const dx = posAttr.getX(nb) - ax;
          const dy = posAttr.getY(nb) - ay;
          const dz = posAttr.getZ(nb) - az;
          edgeW[writeCursor] = Math.sqrt(dx * dx + dy * dy + dz * dz);
          writeCursor++;
        }
        if (adj.twins[i].length > 1) {
          for (const tw of adj.twins[i]) {
            if (tw !== i) {
              edgeTo[writeCursor] = tw;
              edgeW[writeCursor] = 0;
              writeCursor++;
            }
          }
        }
      }

      const maxGeoRadius = charScale * 0.65;
      const distArr = new Float32Array(vertexCount);
      const visitedFlag = new Uint8Array(vertexCount);
      const touched = new Int32Array(vertexCount);
      const heapVert = new Int32Array(Math.max(64, vertexCount * 4));
      const heapDist = new Float32Array(Math.max(64, vertexCount * 4));

      for (let bi = 0; bi < boneCount; bi++) {
        let seeds = seedWinners[bi];
        if (seeds.length === 0 && boneBestFallback[bi].vert >= 0) {
          // Only seed empty-winner bones onto vertices not strongly back-facing if possible
          seeds = [{ vert: boneBestFallback[bi].vert, initDist: boneBestFallback[bi].rawD }];
        }
        if (seeds.length === 0) continue;

        distArr.fill(Infinity);
        visitedFlag.fill(0);
        let touchedLen = 0;
        let heapSize = 0;

        const heapPush = (v, d) => {
          if (heapSize >= heapVert.length) return;
          let idx = heapSize++;
          heapVert[idx] = v;
          heapDist[idx] = d;
          while (idx > 0) {
            const p = (idx - 1) >> 1;
            if (heapDist[p] <= heapDist[idx]) break;
            const tv = heapVert[p]; heapVert[p] = heapVert[idx]; heapVert[idx] = tv;
            const td = heapDist[p]; heapDist[p] = heapDist[idx]; heapDist[idx] = td;
            idx = p;
          }
        };

        const heapPop = () => {
          const topV = heapVert[0];
          const topD = heapDist[0];
          heapSize--;
          if (heapSize > 0) {
            heapVert[0] = heapVert[heapSize];
            heapDist[0] = heapDist[heapSize];
            let idx = 0;
            while (true) {
              let best = idx;
              const l = idx * 2 + 1;
              const r = l + 1;
              if (l < heapSize && heapDist[l] < heapDist[best]) best = l;
              if (r < heapSize && heapDist[r] < heapDist[best]) best = r;
              if (best === idx) break;
              const tv = heapVert[idx]; heapVert[idx] = heapVert[best]; heapVert[best] = tv;
              const td = heapDist[idx]; heapDist[idx] = heapDist[best]; heapDist[best] = td;
              idx = best;
            }
          }
          return [topV, topD];
        };

        for (let s = 0; s < seeds.length; s++) {
          const sv = seeds[s].vert;
          const sd = seeds[s].initDist;
          if (sd < distArr[sv]) {
            if (distArr[sv] === Infinity) touched[touchedLen++] = sv;
            distArr[sv] = sd;
            heapPush(sv, sd);
          }
        }

        const bSide = boneInfos[bi].side;
        while (heapSize > 0) {
          const [u, dU] = heapPop();
          if (visitedFlag[u] || dU > maxGeoRadius) continue;
          visitedFlag[u] = 1;

          const startE = edgeStarts[u];
          const endE = edgeStarts[u + 1];
          for (let e = startE; e < endE; e++) {
            const v = edgeTo[e];
            if (visitedFlag[v]) continue;
            // Side barrier reduces surface bleed across center sagittal seam for lateral limb bones
            let stepCost = edgeW[e];
            if (bSide !== 0 && stepCost > 0) {
              const vx = posAttr.getX(v);
              if ((bSide > 0 && vx < -sideDeadband) || (bSide < 0 && vx > sideDeadband)) {
                stepCost *= 3.0;
              }
            }
            const nd = dU + stepCost;
            if (nd < distArr[v] && nd <= maxGeoRadius) {
              if (distArr[v] === Infinity) touched[touchedLen++] = v;
              distArr[v] = nd;
              heapPush(v, nd);
            }
          }
        }

        const boneIndexVal = boneInfos[bi].index;
        for (let k = 0; k < touchedLen; k++) {
          const v = touched[k];
          const d = distArr[v];
          if (d === Infinity) continue;
          geoReached[v] = 1;
          for (let slot = 0; slot < 4; slot++) {
            if (d < geoDist[v * 4 + slot]) {
              for (let sh = 3; sh > slot; sh--) {
                geoDist[v * 4 + sh] = geoDist[v * 4 + sh - 1];
                geoIdx[v * 4 + sh] = geoIdx[v * 4 + sh - 1];
              }
              geoDist[v * 4 + slot] = d;
              geoIdx[v * 4 + slot] = boneIndexVal;
              break;
            }
          }
        }
      }
    }

    // Step C: Convert Top-4 distances per vertex into normalized heat weights
    const powerExp = useGeodesic ? 2.8 : 2.5;
    for (let i = 0; i < vertexCount; i++) {
      const hasGeo = useGeodesic && geoReached[i] === 1;
      let sumW = 0;
      const ws = [0, 0, 0, 0];
      const idxs = [0, 0, 0, 0];

      for (let s = 0; s < 4; s++) {
        const bIdx = hasGeo ? geoIdx[i * 4 + s] : euclidTop4Idx[i * 4 + s];
        const dist = hasGeo ? geoDist[i * 4 + s] : euclidTop4Dist[i * 4 + s];
        if (bIdx < 0 || !Number.isFinite(dist)) continue;
        const w = 1.0 / Math.pow(Math.max(dist, minEps), powerExp);
        idxs[s] = bIdx;
        ws[s] = w;
        sumW += w;
      }

      if (sumW <= 1e-6) {
        idxs[0] = euclidTop4Idx[i * 4];
        ws[0] = 1.0;
        sumW = 1.0;
      }

      for (let j = 0; j < 4; j++) {
        skinIndices[i * 4 + j] = idxs[j];
        skinWeights[i * 4 + j] = ws[j] / sumW;
      }
    }
    }

    geom.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndices, 4));
    geom.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeights, 4));

    const mat = mesh.material
      ? (Array.isArray(mesh.material) ? mesh.material.map(m => m.clone()) : mesh.material.clone())
      : new THREE.MeshStandardMaterial({ color: 0xcccccc });

    const skinnedMesh = new THREE.SkinnedMesh(geom, mat);
    skinnedMesh.name = mesh.name.replace(/_Skinned$/i, '') + '_Skinned';
    skinnedMesh.position.copy(mesh.position);
    skinnedMesh.rotation.copy(mesh.rotation);
    skinnedMesh.scale.copy(mesh.scale);
    skinnedMesh.castShadow = true;
    skinnedMesh.receiveShadow = true;

    skinnedMesh.bind(skeleton);
    skinnedMesh.userData.isSkinnedCharacter = true;
    skinnedMesh.userData.skeleton = skeleton;

    // Gentle seam-welded smoothing + tiny weight pruning keeps joints crisp without tearing
    if (!usedHeat) {
      this.smoothWeights(skinnedMesh, null, 2, 0.35, false);
    }
    this.cleanWeights(skinnedMesh, 0.005, 4, false);

    return this._finalizeSkinnedMeshSwap(mesh, skinnedMesh, skeleton, options, 'Auto-Skin Mesh');
  }

  // =========================================================================
  // 6. PROCEDURAL ARTICULATED MANNEQUIN GENERATOR
  // =========================================================================

  /**
   * Generates a fully rigged 3D Anatomical Wooden/Clay Mannequin ready for posing
   * @param {number|Object} [heightOrOptions=1.8]
   * @param {Object} [options={}]
   */
  createRiggedMannequin(heightOrOptions = 1.8, options = {}) {
    let height = 1.8;
    let opts = options;
    if (typeof heightOrOptions === 'object' && heightOrOptions !== null) {
      opts = heightOrOptions;
      height = opts.height || 1.8;
    } else if (typeof heightOrOptions === 'number') {
      height = heightOrOptions;
    }

    const isSkinned = opts.skinned !== false;
    const THREE = this.THREE;
    const { armatureGroup, skeleton, boneMap } = this.createHumanoidArmature(height);
    const scale = height / 1.8;

    const mannequinMat = new THREE.MeshStandardMaterial({
      color: 0xdfb180, // Natural beechwood / clay
      roughness: 0.65,
      metalness: 0.05
    });

    const jointMat = new THREE.MeshStandardMaterial({
      color: 0x5a4a42, // Dark mahogany ball joints
      roughness: 0.4,
      metalness: 0.2
    });

    const createPart = (geom, mat, bone, posOffset = { x: 0, y: 0, z: 0 }, rotOffset = { x: 0, y: 0, z: 0 }, partName = '') => {
      // If skinned is requested, skip creating separate rigid parts to avoid double-mesh layering
      if (isSkinned) return null;
      const mesh = new THREE.Mesh(geom, mat);
      mesh.name = partName || `Mannequin_${bone?.name || 'Part'}_Geo`;
      mesh.position.set(posOffset.x, posOffset.y, posOffset.z);
      mesh.rotation.set(rotOffset.x, rotOffset.y, rotOffset.z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      if (bone) bone.add(mesh);
      return mesh;
    };

    // 1. Pelvis / Hips
    const pelvisGeom = new THREE.CylinderGeometry(0.14 * scale, 0.11 * scale, 0.15 * scale, 16);
    createPart(pelvisGeom, mannequinMat, boneMap.get('Hips'), { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, 'Mannequin_Pelvis_Geo');

    // 2. Spine & Chest
    const spineGeom = new THREE.CylinderGeometry(0.12 * scale, 0.13 * scale, 0.14 * scale, 16);
    createPart(spineGeom, mannequinMat, boneMap.get('Spine'), { x: 0, y: 0.07 * scale, z: 0 }, { x: 0, y: 0, z: 0 }, 'Mannequin_Spine_Geo');

    const chestGeom = new THREE.CylinderGeometry(0.17 * scale, 0.13 * scale, 0.22 * scale, 16);
    createPart(chestGeom, mannequinMat, boneMap.get('Spine2'), { x: 0, y: 0.09 * scale, z: 0 }, { x: 0, y: 0, z: 0 }, 'Mannequin_Chest_Geo');

    // 3. Neck & Head
    const neckGeom = new THREE.CylinderGeometry(0.06 * scale, 0.07 * scale, 0.10 * scale, 14);
    createPart(neckGeom, mannequinMat, boneMap.get('Neck'), { x: 0, y: 0.05 * scale, z: 0 }, { x: 0, y: 0, z: 0 }, 'Mannequin_Neck_Geo');

    const headGeom = new THREE.SphereGeometry(0.12 * scale, 16, 14);
    headGeom.scale(0.85, 1.15, 0.95);
    createPart(headGeom, mannequinMat, boneMap.get('Head'), { x: 0, y: 0.12 * scale, z: 0.02 * scale }, { x: 0, y: 0, z: 0 }, 'Mannequin_Head_Geo');

    // 4. Arms (L & R)
    ['Left', 'Right'].forEach((side) => {
      const sign = side === 'Left' ? 1 : -1;

      // Shoulder ball
      const shoulderBall = new THREE.SphereGeometry(0.065 * scale, 14, 12);
      createPart(shoulderBall, jointMat, boneMap.get(`${side}Arm`), { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, `Joint_${side}Shoulder`);

      // Upper arm
      const upperArm = new THREE.CylinderGeometry(0.055 * scale, 0.048 * scale, 0.24 * scale, 14);
      upperArm.rotateZ(Math.PI / 2);
      createPart(upperArm, mannequinMat, boneMap.get(`${side}Arm`), { x: sign * 0.14 * scale, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, `Mannequin_${side}UpperArm_Geo`);

      // Elbow ball
      const elbowBall = new THREE.SphereGeometry(0.05 * scale, 14, 12);
      createPart(elbowBall, jointMat, boneMap.get(`${side}ForeArm`), { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, `Joint_${side}Elbow`);

      // Forearm
      const forearm = new THREE.CylinderGeometry(0.048 * scale, 0.040 * scale, 0.22 * scale, 14);
      forearm.rotateZ(Math.PI / 2);
      createPart(forearm, mannequinMat, boneMap.get(`${side}ForeArm`), { x: sign * 0.13 * scale, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, `Mannequin_${side}ForeArm_Geo`);

      // Hand
      const handGeom = new THREE.BoxGeometry(0.08 * scale, 0.035 * scale, 0.09 * scale);
      createPart(handGeom, mannequinMat, boneMap.get(`${side}Hand`), { x: sign * 0.06 * scale, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, `Mannequin_${side}Hand_Geo`);
    });

    // 5. Legs (L & R)
    ['Left', 'Right'].forEach((side) => {
      // Hip ball joint
      const hipBall = new THREE.SphereGeometry(0.07 * scale, 14, 12);
      createPart(hipBall, jointMat, boneMap.get(`${side}UpLeg`), { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, `Joint_${side}Hip`);

      // Thigh
      const thigh = new THREE.CylinderGeometry(0.075 * scale, 0.06 * scale, 0.38 * scale, 16);
      createPart(thigh, mannequinMat, boneMap.get(`${side}UpLeg`), { x: 0, y: -0.21 * scale, z: 0 }, { x: 0, y: 0, z: 0 }, `Mannequin_${side}Thigh_Geo`);

      // Knee ball
      const kneeBall = new THREE.SphereGeometry(0.06 * scale, 14, 12);
      createPart(kneeBall, jointMat, boneMap.get(`${side}Leg`), { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, `Joint_${side}Knee`);

      // Shin
      const shin = new THREE.CylinderGeometry(0.06 * scale, 0.05 * scale, 0.36 * scale, 16);
      createPart(shin, mannequinMat, boneMap.get(`${side}Leg`), { x: 0, y: -0.20 * scale, z: 0 }, { x: 0, y: 0, z: 0 }, `Mannequin_${side}Shin_Geo`);

      // Foot
      const foot = new THREE.BoxGeometry(0.09 * scale, 0.06 * scale, 0.18 * scale);
      createPart(foot, mannequinMat, boneMap.get(`${side}Foot`), { x: 0, y: -0.03 * scale, z: 0.05 * scale }, { x: 0, y: 0, z: 0 }, `Mannequin_${side}Foot_Geo`);
    });

    // 6. Optional Continuous Skinned Mesh (Skinning Body)
    if (isSkinned) {
      const bodyGeoms = [];
      const addBodyGeom = (g, pos) => {
        g.translate(pos.x, pos.y, pos.z);
        bodyGeoms.push(g);
      };

      // Torso & Head aligned to spine/neck/head bones
      addBodyGeom(new THREE.CylinderGeometry(0.14 * scale, 0.11 * scale, 0.16 * scale, 16, 4), { x: 0, y: 0.98 * scale, z: 0 });
      addBodyGeom(new THREE.CylinderGeometry(0.12 * scale, 0.13 * scale, 0.18 * scale, 16, 4), { x: 0, y: 1.15 * scale, z: 0 });
      addBodyGeom(new THREE.CylinderGeometry(0.17 * scale, 0.13 * scale, 0.28 * scale, 16, 4), { x: 0, y: 1.38 * scale, z: 0 });
      addBodyGeom(new THREE.CylinderGeometry(0.06 * scale, 0.07 * scale, 0.14 * scale, 14, 4), { x: 0, y: 1.59 * scale, z: 0 });
      addBodyGeom(new THREE.SphereGeometry(0.115 * scale, 16, 12), { x: 0, y: 1.74 * scale, z: 0.02 * scale });

      // Full Limbs aligned 1:1 with arm (y = 1.56) and leg (x = ±0.12) bone capsules
      ['Left', 'Right'].forEach((side) => {
        const sign = side === 'Left' ? 1 : -1;
        // Shoulder / Clavicle deltoid bridge (x = 0.09..0.27, y = 1.56)
        const shoulder = new THREE.CylinderGeometry(0.055 * scale, 0.052 * scale, 0.18 * scale, 12, 4);
        shoulder.rotateZ(sign * Math.PI / 2);
        addBodyGeom(shoulder, { x: sign * 0.18 * scale, y: 1.56 * scale, z: 0 });

        // Upper Arm (Arm->ForeArm: x = 0.27..0.55, y = 1.56)
        const uArm = new THREE.CylinderGeometry(0.050 * scale, 0.044 * scale, 0.26 * scale, 12, 4);
        uArm.rotateZ(sign * Math.PI / 2);
        addBodyGeom(uArm, { x: sign * 0.41 * scale, y: 1.56 * scale, z: 0 });

        // Forearm (ForeArm->Hand: x = 0.55..0.81, y = 1.56)
        const fArm = new THREE.CylinderGeometry(0.044 * scale, 0.036 * scale, 0.24 * scale, 12, 4);
        fArm.rotateZ(sign * Math.PI / 2);
        addBodyGeom(fArm, { x: sign * 0.68 * scale, y: 1.56 * scale, z: 0 });

        // Hand (x = 0.81..0.94, y = 1.56)
        addBodyGeom(new THREE.BoxGeometry(0.11 * scale, 0.035 * scale, 0.08 * scale), { x: sign * 0.87 * scale, y: 1.56 * scale, z: 0 });

        // Thigh (UpLeg->Leg: x = ±0.12, y = 0.92..0.48)
        addBodyGeom(new THREE.CylinderGeometry(0.072 * scale, 0.058 * scale, 0.40 * scale, 14, 6), { x: sign * 0.12 * scale, y: 0.70 * scale, z: 0 });

        // Shin (Leg->Foot: x = ±0.12, y = 0.48..0.06)
        addBodyGeom(new THREE.CylinderGeometry(0.058 * scale, 0.044 * scale, 0.38 * scale, 14, 6), { x: sign * 0.12 * scale, y: 0.27 * scale, z: 0 });

        // Foot (Foot->ToeBase: x = ±0.12, y = 0.03, z = 0.06)
        addBodyGeom(new THREE.BoxGeometry(0.085 * scale, 0.06 * scale, 0.18 * scale), { x: sign * 0.12 * scale, y: 0.03 * scale, z: 0.06 * scale });
      });

      // Merge
      let totalPositions = 0, totalIndices = 0;
      bodyGeoms.forEach((g) => {
        totalPositions += g.attributes.position.count;
        totalIndices += g.index ? g.index.count : g.attributes.position.count;
      });

      const mergedPositions = new Float32Array(totalPositions * 3);
      const mergedIndices = new Uint32Array(totalIndices);
      let posOffset = 0, indexOffset = 0, vertOffset = 0;

      bodyGeoms.forEach((g) => {
        const p = g.attributes.position.array;
        mergedPositions.set(p, posOffset);
        if (g.index) {
          const idx = g.index.array;
          for (let i = 0; i < idx.length; i++) mergedIndices[indexOffset + i] = idx[i] + vertOffset;
          indexOffset += idx.length;
        } else {
          const count = g.attributes.position.count;
          for (let i = 0; i < count; i++) mergedIndices[indexOffset + i] = i + vertOffset;
          indexOffset += count;
        }
        posOffset += p.length;
        vertOffset += g.attributes.position.count;
        g.dispose();
      });

      const mergedBodyGeom = new THREE.BufferGeometry();
      mergedBodyGeom.setAttribute('position', new THREE.BufferAttribute(mergedPositions, 3));
      mergedBodyGeom.setIndex(new THREE.BufferAttribute(mergedIndices, 1));
      mergedBodyGeom.computeVertexNormals();

      const bodyMesh = new THREE.Mesh(mergedBodyGeom, mannequinMat.clone());
      bodyMesh.name = 'Mannequin_Body_Mesh';
      armatureGroup.add(bodyMesh);

      const skinnedMesh = this.autoSkinMesh(bodyMesh, skeleton, { recordUndo: false });
      if (skinnedMesh && skinnedMesh.parent !== armatureGroup) {
        armatureGroup.add(skinnedMesh);
      }
    }

    armatureGroup.name = 'Rigged_Articulated_Mannequin';
    armatureGroup.userData.isCharacter = true;
    this.activeCharacter = armatureGroup;

    return { armatureGroup, skeleton, boneMap };
  }

  // =========================================================================
  // 7. STANDARDIZED POSE PRESETS (100% Twist-Free for Mannequin & Mixamo)
  // =========================================================================
  //
  // Character space convention: +Y = up, +Z = facing forward, +X = character's LEFT.
  //
  // Symmetry helper: builds Left and Right limb entries.
  // Sagittal reflection: (x, y, z) -> (x, -y, -z)

  static mirrorDelta(d) {
    return { x: d.x || 0, y: -(d.y || 0), z: -(d.z || 0) };
  }

  static sym(part, leftDelta) {
    return {
      [`Left${part}`]: { ...leftDelta },
      [`Right${part}`]: RigSystem.mirrorDelta(leftDelta)
    };
  }

  getPosePresets() {
    const S = RigSystem.sym;

    const builtIn = {
      // --- Basic / Idle / Rest ---
      t_pose: {
        category: 'basic',
        name: 'T-Pose (Calibration / Rest)',
        icon: '🧍',
        rotations: {}
      },
      idle_natural: {
        category: 'basic',
        name: 'Natural Idle (Relaxed Stand)',
        icon: '🧍‍♂️',
        rotations: {
          Spine: { x: 2 },
          Head: { x: -2 },
          ...S('Arm', { x: -4, z: -74 }),
          ...S('ForeArm', { y: -16, x: 5 }),
          ...S('UpLeg', { z: 2.5, x: -1 }),
          ...S('Leg', { x: 3 }),
          ...S('Foot', { x: -2 })
        }
      },
      a_pose: {
        category: 'basic',
        name: 'A-Pose (Standard Model Rest)',
        icon: '🚶',
        rotations: {
          ...S('Arm', { z: -45 }),
          ...S('ForeArm', { y: -5 })
        }
      },
      sitting_chair: {
        category: 'basic',
        name: 'Sitting Rest (Chair)',
        icon: '🪑',
        rotations: {
          ...S('UpLeg', { x: -88, z: 4 }),
          ...S('Leg', { x: 88 }),
          ...S('Arm', { x: -22, z: -70 }),
          ...S('ForeArm', { y: -55 }),
          Spine: { x: 6 },
          Head: { x: 4 }
        }
      },
      meditation_cross: {
        category: 'basic',
        name: 'Meditation Lotus',
        icon: '🧘',
        rotations: {
          ...S('UpLeg', { x: -80, z: 38 }),
          ...S('Leg', { x: 128 }),
          ...S('Arm', { x: -12, z: -74 }),
          ...S('ForeArm', { y: -42 }),
          Spine: { x: -3 },
          Head: { x: 6 }
        }
      },

      // --- Combat & Action ---
      combat_guard: {
        category: 'action',
        name: 'Fighting Guard',
        icon: '🥋',
        rotations: {
          Spine: { x: 8, y: -20 },
          Head: { x: 3, y: 18 },
          LeftUpLeg: { x: -26, z: 4 },
          LeftLeg: { x: 36 },
          LeftFoot: { x: -8 },
          RightUpLeg: { x: 18, z: -8 },
          RightLeg: { x: 28 },
          RightFoot: { x: -6 },
          LeftArm: { x: -35, y: -20, z: -62 },
          LeftForeArm: { y: -115, x: 15 },
          RightArm: { x: -45, y: 25, z: 65 },
          RightForeArm: { y: 125, x: 15 }
        }
      },
      boxing_stance: {
        category: 'action',
        name: 'Boxing Stance',
        icon: '🥊',
        rotations: {
          LeftUpLeg: { x: -22, z: 5 },
          LeftLeg: { x: 25 },
          RightUpLeg: { x: 18, z: -6 },
          RightLeg: { x: 22 },
          ...S('Arm', { x: -48, z: -66 }),
          ...S('ForeArm', { y: -130 }),
          Spine: { x: 14, y: -22 },
          Head: { x: 6, y: 20 }
        }
      },
      military_salute: {
        category: 'action',
        name: 'Military Salute',
        icon: '🫡',
        rotations: {
          Spine: { x: -3 },
          Head: { x: -2 },
          LeftUpLeg: { z: 1.5 },
          RightUpLeg: { z: -1.5 },
          LeftArm: { x: 2, z: -78 },
          LeftForeArm: { y: -5 },
          RightArm: { x: -12, y: 25, z: 42 },
          RightForeArm: { y: 138, x: 18 },
          RightHand: { y: 12, z: -10 }
        }
      },
      prayer_pose: {
        category: 'action',
        name: 'Namaste / Praying',
        icon: '🙏',
        rotations: {
          Spine: { x: 5 },
          Head: { x: 14 },
          ...S('UpLeg', { z: 1.5 }),
          ...S('Leg', { x: 2 }),
          LeftArm: { x: -28, y: -22, z: -60 },
          LeftForeArm: { y: -98, x: 22 },
          LeftHand: { y: 18 },
          RightArm: { x: -28, y: 22, z: 60 },
          RightForeArm: { y: 98, x: 22 },
          RightHand: { y: -18 }
        }
      },
      hero_victory: {
        category: 'action',
        name: 'Heroic Victory Cheer',
        icon: '🏆',
        rotations: {
          Spine: { x: -6, y: -6 },
          Head: { x: -14, y: 8 },
          LeftUpLeg: { x: -10, z: 6 },
          LeftLeg: { x: 12 },
          RightUpLeg: { x: 8, z: -8 },
          RightLeg: { x: 14 },
          RightArm: { x: -10, z: -78 },
          RightForeArm: { y: 22, x: 10 },
          LeftArm: { x: 15, z: -58 },
          LeftForeArm: { y: -92 }
        }
      },
      flying_kick: {
        category: 'action',
        name: 'Flying Kick',
        icon: '🦵',
        rotations: {
          RightUpLeg: { x: -88, z: -4 },
          RightLeg: { x: 4 },
          LeftUpLeg: { x: -30 },
          LeftLeg: { x: 100 },
          LeftArm: { x: -40, z: -42 },
          LeftForeArm: { y: -70 },
          RightArm: { x: 35, z: 50 },
          RightForeArm: { y: 20 },
          Spine: { x: -12 },
          Head: { x: 8 }
        }
      },
      hero_landing: {
        category: 'action',
        name: 'Superhero Landing',
        icon: '⚡',
        rotations: {
          LeftUpLeg: { x: -95, z: 10 },
          LeftLeg: { x: 105 },
          RightUpLeg: { x: 15, z: -14 },
          RightLeg: { x: 110 },
          RightArm: { x: -30, z: 82 },
          RightForeArm: { y: 10 },
          LeftArm: { x: 40, z: -32 },
          LeftForeArm: { y: -10 },
          Spine: { x: 35 },
          Head: { x: -30 }
        }
      },

      // --- Locomotion & Expression ---
      sprint_run: {
        category: 'locomotion',
        name: 'Dynamic Sprint Run',
        icon: '🏃',
        rotations: {
          Spine: { x: 18, y: 5 },
          Head: { x: -10 },
          LeftUpLeg: { x: -65, z: 3 },
          LeftLeg: { x: 80 },
          LeftFoot: { x: 10 },
          RightUpLeg: { x: 35, z: -4 },
          RightLeg: { x: 65 },
          RightFoot: { x: -20 },
          LeftArm: { x: 48, z: -72 },
          LeftForeArm: { y: -90 },
          RightArm: { x: -55, z: 72 },
          RightForeArm: { y: 95 }
        }
      },
      walking_stride: {
        category: 'locomotion',
        name: 'Walking Stride',
        icon: '🚶‍♂️',
        rotations: {
          LeftUpLeg: { x: -25 },
          LeftLeg: { x: 10 },
          LeftFoot: { x: -8 },
          RightUpLeg: { x: 16 },
          RightLeg: { x: 22 },
          RightFoot: { x: 10 },
          LeftArm: { x: 16, z: -76 },
          LeftForeArm: { y: -12 },
          RightArm: { x: -20, z: 76 },
          RightForeArm: { y: 22 },
          Spine: { y: 5 }
        }
      },
      sneak_crouch: {
        category: 'locomotion',
        name: 'Sneak Crouch',
        icon: '🕵️',
        rotations: {
          ...S('UpLeg', { x: -62, z: 6 }),
          ...S('Leg', { x: 92 }),
          ...S('Foot', { x: -28 }),
          ...S('Arm', { x: -30, z: -62 }),
          ...S('ForeArm', { y: -70 }),
          Spine: { x: 30 },
          Head: { x: -24 }
        }
      },
      thinking_pose: {
        category: 'locomotion',
        name: 'Thinking Pose',
        icon: '🤔',
        rotations: {
          LeftArm: { x: -10, z: -72 },
          LeftForeArm: { y: -80 },
          RightArm: { x: -28, z: 70 },
          RightForeArm: { y: 145 },
          Head: { x: 10, y: 10 }
        }
      }
    };

    const custom = {};
    Object.entries(this.customPoses || {}).forEach(([k, p]) => {
      if (p && p.space === 'character') custom[k] = p;
    });

    return { ...builtIn, ...custom };
  }

  // =========================================================================
  // 8. RIG-INDEPENDENT POSING ENGINE (Quaternion Parent-Conjugate Deltas)
  // =========================================================================

  static cleanBoneName(name) {
    return String(name || '')
      .replace(/^mixamorig[:_]?/i, '')
      .replace(/^mixamo_/i, '')
      .replace(/[._]\d{3}$/, '');
  }

  /**
   * Detects sagittal side across Mixamo, Blender (.L/.R), UE5 (_l/_r), and VRM (J_Bip_L/R) conventions.
   * Returns 1 for Left, -1 for Right, 0 for Center.
   */
  static detectBoneSide(name, fallbackX = 0, deadband = 0.02) {
    const clean = RigSystem.cleanBoneName(name || '');
    if (/left|\.l$|_l$|^l_|_l_|j_bip_l_/i.test(clean)) return 1;
    if (/right|\.r$|_r$|^r_|_r_|j_bip_r_/i.test(clean)) return -1;
    if (fallbackX > deadband) return 1;
    if (fallbackX < -deadband) return -1;
    return 0;
  }

  _findCharacterRoot(target, bones) {
    const scene = this.scene || (typeof window !== 'undefined' ? window.scene : null);
    const sm = this.sceneManager || this.engine?.sceneManager || (typeof window !== 'undefined' ? window.sceneManager : null);
    const rootContainer = sm ? sm.rootContainer : null;
    let node = (target && target.isObject3D) ? target : bones[0];
    while (
      node.parent &&
      node.parent !== scene &&
      node.parent !== rootContainer &&
      !node.parent.isScene &&
      !node.parent.userData?.isSystemObject
    ) {
      node = node.parent;
    }
    return node;
  }

  _prepareRig(target) {
    const THREE = this.THREE;
    const bones = this._extractBones(target);
    if (!bones || bones.length === 0) return null;

    const root = this._findCharacterRoot(target, bones);

    // 1. Cache bind pose local quaternion
    bones.forEach((b) => {
      const rq = b.userData.restQuat;
      const validQuat = rq && typeof rq.copy === 'function' && Number.isFinite(rq.x) && Number.isFinite(rq.y) && Number.isFinite(rq.z) && Number.isFinite(rq.w);
      if (!validQuat) {
        if (rq && Number.isFinite(rq.x) && Number.isFinite(rq.y) && Number.isFinite(rq.z) && Number.isFinite(rq.w)) {
          b.userData.restQuat = new THREE.Quaternion(rq.x, rq.y, rq.z, rq.w);
        } else {
          const re = b.userData.restEuler;
          const validEuler = re && Number.isFinite(re.x) && Number.isFinite(re.y) && Number.isFinite(re.z);
          b.userData.restQuat = validEuler
            ? new THREE.Quaternion().setFromEuler(re.isEuler ? re : new THREE.Euler(re.x, re.y, re.z, re.order || 'XYZ'))
            : b.quaternion.clone();
        }
      }
      if (!b.userData.restEuler?.isEuler) {
        b.userData.restEuler = new THREE.Euler().setFromQuaternion(b.userData.restQuat);
      }
    });

    // 2. Cache character-space rest orientation (Wr) with all bones at bind pose
    if (bones.some((b) => !b.userData.restCharQuat || typeof b.userData.restCharQuat.invert !== 'function' || !Number.isFinite(b.userData.restCharQuat.x))) {
      const saved = bones.map((b) => b.quaternion.clone());
      bones.forEach((b) => b.quaternion.copy(b.userData.restQuat));
      root.updateMatrixWorld(true);

      const rootInv = root.getWorldQuaternion(new THREE.Quaternion()).invert();
      const tmp = new THREE.Quaternion();
      bones.forEach((b) => {
        b.userData.restCharQuat = rootInv.clone().multiply(b.getWorldQuaternion(tmp));
      });

      bones.forEach((b, i) => b.quaternion.copy(saved[i]));
      root.updateMatrixWorld(true);
    }

    const boneMap = new Map();
    bones.forEach((b) => {
      const clean = RigSystem.cleanBoneName(b.name);
      if (!boneMap.has(clean)) boneMap.set(clean, b);
      boneMap.set(b.name, b);
    });

    return { bones, boneMap, root };
  }

  /**
   * Applies character-space delta D to bone in parent's local space.
   * Eliminates twists on Mixamo rigs and procedural mannequins.
   */
  _setBoneCharDeltaQuat(bone, D) {
    const parentWr = (bone.parent && bone.parent.userData?.restCharQuat)
      ? bone.parent.userData.restCharQuat
      : new THREE.Quaternion();

    // R_parent = parentWr⁻¹ * D * parentWr
    const R_parent = parentWr.clone().invert().multiply(D).multiply(parentWr);
    bone.quaternion.copy(R_parent.multiply(bone.userData.restQuat));
  }

  _getBoneCharDeltaQuat(bone) {
    const parentWr = (bone.parent && bone.parent.userData?.restCharQuat)
      ? bone.parent.userData.restCharQuat
      : new THREE.Quaternion();

    // D = parentWr * (bone.quaternion * restQuat⁻¹) * parentWr⁻¹
    const localDelta = bone.quaternion.clone().multiply(bone.userData.restQuat.clone().invert());
    return parentWr.clone().multiply(localDelta).multiply(parentWr.clone().invert());
  }

  _degDeltaToQuat(d) {
    const THREE = this.THREE;
    const r = Math.PI / 180;
    return new THREE.Quaternion().setFromEuler(
      new THREE.Euler((d.x || 0) * r, (d.y || 0) * r, (d.z || 0) * r, 'XYZ')
    );
  }

  setBoneDelta(characterOrSkeleton, boneName, deltaDeg) {
    const rig = this._prepareRig(characterOrSkeleton);
    if (!rig) return false;
    const bone = rig.boneMap.get(RigSystem.cleanBoneName(boneName)) || rig.boneMap.get(boneName);
    if (!bone) return false;
    this._setBoneCharDeltaQuat(bone, this._degDeltaToQuat(deltaDeg));
    this.updateSkeletonHelper();
    return true;
  }

  getBoneDelta(characterOrSkeleton, boneName) {
    const THREE = this.THREE;
    const rig = this._prepareRig(characterOrSkeleton);
    if (!rig) return null;
    const bone = rig.boneMap.get(RigSystem.cleanBoneName(boneName)) || rig.boneMap.get(boneName);
    if (!bone) return null;
    const e = new THREE.Euler().setFromQuaternion(this._getBoneCharDeltaQuat(bone), 'XYZ');
    const k = 180 / Math.PI;
    return { x: +(e.x * k).toFixed(2), y: +(e.y * k).toFixed(2), z: +(e.z * k).toFixed(2) };
  }

  applyPose(characterOrSkeleton, poseKey) {
    const presets = this.getPosePresets();
    const pose = presets[poseKey];
    if (!pose) {
      console.warn(`[RigSystem] Unknown pose: ${poseKey}`);
      return false;
    }

    const rig = this._prepareRig(characterOrSkeleton);
    if (!rig) {
      console.warn('[RigSystem] No bones found in target');
      return false;
    }

    // 1. Reset every bone to its bind/rest pose
    rig.bones.forEach((b) => {
      if (b.userData?.restQuat) b.quaternion.copy(b.userData.restQuat);
    });

    // 2. Apply character-space deltas
    let applied = 0;
    Object.entries(pose.rotations || {}).forEach(([bName, delta]) => {
      const bone = rig.boneMap.get(bName);
      if (bone) {
        this._setBoneCharDeltaQuat(bone, this._degDeltaToQuat(delta));
        applied++;
      }
    });

    rig.root.updateMatrixWorld(true);
    this.updateSkeletonHelper();

    // If IK is enabled, sync handle positions
    if (this.isIKEnabled) {
      this.updateIKHandlesPositions();
    }

    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('blender:pose-changed', {
        detail: { poseKey, poseName: pose.name, bonesApplied: applied }
      }));
    }
    return true;
  }

  resetPose(characterOrSkeleton, boneName = null) {
    const rig = this._prepareRig(characterOrSkeleton);
    if (!rig) return false;

    const wanted = boneName ? RigSystem.cleanBoneName(boneName) : null;
    rig.bones.forEach((b) => {
      if (!wanted || RigSystem.cleanBoneName(b.name) === wanted) {
        if (b.userData?.restQuat) b.quaternion.copy(b.userData.restQuat);
      }
    });

    rig.root.updateMatrixWorld(true);
    this.updateSkeletonHelper();

    if (this.isIKEnabled) {
      this.updateIKHandlesPositions();
    }

    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('blender:pose-changed', {
        detail: { poseKey: 'rest', poseName: 'Rest Pose' }
      }));
    }
    return true;
  }

  mirrorPose(characterOrSkeleton, direction = 'left_to_right') {
    const rig = this._prepareRig(characterOrSkeleton);
    if (!rig) return false;

    const wantLeftSource = direction !== 'right_to_left';
    const pseudoSkel = { bones: rig.bones };

    rig.bones.forEach((src, srcIdx) => {
      const side = RigSystem.detectBoneSide(src.name);
      if ((wantLeftSource && side !== 1) || (!wantLeftSource && side !== -1)) return;
      const dstIdx = this._findMirrorBoneIndex(pseudoSkel, srcIdx);
      const dst = dstIdx !== srcIdx ? rig.bones[dstIdx] : null;
      if (!dst || dst === src) return;

      const D = this._getBoneCharDeltaQuat(src);
      // Reflection across the YZ plane (x -> -x): quaternion (x, y, z, w) -> (x, -y, -z, w)
      D.set(D.x, -D.y, -D.z, D.w);
      this._setBoneCharDeltaQuat(dst, D);
    });

    if (this.constraintsEnabled) {
      this.evaluateConstraints(rig.root);
    }
    rig.root.updateMatrixWorld(true);
    this.updateSkeletonHelper();
    if (this.isIKEnabled) {
      this.updateIKHandlesPositions();
    }
    return true;
  }

  saveCustomPose(poseName, characterOrSkeleton) {
    if (!poseName) return null;
    const THREE = this.THREE;
    const rig = this._prepareRig(characterOrSkeleton);
    if (!rig) return null;

    const key = 'custom_' + Date.now();
    const rotations = {};
    const k = 180 / Math.PI;

    rig.bones.forEach((b) => {
      const e = new THREE.Euler().setFromQuaternion(this._getBoneCharDeltaQuat(b), 'XYZ');
      const d = { x: +(e.x * k).toFixed(2), y: +(e.y * k).toFixed(2), z: +(e.z * k).toFixed(2) };
      if (Math.abs(d.x) > 0.05 || Math.abs(d.y) > 0.05 || Math.abs(d.z) > 0.05) {
        rotations[RigSystem.cleanBoneName(b.name)] = d;
      }
    });

    const newPose = {
      category: 'custom',
      space: 'character',
      name: poseName,
      icon: '⭐',
      rotations
    };

    this.customPoses[key] = newPose;
    this._persistCustomPoses();

    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('blender:custom-pose-added', { detail: { key, newPose } }));
    }
    return key;
  }

  _loadCustomPoses() {
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        const data = localStorage.getItem('studio_custom_poses');
        return data ? JSON.parse(data) : {};
      }
    } catch (e) {
      console.warn('Cannot load custom poses from localStorage', e);
    }
    return {};
  }

  _persistCustomPoses() {
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        localStorage.setItem('studio_custom_poses', JSON.stringify(this.customPoses));
      }
    } catch (e) {
      console.warn('Cannot persist custom poses', e);
    }
  }

  setPoseMode(enabled, character = null) {
    this.isPoseMode = !!enabled;
    const unwrapped = character?.armatureGroup?.isObject3D ? character.armatureGroup : character;
    if (unwrapped?.isObject3D) {
      this.activeCharacter = unwrapped;
    }

    const modeIndicator = document.getElementById('mode-indicator-text');
    if (modeIndicator) {
      modeIndicator.textContent = this.isPoseMode ? 'Pose Mode' : 'Object Mode';
    }

    if (this.skeletonHelper) {
      this.skeletonHelper.visible = this.isPoseMode || true;
    }

    this._syncViewportModeUI(
      this.isWeightPaintMode ? 'weight-paint' : (this.isEditBoneMode ? 'edit-bone' : (this.isPoseMode ? 'pose' : 'object')),
      false
    );
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('blender:mode-changed', {
        detail: { mode: this.isPoseMode ? 'pose' : 'object' }
      }));
    }
    return this.isPoseMode;
  }

  updateSkeletonHelper() {
    if (this.skeletonHelper) {
      // Defensive orphan guard: if the target root was removed from the scene by any code path,
      // remove the floating SkeletonHelper immediately instead of leaving a ghost rig in the viewport.
      const scene = this.scene || (typeof window !== 'undefined' ? window.scene : null);
      const root = this.skeletonHelper.root || this.skeletonHelper.userData?.targetRoot || null;
      if (scene && root) {
        let cur = root;
        let inScene = false;
        while (cur) {
          if (cur === scene) { inScene = true; break; }
          cur = cur.parent;
        }
        if (!inScene) {
          if (this.skeletonHelper.parent) this.skeletonHelper.parent.remove(this.skeletonHelper);
          this.skeletonHelper = null;
          return;
        }
      }
      if (typeof this.skeletonHelper.update === 'function') {
        this.skeletonHelper.update();
      } else if (typeof this.skeletonHelper.updateMatrixWorld === 'function') {
        this.skeletonHelper.updateMatrixWorld(true);
      }
    }
  }

  // =========================================================================
  // 9. BONE CONSTRAINTS ENGINE (Limit Rotation, Copy Rotation, Track To, Copy Location)
  // =========================================================================

  _resolveConstraintBone(boneOrName) {
    if (boneOrName?.isBone) return boneOrName;
    return this._resolveBoneArg(this.activeSkeleton || this.editSkeleton, boneOrName || this.activeBone);
  }

  getBoneConstraints(boneOrName) {
    const bone = this._resolveConstraintBone(boneOrName);
    if (!bone) return [];
    const list = bone.userData?.constraints;
    return Array.isArray(list) ? list : [];
  }

  addBoneConstraint(boneOrName, config = {}) {
    const bone = this._resolveConstraintBone(boneOrName);
    if (!bone || !config?.type) return null;

    if (!Array.isArray(bone.userData.constraints)) {
      bone.userData.constraints = [];
    }

    const id = config.id || `cst_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    const constraint = {
      id,
      type: config.type,
      name: config.name || config.type,
      enabled: config.enabled !== false,
      influence: config.influence !== undefined ? Math.max(0, Math.min(1, Number(config.influence))) : 1.0,
    };

    if (config.type === 'limitRotation') {
      constraint.useX = config.useX !== false;
      constraint.useY = config.useY !== false;
      constraint.useZ = config.useZ !== false;
      constraint.minDeg = {
        x: config.minDeg?.x ?? -180,
        y: config.minDeg?.y ?? -180,
        z: config.minDeg?.z ?? -180,
      };
      constraint.maxDeg = {
        x: config.maxDeg?.x ?? 180,
        y: config.maxDeg?.y ?? 180,
        z: config.maxDeg?.z ?? 180,
      };
    } else if (config.type === 'copyRotation') {
      constraint.targetBone = config.targetBone?.isObject3D ? config.targetBone.name : (config.targetBone || '');
      constraint.targetRef = config.targetBone?.isObject3D ? config.targetBone : (config.targetRef || null);
      constraint.axes = {
        x: config.axes?.x !== false,
        y: config.axes?.y !== false,
        z: config.axes?.z !== false,
      };
      constraint.invert = {
        x: Boolean(config.invert?.x),
        y: Boolean(config.invert?.y),
        z: Boolean(config.invert?.z),
      };
      constraint.offset = Boolean(config.offset);
    } else if (config.type === 'trackTo') {
      constraint.targetBone = config.targetBone?.isObject3D ? config.targetBone.name : (config.targetBone || '');
      constraint.targetRef = config.targetBone?.isObject3D ? config.targetBone : (config.targetRef || null);
      constraint.forwardAxis = config.forwardAxis || 'auto';
      constraint.upAxis = config.upAxis || 'Y';
    } else if (config.type === 'copyLocation') {
      constraint.targetBone = config.targetBone?.isObject3D ? config.targetBone.name : (config.targetBone || '');
      constraint.targetRef = config.targetBone?.isObject3D ? config.targetBone : (config.targetRef || null);
      constraint.axes = {
        x: config.axes?.x !== false,
        y: config.axes?.y !== false,
        z: config.axes?.z !== false,
      };
    } else {
      return null;
    }

    bone.userData.constraints.push(constraint);
    this.evaluateConstraints(this.activeCharacter || bone);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('blender:bone-constraints-changed', {
        detail: { boneName: bone.name, constraints: bone.userData.constraints }
      }));
    }
    return constraint;
  }

  removeBoneConstraint(boneOrName, constraintIdOrIndex) {
    const bone = this._resolveConstraintBone(boneOrName);
    if (!bone || !Array.isArray(bone.userData?.constraints)) return false;

    const list = bone.userData.constraints;
    let idx = -1;
    if (typeof constraintIdOrIndex === 'number') {
      idx = constraintIdOrIndex;
    } else {
      idx = list.findIndex(c => c.id === constraintIdOrIndex);
    }
    if (idx < 0 || idx >= list.length) return false;

    list.splice(idx, 1);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('blender:bone-constraints-changed', {
        detail: { boneName: bone.name, constraints: list }
      }));
    }
    return true;
  }

  clearBoneConstraints(boneOrName = null, characterOrSkeleton = null) {
    if (boneOrName) {
      const bone = this._resolveConstraintBone(boneOrName);
      if (!bone) return 0;
      const count = Array.isArray(bone.userData?.constraints) ? bone.userData.constraints.length : 0;
      bone.userData.constraints = [];
      return count;
    }
    const rig = this._prepareRig(characterOrSkeleton || this.activeCharacter || this.activeSkeleton);
    if (!rig) return 0;
    let total = 0;
    rig.bones.forEach((b) => {
      if (Array.isArray(b.userData?.constraints)) {
        total += b.userData.constraints.length;
        b.userData.constraints = [];
      }
    });
    return total;
  }

  /**
   * Evaluates all enabled Bone Constraints across the rig in hierarchy order.
   */
  evaluateConstraints(characterOrSkeleton = null) {
    if (!this.constraintsEnabled || this._evaluatingConstraints) return 0;
    const THREE = this.THREE;
    const rig = this._prepareRig(characterOrSkeleton || this.activeCharacter || this.activeSkeleton);
    if (!rig) return 0;

    this._evaluatingConstraints = true;
    let evaluated = 0;

    try {
      const degToRad = Math.PI / 180;
      const scene = this.scene || (typeof window !== 'undefined' ? window.scene : null);
      const depthOf = (bone) => {
        let d = 0;
        let cur = bone.parent;
        while (cur && cur.isBone) {
          d++;
          cur = cur.parent;
        }
        return d;
      };
      const sortedBones = [...rig.bones].sort((a, b) => depthOf(a) - depthOf(b));

      const resolveConstraintTarget = (c) => {
        if (c.targetRef && c.targetRef.isObject3D) return c.targetRef;
        if (c.targetBone) {
          const b = rig.boneMap.get(RigSystem.cleanBoneName(c.targetBone))
            || rig.boneMap.get(c.targetBone)
            || rig.bones.find(bn => bn.name.toLowerCase() === String(c.targetBone).toLowerCase());
          if (b) return b;
          if (scene?.getObjectByName) {
            return scene.getObjectByName(c.targetBone) || null;
          }
        }
        return null;
      };

      const tmpPos = new THREE.Vector3();
      const targetPos = new THREE.Vector3();
      const tmpQuat = new THREE.Quaternion();
      const parentWorldQuat = new THREE.Quaternion();

      rig.root.updateMatrixWorld(true);

      for (const bone of sortedBones) {
        const list = bone.userData?.constraints;
        if (!Array.isArray(list) || list.length === 0) continue;

        const restQuat = bone.userData.restQuat || new THREE.Quaternion();
        const restInv = restQuat.clone().invert();

        for (const c of list) {
          if (c.enabled === false) continue;
          const inf = Math.max(0, Math.min(1, Number(c.influence ?? 1)));
          if (inf <= 1e-6) continue;

          if (c.type === 'copyRotation') {
            const tgt = resolveConstraintTarget(c);
            if (!tgt) continue;
            const tgtRestInv = (tgt.userData?.restQuat || new THREE.Quaternion()).clone().invert();
            const tgtDelta = tgtRestInv.multiply(tgt.quaternion.clone());
            const e = new THREE.Euler().setFromQuaternion(tgtDelta, 'XYZ');
            if (c.axes?.x === false) e.x = 0;
            else if (c.invert?.x) e.x = -e.x;
            if (c.axes?.y === false) e.y = 0;
            else if (c.invert?.y) e.y = -e.y;
            if (c.axes?.z === false) e.z = 0;
            else if (c.invert?.z) e.z = -e.z;

            const filteredDelta = new THREE.Quaternion().setFromEuler(e);
            const curDelta = restInv.clone().multiply(bone.quaternion);
            const desiredDelta = c.offset ? curDelta.clone().multiply(filteredDelta) : filteredDelta;
            curDelta.slerp(desiredDelta, inf);
            bone.quaternion.copy(restQuat).multiply(curDelta).normalize();
            bone.updateMatrixWorld(true);
            evaluated++;
          } else if (c.type === 'trackTo') {
            const tgt = resolveConstraintTarget(c);
            if (!tgt) continue;
            bone.updateMatrixWorld(true);
            tgt.updateMatrixWorld(true);
            tmpPos.setFromMatrixPosition(bone.matrixWorld);
            targetPos.setFromMatrixPosition(tgt.matrixWorld);
            const toTarget = targetPos.sub(tmpPos);
            if (toTarget.lengthSq() < 1e-8) continue;
            toTarget.normalize();

            let localFwd;
            if (c.forwardAxis === 'Z') localFwd = new THREE.Vector3(0, 0, 1);
            else if (c.forwardAxis === '-Z') localFwd = new THREE.Vector3(0, 0, -1);
            else if (c.forwardAxis === 'Y') localFwd = new THREE.Vector3(0, 1, 0);
            else if (c.forwardAxis === '-Y') localFwd = new THREE.Vector3(0, -1, 0);
            else if (c.forwardAxis === 'X') localFwd = new THREE.Vector3(1, 0, 0);
            else if (c.forwardAxis === '-X') localFwd = new THREE.Vector3(-1, 0, 0);
            else {
              const childB = bone.children.find(ch => ch.isBone && ch.position.lengthSq() > 1e-6);
              localFwd = childB ? childB.position.clone().normalize() : new THREE.Vector3(0, 0, 1);
            }

            const worldQuat = bone.getWorldQuaternion(tmpQuat);
            const currWorldDir = localFwd.applyQuaternion(worldQuat).normalize();
            const dot = Math.max(-1, Math.min(1, currWorldDir.dot(toTarget)));
            const aimDelta = new THREE.Quaternion();
            if (dot < -0.9999) {
              const fallback = Math.abs(currWorldDir.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
              aimDelta.setFromAxisAngle(fallback.cross(currWorldDir).normalize(), Math.PI);
            } else {
              aimDelta.setFromUnitVectors(currWorldDir, toTarget);
            }
            const desiredWorld = aimDelta.multiply(worldQuat);
            const blendedWorld = worldQuat.clone().slerp(desiredWorld, inf);

            if (bone.parent) {
              bone.parent.getWorldQuaternion(parentWorldQuat);
              bone.quaternion.copy(parentWorldQuat.invert().multiply(blendedWorld)).normalize();
            } else {
              bone.quaternion.copy(blendedWorld).normalize();
            }
            bone.updateMatrixWorld(true);
            evaluated++;
          } else if (c.type === 'copyLocation') {
            const tgt = resolveConstraintTarget(c);
            if (!tgt) continue;
            tgt.updateMatrixWorld(true);
            targetPos.setFromMatrixPosition(tgt.matrixWorld);
            if (bone.parent) {
              bone.parent.updateMatrixWorld(true);
              bone.parent.worldToLocal(targetPos);
            }
            if (c.axes?.x !== false) bone.position.x = bone.position.x * (1 - inf) + targetPos.x * inf;
            if (c.axes?.y !== false) bone.position.y = bone.position.y * (1 - inf) + targetPos.y * inf;
            if (c.axes?.z !== false) bone.position.z = bone.position.z * (1 - inf) + targetPos.z * inf;
            bone.updateMatrixWorld(true);
            evaluated++;
          } else if (c.type === 'limitRotation') {
            const curDelta = restInv.clone().multiply(bone.quaternion);
            const e = new THREE.Euler().setFromQuaternion(curDelta, 'XYZ');
            if (c.useX !== false) {
              e.x = Math.max((c.minDeg.x ?? -180) * degToRad, Math.min((c.maxDeg.x ?? 180) * degToRad, e.x));
            }
            if (c.useY !== false) {
              e.y = Math.max((c.minDeg.y ?? -180) * degToRad, Math.min((c.maxDeg.y ?? 180) * degToRad, e.y));
            }
            if (c.useZ !== false) {
              e.z = Math.max((c.minDeg.z ?? -180) * degToRad, Math.min((c.maxDeg.z ?? 180) * degToRad, e.z));
            }
            const clampedDelta = new THREE.Quaternion().setFromEuler(e);
            const finalDelta = curDelta.clone().slerp(clampedDelta, inf);
            bone.quaternion.copy(restQuat).multiply(finalDelta).normalize();
            bone.updateMatrixWorld(true);
            evaluated++;
          }
        }
      }
    } finally {
      this._evaluatingConstraints = false;
    }

    return evaluated;
  }

  /**
   * Installs standard anatomical joint rotation limits on Spine, Neck, Head, Knees, Elbows, Hips & Ankles.
   */
  applyHumanoidJointLimits(characterOrSkeleton = null) {
    const rig = this._prepareRig(characterOrSkeleton || this.activeCharacter || this.activeSkeleton);
    if (!rig) return 0;

    const presets = [
      { names: ['Spine', 'Spine1', 'Spine2'], minDeg: { x: -45, y: -40, z: -30 }, maxDeg: { x: 55, y: 40, z: 30 } },
      { names: ['Neck'], minDeg: { x: -45, y: -55, z: -35 }, maxDeg: { x: 45, y: 55, z: 35 } },
      { names: ['Head'], minDeg: { x: -50, y: -70, z: -35 }, maxDeg: { x: 50, y: 70, z: 35 } },
      { names: ['LeftUpLeg', 'RightUpLeg'], minDeg: { x: -125, y: -45, z: -55 }, maxDeg: { x: 45, y: 45, z: 55 } },
      { names: ['LeftLeg', 'RightLeg'], minDeg: { x: 0, y: -8, z: -8 }, maxDeg: { x: 150, y: 8, z: 8 } },
      { names: ['LeftFoot', 'RightFoot'], minDeg: { x: -50, y: -25, z: -25 }, maxDeg: { x: 45, y: 25, z: 25 } },
      { names: ['LeftArm', 'RightArm'], minDeg: { x: -100, y: -95, z: -135 }, maxDeg: { x: 120, y: 95, z: 135 } },
      { names: ['LeftForeArm', 'RightForeArm'], minDeg: { x: -20, y: -145, z: -20 }, maxDeg: { x: 20, y: 145, z: 20 } },
      { names: ['LeftHand', 'RightHand'], minDeg: { x: -75, y: -45, z: -75 }, maxDeg: { x: 75, y: 45, z: 75 } },
    ];

    let applied = 0;
    presets.forEach((p) => {
      p.names.forEach((bName) => {
        const bone = rig.boneMap.get(bName) || rig.bones.find(b => RigSystem.cleanBoneName(b.name).toLowerCase() === bName.toLowerCase());
        if (!bone) return;
        if (!Array.isArray(bone.userData.constraints)) bone.userData.constraints = [];
        bone.userData.constraints = bone.userData.constraints.filter(c => c.id !== `anatomical_limit_${bone.name}`);
        bone.userData.constraints.push({
          id: `anatomical_limit_${bone.name}`,
          type: 'limitRotation',
          name: 'Anatomical Limit',
          enabled: true,
          influence: 1.0,
          useX: true,
          useY: true,
          useZ: true,
          minDeg: { ...p.minDeg },
          maxDeg: { ...p.maxDeg },
        });
        applied++;
      });
    });

    this.evaluateConstraints(rig.root);
    return applied;
  }

  // =========================================================================
  // 10. TIMELINE KEYFRAMING & NON-DESTRUCTIVE ACTION BAKING
  // =========================================================================

  _resolveTimelineEngine(options = {}) {
    return options?.timeline
      || this.timelineEngine
      || this.engine?.timelineEngine
      || (typeof window !== 'undefined' ? window.timelineEngine : null);
  }

  /**
   * Inserts rotation (and root position if moved) keyframes on the Timeline for the active bone or whole rig.
   */
  keyframePoseToTimeline(target = null, boneOrAll = null, options = {}) {
    const THREE = this.THREE;
    const rig = this._prepareRig(target || this.activeCharacter || this.activeSkeleton);
    if (!rig) return { frame: 0, count: 0, boneNames: [], tracks: 0 };

    const tl = this._resolveTimelineEngine(options);
    const frame = options.frame !== undefined ? Number(options.frame) : (tl?.currentFrame ?? 0);
    const interp = options.interpolation || tl?.defaultInterpolation || 'linear';

    let targetBones = rig.bones;
    const pseudoSkel = { bones: rig.bones };
    if (boneOrAll && boneOrAll !== 'all') {
      if (Array.isArray(boneOrAll)) {
        targetBones = boneOrAll.map(b => this._resolveBoneArg(pseudoSkel, b)).filter(Boolean);
      } else {
        const single = this._resolveBoneArg(pseudoSkel, boneOrAll);
        targetBones = single ? [single] : [];
      }
    }

    let insertedTracks = 0;
    const boneNames = [];
    for (const bone of targetBones) {
      const bClean = RigSystem.cleanBoneName(bone.name).toLowerCase();
      const isRoot = !bone.parent?.isBone || /^(hips|pelvis|root)$/i.test(bClean);
      const channels = isRoot ? ['position', 'rotation'] : ['rotation'];
      if (tl?.insertBoneKeyframe) {
        const res = tl.insertBoneKeyframe(rig.root, bone, frame, channels, interp);
        if (res) insertedTracks += channels.length;
      }
      boneNames.push(bone.name);
    }

    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('blender:pose-keyframed', {
        detail: { frame, count: boneNames.length, boneNames, tracks: insertedTracks }
      }));
    }
    return { frame, count: boneNames.length, boneNames, tracks: insertedTracks };
  }

  /**
   * Bakes an IK/Constraint-evaluated rig animation across [startFrame..endFrame] into a standalone THREE.AnimationClip.
   */
  bakeRigToClip(options = {}) {
    const THREE = this.THREE;
    const rig = this._prepareRig(options.target || this.activeCharacter || this.activeSkeleton);
    if (!rig) return null;

    const tl = this._resolveTimelineEngine(options);
    const startFrame = Number.isFinite(options.startFrame) ? options.startFrame : (tl?.startFrame ?? 0);
    const endFrame = Number.isFinite(options.endFrame) ? options.endFrame : (tl?.endFrame ?? 60);
    const fps = Number.isFinite(options.fps) ? Math.max(1, options.fps) : (tl?.fps ?? 30);
    const step = Math.max(1, Math.floor(options.sampleStep ?? 1));
    const clipName = options.clipName || 'BakedRigAction';
    const onFrame = typeof options.onFrame === 'function' ? options.onFrame : null;

    // Save current rig transforms so bake is non-destructive unless keepEndState is asked
    const savedState = rig.bones.map(b => ({
      pos: b.position.clone(),
      quat: b.quaternion.clone(),
    }));

    const times = [];
    const perBonePos = rig.bones.map(() => []);
    const perBoneQuat = rig.bones.map(() => []);

    for (let f = startFrame; f <= endFrame; f += step) {
      const t = (f - startFrame) / fps;
      times.push(t);

      if (onFrame) {
        onFrame(f, t, rig);
      } else if (typeof tl?.evaluate === 'function') {
        tl.evaluate(f);
      } else if (typeof tl?.seekToFrame === 'function') {
        tl.seekToFrame(f, true);
      } else if (tl?.applyFrame) {
        tl.applyFrame(f);
      }

      if (this.constraintsEnabled) {
        this.evaluateConstraints(rig.root);
      }
      rig.root.updateMatrixWorld(true);

      rig.bones.forEach((b, bi) => {
        perBonePos[bi].push(b.position.x, b.position.y, b.position.z);
        perBoneQuat[bi].push(b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w);
      });
    }

    const duration = times.length > 1 ? times[times.length - 1] : 1 / fps;
    const tracks = [];

    rig.bones.forEach((b, bi) => {
      const bClean = RigSystem.cleanBoneName(b.name).toLowerCase();
      const isRoot = !b.parent?.isBone || /^(hips|pelvis|root)$/i.test(bClean);
      const qArr = perBoneQuat[bi];
      // Include quaternion track for every bone in rig so AnimationMixer drives full skeleton cleanly
      tracks.push(new THREE.QuaternionKeyframeTrack(`${b.name}.quaternion`, times, qArr));

      if (isRoot) {
        tracks.push(new THREE.VectorKeyframeTrack(`${b.name}.position`, times, perBonePos[bi]));
      }
    });

    const clip = new THREE.AnimationClip(clipName, duration, tracks);

    if (!options.keepEndState) {
      rig.bones.forEach((b, bi) => {
        b.position.copy(savedState[bi].pos);
        b.quaternion.copy(savedState[bi].quat);
      });
      rig.root.updateMatrixWorld(true);
    }

    if (options.attachToTimeline !== false && tl?.attachClip) {
      tl.attachClip(rig.root, clip);
    }

    return clip;
  }

  _extractBones(target) {
    if (!target) return [];
    if (target.bones && Array.isArray(target.bones)) return target.bones;
    if (target.isBone) return [target];
    if (typeof target.traverse !== 'function') return [];

    const bones = [];
    target.traverse((child) => {
      if (child.isBone && !bones.includes(child)) bones.push(child);
      if (child.skeleton && child.skeleton.bones) {
        child.skeleton.bones.forEach((b) => {
          if (!bones.includes(b)) bones.push(b);
        });
      }
    });
    return bones;
  }
}

export default RigSystem;
