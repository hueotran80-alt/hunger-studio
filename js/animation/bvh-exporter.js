/**
 * Spec-compliant BioVision Hierarchy (.bvh) Exporter for rigged Three.js characters + AnimationClips.
 *
 * Emits standard `HIERARCHY` + `MOTION` blocks with continuous unwrapped `ZXY` Euler
 * rotations (no ±180° gimbal discontinuities between consecutive keyframes), ready for
 * Blender, Maya, Unreal Engine, MotionBuilder, and Godot BVH importers.
 */

import * as THREE from 'three';

const _tmpQuat = new THREE.Quaternion();
const _tmpQuat2 = new THREE.Quaternion();
const _identityQuat = new THREE.Quaternion();

function fmt(n) {
  const v = Math.abs(n) < 1e-5 ? 0 : n;
  return v.toFixed(4);
}

function sanitizeBoneName(name, fallbackIdx = 0) {
  const clean = String(name || `Bone_${fallbackIdx}`).replace(/[^A-Za-z0-9_.:-]/g, '_');
  return clean || `Bone_${fallbackIdx}`;
}

function findRootBone(character) {
  if (!character) return null;
  let hipsCandidate = null;
  let firstBone = null;
  character.traverse((o) => {
    if (!o.isBone) return;
    if (!firstBone) firstBone = o;
    const n = (o.name || '').toLowerCase();
    if (!hipsCandidate && (n.includes('hips') || n.includes('pelvis') || n === 'j_bip_c_hips')) {
      hipsCandidate = o;
    }
  });
  return hipsCandidate || firstBone;
}

/**
 * Unwrap Euler angle `curDeg` cleanly to stay within `±180°` of `prevDeg`.
 */
function unwrapDeg(prevDeg, curDeg) {
  if (!Number.isFinite(prevDeg)) return curDeg;
  let d = curDeg;
  while (d - prevDeg > 180) d -= 360;
  while (d - prevDeg < -180) d += 360;
  return d;
}

/**
 * Serialize a rigged character + `THREE.AnimationClip` to standard `.bvh` text.
 * Preserves the caller's current pose after sampling all clip frames.
 *
 * @param {THREE.Object3D} character
 * @param {THREE.AnimationClip} clip
 * @param {{fps?:number, scale?:number, includeFingers?:boolean, endSiteLength?:number}} [options]
 * @returns {{ bvh: string, boneCount: number, frameCount: number, frameTime: number, duration: number }}
 */
export function exportClipToBVH(character, clip, options = {}) {
  if (!character || !clip) {
    throw new Error('exportClipToBVH requires both a rigged character and an AnimationClip.');
  }
  const rootBone = findRootBone(character);
  if (!rootBone) {
    throw new Error('No THREE.Bone hierarchy found on character.');
  }

  const fps = Math.max(10, Math.min(120, Number(options.fps) || 30));
  const scale = Number(options.scale ?? 1.0);
  const includeFingers = options.includeFingers !== false;
  const endSiteLength = Number(options.endSiteLength ?? 0.08) * scale;
  const frameTime = 1 / fps;
  const duration = Math.max(frameTime, Number(clip.duration) || 0);
  const frameCount = Math.max(1, Math.round(duration * fps) + 1);

  // Save current pose across character bones so export is non-destructive
  const savedTransforms = new Map();
  character.traverse((o) => {
    if (o.isBone || o === character) {
      savedTransforms.set(o, {
        position: o.position.clone(),
        quaternion: o.quaternion.clone(),
        scale: o.scale.clone(),
      });
    }
  });

  // Pose SkinnedMeshes cleanly to bind pose when valid boneInverses exist so offsets reflect true rest T-pose
  character.traverse((o) => {
    if (o.isSkinnedMesh && o.skeleton && Array.isArray(o.skeleton.boneInverses) && o.skeleton.boneInverses.length === o.skeleton.bones.length && o.skeleton.bones.length >= 2) {
      const hasValidInv = o.skeleton.boneInverses.some((m) => Math.abs(m.determinant()) > 1e-12);
      if (hasValidInv) {
        try { o.skeleton.pose(); } catch (_) { /* ignore */ }
      }
    }
  });
  character.updateMatrixWorld(true);

  const invCharWorld = character.matrixWorld.clone().invert();
  const _tmpPos = new THREE.Vector3();
  const _tmpQuatChar = new THREE.Quaternion();
  const _tmpScale = new THREE.Vector3();
  character.matrixWorld.decompose(_tmpPos, _tmpQuatChar, _tmpScale);

  // Record rest positions and rest quaternions in character-root world frame (zero-rotation BVH convention)
  const restPosInChar = new Map();
  const restQuatInChar = new Map();
  const restLocalQuat = new Map();
  const restMat = new THREE.Matrix4();
  character.traverse((o) => {
    if (o === character || o.isBone || o === rootBone.parent) {
      restMat.multiplyMatrices(invCharWorld, o.matrixWorld);
      const pos = new THREE.Vector3();
      const quat = new THREE.Quaternion();
      restMat.decompose(pos, quat, _tmpScale);
      restPosInChar.set(o, pos.multiplyScalar(scale));
      restQuatInChar.set(o, quat.normalize());
      if (o.isBone) restLocalQuat.set(o, o.quaternion.clone().normalize());
    }
  });

  // Collect ordered bone traversal tree
  const orderedBones = [];
  const collectBoneChildren = (bone) => {
    const rawKids = (bone.children || []).filter((c) => c.isBone);
    if (includeFingers) return rawKids;
    return rawKids.filter((c) => !/thumb|index|middle|ring|pinky/i.test(c.name || ''));
  };

  const lines = ['HIERARCHY'];
  const emitNode = (bone, depth, isRoot) => {
    const indent = '  '.repeat(depth);
    const name = sanitizeBoneName(bone.name, orderedBones.length);
    orderedBones.push({ bone, name, isRoot });

    const boneRestPos = restPosInChar.get(bone) || new THREE.Vector3();
    const parentRestPos = (!isRoot && bone.parent && restPosInChar.has(bone.parent)) ? restPosInChar.get(bone.parent) : null;
    const offset = (isRoot || !parentRestPos)
      ? new THREE.Vector3(0, 0, 0)
      : boneRestPos.clone().sub(parentRestPos);
    lines.push(`${indent}${isRoot ? 'ROOT' : 'JOINT'} ${name}`);
    lines.push(`${indent}{`);
    lines.push(`${indent}  OFFSET ${fmt(offset.x)} ${fmt(offset.y)} ${fmt(offset.z)}`);
    if (isRoot) {
      lines.push(`${indent}  CHANNELS 6 Xposition Yposition Zposition Zrotation Xrotation Yrotation`);
    } else {
      lines.push(`${indent}  CHANNELS 3 Zrotation Xrotation Yrotation`);
    }

    const kids = collectBoneChildren(bone);
    if (kids.length === 0) {
      // Synthetic End Site pointing along bone's character-world rest axis (away from parent)
      const dir = offset.lengthSq() > 1e-6
        ? offset.clone().normalize().multiplyScalar(endSiteLength)
        : new THREE.Vector3(0, endSiteLength, 0);
      lines.push(`${indent}  End Site`);
      lines.push(`${indent}  {`);
      lines.push(`${indent}    OFFSET ${fmt(dir.x)} ${fmt(dir.y)} ${fmt(dir.z)}`);
      lines.push(`${indent}  }`);
    } else {
      for (const kid of kids) {
        emitNode(kid, depth + 1, false);
      }
    }
    lines.push(`${indent}}`);
  };

  emitNode(rootBone, 0, true);

  // Sample AnimationMixer cleanly per frame & convert quaternions -> continuous unwrapped ZXY degrees
  const mixer = new THREE.AnimationMixer(character);
  const action = mixer.clipAction(clip);
  action.reset();
  action.enabled = true;
  action.setEffectiveWeight(1.0);
  action.setLoop(THREE.LoopOnce, 1);
  action.clampWhenFinished = true;
  action.play();

  const motionLines = [
    'MOTION',
    `Frames: ${frameCount}`,
    `Frame Time: ${frameTime.toFixed(6)}`,
  ];

  const RAD2DEG = 180 / Math.PI;
  const euler = new THREE.Euler(0, 0, 0, 'ZXY');
  const prevAngles = orderedBones.map(() => [NaN, NaN, NaN]);
  const rootPosWorld = new THREE.Vector3();
  const deltaLocalQ = new THREE.Quaternion();
  const bvhQuat = new THREE.Quaternion();

  try {
    for (let f = 0; f < frameCount; f++) {
      const t = Math.min(duration, f * frameTime);
      mixer.setTime(t);
      character.updateMatrixWorld(true);

      const vals = [];
      for (let bi = 0; bi < orderedBones.length; bi++) {
        const entry = orderedBones[bi];
        const b = entry.bone;

        if (entry.isRoot) {
          // Convert root bone position into character-space metric coordinates
          b.getWorldPosition(rootPosWorld);
          rootPosWorld.applyMatrix4(invCharWorld);
          vals.push(
            fmt(rootPosWorld.x * scale),
            fmt(rootPosWorld.y * scale),
            fmt(rootPosWorld.z * scale),
          );
        }

        // Conjugate delta rotation from rest pose into BVH zero-rest parent frame:
        // R_bvh = W_rest(parent) * (q_anim_local * q_rest_local^-1) * W_rest(parent)^-1
        const qRestLocal = restLocalQuat.get(b) || b.quaternion;
        const wRestParent = (b.parent && restQuatInChar.get(b.parent)) || _identityQuat;
        deltaLocalQ.copy(b.quaternion).multiply(_tmpQuat.copy(qRestLocal).invert()).normalize();
        bvhQuat.copy(wRestParent).multiply(deltaLocalQ).multiply(_tmpQuat2.copy(wRestParent).invert()).normalize();

        euler.setFromQuaternion(bvhQuat, 'ZXY');
        const rz = unwrapDeg(prevAngles[bi][0], euler.z * RAD2DEG);
        const rx = unwrapDeg(prevAngles[bi][1], euler.x * RAD2DEG);
        const ry = unwrapDeg(prevAngles[bi][2], euler.y * RAD2DEG);
        prevAngles[bi][0] = rz;
        prevAngles[bi][1] = rx;
        prevAngles[bi][2] = ry;
        vals.push(fmt(rz), fmt(rx), fmt(ry));
      }
      motionLines.push(vals.join(' '));
    }
  } finally {
    action.stop();
    mixer.stopAllAction();
    mixer.uncacheRoot(character);
    for (const [obj, tr] of savedTransforms.entries()) {
      obj.position.copy(tr.position);
      obj.quaternion.copy(tr.quaternion);
      obj.scale.copy(tr.scale);
    }
    character.updateMatrixWorld(true);
  }

  const bvh = `${lines.join('\n')}\n${motionLines.join('\n')}\n`;
  return {
    bvh,
    boneCount: orderedBones.length,
    frameCount,
    frameTime,
    duration,
  };
}

export default exportClipToBVH;
