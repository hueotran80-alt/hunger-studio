/**
 * Web Blender Studio - High-Precision Mocap Retargeter Engine
 * File: js/animation/mocap-retargeter.js
 *
 * Maps 3D skeletal motion capture data (MediaPipe 3D metric joints)
 * onto rigged humanoid characters (Mixamo, Blender Rigify, glTF humanoids).
 *
 * Upgraded Anti-Distortion & Full-Body Retargeting Pipeline:
 * - Pure horizontal Yaw alignment (autoAlignQ around world +Y) so world gravity
 *   is never tilted by camera pitch or bind-pose spine lean.
 * - Dominant clip orientation estimation using circular median across all
 *   frames (immune to dark fade-in frames at video start).
 * - Combined hip + shoulder torso basis so single-hip depth jitter never spins
 *   the pelvis.
 * - Upright-stabilized pelvis (~28% of torso lean) + multi-bone spine
 *   distribution (Spine, Spine1, Spine2/Chest) + subtle clavicle & head motion.
 * - Anatomical limb constraints: depth-jitter damping, anti-crossover leg
 *   corridor (prevents scissor/knock-kneed legs), knee/elbow hinge limits, and
 *   pure swing limb solving (eliminates collinear T-pose twist explosions).
 * - Proper parent-space root translation via inverse parent matrixWorld
 *   (supports 0.01x scaled & ±90° rotated Mixamo GLBs) + automatic floor
 *   grounding so feet stay planted on the ground instead of floating.
 * - Zero-phase forward-backward SLERP smoothing & quaternion hemisphere
 *   continuity (prevents 360° interpolation flips).
 */

import * as THREE from 'three';
import { applyFootLock } from './mocap-filters.js';
import { median as medianOf } from './mocap-math.js';
import {
  initMocapKernel,
  isMocapKernelReady,
  applyFootLockWasm,
  retargetHumanoidWasm,
} from './mocap-kernel-bridge.js';
import { solveHandAndFingerTracks, applyTwistDistribution } from './hand-solver.js';
import { solveFaceAndExpressionTracks } from './face-solver.js';
import { exportClipToBVH } from './bvh-exporter.js';
import { exportClipToFBX } from './fbx-exporter.js';

const _Y_AXIS = new THREE.Vector3(0, 1, 0);
const _IDENTITY_Q = new THREE.Quaternion();
const _BIND_POSE_CACHE = new WeakMap();

/**
 * Convert raw MediaPipe world landmarks (+Y down, +Z away from viewer) to
 * Three.js world space (+Y up, +Z toward viewer) if not already Y-up.
 */
function _normalizeFramesYUp(frames) {
  if (!Array.isArray(frames) || frames.length === 0) return frames;
  const torsoDys = [];
  const legDys = [];
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    if (!f) continue;
    const ls = f.leftShoulder;
    const rs = f.rightShoulder;
    const lh = f.leftHip;
    const rh = f.rightHip;
    const la = f.leftAnkle;
    if (ls && rs && lh && rh) {
      torsoDys.push(0.5 * (ls[1] + rs[1]) - 0.5 * (lh[1] + rh[1]));
    }
    if (lh && la) {
      legDys.push(lh[1] - la[1]);
    }
  }
  const medTorso = torsoDys.length ? medianOf(torsoDys) : 1;
  const medLeg = legDys.length ? medianOf(legDys) : 1;
  if (!(medTorso < -0.05 || medLeg < -0.05)) {
    return frames;
  }

  return frames.map((f) => {
    if (!f) return f;
    const out = {};
    for (const key of Object.keys(f)) {
      const val = f[key];
      if (Array.isArray(val) && val.length >= 3) {
        out[key] = [val[0], -val[1], -val[2]];
      } else {
        out[key] = val;
      }
    }
    for (const extra of ['leftHeel', 'rightHeel']) {
      if (!(extra in out) && Array.isArray(f[extra]) && f[extra].length >= 3) {
        Object.defineProperty(out, extra, {
          value: [f[extra][0], -f[extra][1], -f[extra][2]],
          enumerable: false,
          configurable: true,
          writable: true,
        });
      }
    }
    return out;
  });
}

function signedAngleXZ(a, b) {
  const crossY = a.z * b.x - a.x * b.z;
  const dot = a.x * b.x + a.z * b.z;
  return Math.atan2(crossY, dot);
}

function basisQuaternion(side, up, fwd) {
  const m = new THREE.Matrix4().makeBasis(side, up, fwd);
  return new THREE.Quaternion().setFromRotationMatrix(m);
}

function v3(arr) {
  if (!arr || arr.length < 3) return new THREE.Vector3();
  return new THREE.Vector3(Number(arr[0]) || 0, Number(arr[1]) || 0, Number(arr[2]) || 0);
}

function clampQuaternionAngle(q, maxRad) {
  const w = THREE.MathUtils.clamp(q.w, -1, 1);
  let angle = 2 * Math.acos(Math.abs(w));
  if (angle <= maxRad || angle < 1e-6) return q;
  const sinHalf = Math.sqrt(Math.max(1e-10, 1 - w * w));
  const sign = w < 0 ? -1 : 1;
  const axis = new THREE.Vector3(q.x * sign / sinHalf, q.y * sign / sinHalf, q.z * sign / sinHalf);
  return new THREE.Quaternion().setFromAxisAngle(axis, maxRad);
}

export class MocapRetargeter {
  constructor(engine, sceneManager, timelineEngine = null) {
    this.engine = engine;
    this.sceneManager = sceneManager;
    this.timelineEngine = timelineEngine;

    this.character = null;
    this.mixer = null;
    this.action = null;
    this.currentClip = null;
    this.mocapData = null;
    this.isPlaying = false;
    this.boneMap = new Map();
    this.lastAlignment = null;

    // Bind pose cache: retargeting must always start from the original rest
    // pose, otherwise a previously applied mocap take leaks into the next one.
    this._bindCharacter = null;
    this._bindQuats = null;
    this._bindPositions = null;

    // Bind update to engine render loop
    this._onEngineBeforeRender = (delta) => this._update({ delta });
    if (this.engine && typeof this.engine.addRenderCallback === 'function') {
      this.engine.addRenderCallback(this._onEngineBeforeRender, { isActive: () => this.isPlaying });
    }

    // Mocap WASM kernel initializes lazily during retarget/tracking.
  }

  /**
   * Scans a character hierarchy and identifies semantic humanoid bones.
   * Prioritizes exact stripped name matches and excludes finger/end bones.
   */
  _mapBones(root) {
    this.boneMap.clear();
    const allBones = [];

    root.traverse((child) => {
      if (child.isBone) {
        allBones.push(child);
      }
    });

    // Prefer Rigify DEF- deformation bones over ORG-/MCH-/control bones when stripped names collide
    const deformPriority = (rawName) => {
      const s = String(rawName || '');
      if (/^def[_:-]/i.test(s)) return 0;
      if (/^(?:org|mch|ctrl|tgt|cs)[_:-]/i.test(s)) return 2;
      return 1;
    };
    const sortedBones = [...allBones].sort((a, b) => deformPriority(a.name) - deformPriority(b.name));

    const stripName = (raw) => {
      let s = String(raw || '').toLowerCase();
      s = s.replace(/^(mixamorig[_:-]?|armature[_:-]?|bip01[_:-]?|def[_:-]?|org[_:-]?|mch[_:-]?|chr[_:-]?|cc(base|game)[_:-]?)/i, '');
      s = s.replace(/[^a-z0-9]/g, '');
      // Rigify spine.001 / spine.002 / spine.003 normalization -> spine1 / spine2
      s = s.replace(/^spine00([1-6])$/, 'spine$1');
      // VRM / VRoid humanoid names: J_Bip_C_Hips, J_Bip_L_UpperArm, J_Sec_*.
      // The side letter becomes a SUFFIX so the existing aliases keep working
      // ("upperarml", "handl", "footl" …) instead of losing the left/right side.
      s = s.replace(/^j(bip|sec|adj)([cslr])([a-z].*)$/, (m, kind, side, rest) =>
        (side === 'c' ? rest : `${rest}${side}`));
      return s;
    };

    const isFingerOrEnd = (clean) =>
      /thumb|index|middle|ring|pinky|toeend|headtopend|eye|jaw|roll|twist/i.test(clean);

    const aliases = {
      hips: ['hips', 'pelvis', 'hip'],
      spine: ['spine', 'waist', 'abdomen', 'torso'],
      spine1: ['spine1', 'spine01', 'chest1'],
      spine2: ['spine2', 'spine02', 'spine03', 'spine3', 'chest', 'upperchest'],
      neck: ['neck', 'neck01', 'neck1'],
      head: ['head'],
      leftShoulder: ['leftshoulder', 'claviclel', 'shoulderl', 'lshoulder', 'lclavicle'],
      leftArm: ['leftarm', 'leftupperarm', 'upperarml', 'arml', 'lupperarm', 'larm'],
      leftForearm: ['leftforearm', 'leftlowerarm', 'lowerarml', 'forearml', 'llowerarm', 'lforearm'],
      leftHand: ['lefthand', 'handl', 'wristl', 'lhand', 'lwrist'],
      rightShoulder: ['rightshoulder', 'clavicler', 'shoulderr', 'rshoulder', 'rclavicle'],
      rightArm: ['rightarm', 'rightupperarm', 'upperarmr', 'armr', 'rupperarm', 'rarm'],
      rightForearm: ['rightforearm', 'rightlowerarm', 'lowerarmr', 'forearmr', 'rlowerarm', 'rforearm'],
      rightHand: ['righthand', 'handr', 'wristr', 'rhand', 'rwrist'],
      leftUpLeg: ['leftupleg', 'leftthigh', 'thighl', 'upperlegl', 'lupleg', 'lthigh', 'leftupperleg'],
      leftLeg: ['leftleg', 'leftcalf', 'calfl', 'lowerlegl', 'shinl', 'lleg', 'lcalf', 'leftlowerleg'],
      leftFoot: ['leftfoot', 'footl', 'anklel', 'lfoot', 'lankle'],
      leftToeBase: ['lefttoebase', 'lefttoe', 'toebasel', 'toel', 'ltoe', 'ltoebase', 'balll', 'leftball', 'toebase_l'],
      rightUpLeg: ['rightupleg', 'rightthigh', 'thighr', 'upperlegr', 'rupleg', 'rthigh', 'rightupperleg'],
      rightLeg: ['rightleg', 'rightcalf', 'calfr', 'lowerlegr', 'shinr', 'rleg', 'rcalf', 'rightlowerleg'],
      rightFoot: ['rightfoot', 'footr', 'ankler', 'rfoot', 'rankle'],
      rightToeBase: ['righttoebase', 'righttoe', 'toebaser', 'toer', 'rtoe', 'rtoebase', 'ballr', 'rightball', 'toebase_r'],
    };

    const mapped = {};
    const usedBones = new Set();

    // Hierarchical spine solver for numbered spine chains without a bare `spine` bone
    // (UE5 `spine_01..03/05`, Rigify `DEF-spine.001..003`, CC4 `Spine01..02` without Waist):
    // Prevents `spine_01` from claiming `spine1` and `spine_03` from inverting into `spine`.
    const boneDepth = (bone) => {
      let d = 0;
      let p = bone.parent;
      while (p && p !== root) { d++; p = p.parent; }
      return d;
    };
    const hasBareSpine = sortedBones.some((b) => {
      const c = stripName(b.name);
      return !isFingerOrEnd(c) && aliases.spine.includes(c);
    });
    if (!hasBareSpine) {
      const numberedSpines = sortedBones
        .map((b) => ({ bone: b, clean: stripName(b.name), depth: boneDepth(b) }))
        .filter((x) => !isFingerOrEnd(x.clean))
        .map((x) => {
          const m = x.clean.match(/^spine0*([1-9]\d*)$/);
          return m ? { ...x, idx: parseInt(m[1], 10) } : null;
        })
        .filter(Boolean)
        .sort((a, b) => (a.depth - b.depth) || (a.idx - b.idx));
      if (numberedSpines.length >= 3) {
        mapped.spine = numberedSpines[0].bone;
        mapped.spine1 = numberedSpines[1].bone;
        mapped.spine2 = numberedSpines[numberedSpines.length - 1].bone;
      } else if (numberedSpines.length === 2) {
        mapped.spine = numberedSpines[0].bone;
        mapped.spine2 = numberedSpines[1].bone;
      } else if (numberedSpines.length === 1) {
        mapped.spine = numberedSpines[0].bone;
      }
      for (const k of ['spine', 'spine1', 'spine2']) {
        if (mapped[k]) {
          usedBones.add(mapped[k]);
          this.boneMap.set(k, mapped[k]);
        }
      }
    }

    // Pass 1: exact stripped match
    for (const [key, aliasList] of Object.entries(aliases)) {
      if (mapped[key]) continue;
      for (const bone of sortedBones) {
        if (usedBones.has(bone)) continue;
        const clean = stripName(bone.name);
        if (isFingerOrEnd(clean)) continue;
        if (aliasList.includes(clean)) {
          mapped[key] = bone;
          usedBones.add(bone);
          this.boneMap.set(key, bone);
          break;
        }
      }
    }

    // Pass 2: substring match for any remaining unmapped keys
    for (const [key, aliasList] of Object.entries(aliases)) {
      if (mapped[key]) continue;
      for (const bone of sortedBones) {
        if (usedBones.has(bone)) continue;
        const clean = stripName(bone.name);
        if (isFingerOrEnd(clean)) continue;
        if (aliasList.some((a) => clean.includes(a))) {
          mapped[key] = bone;
          usedBones.add(bone);
          this.boneMap.set(key, bone);
          break;
        }
      }
    }

    // Pass 3: some rigs only expose twist bones for the neck (Character Creator
    // ships CC_Base_NeckTwist01/02). A twist bone is a worse anchor than a
    // clean neck bone but far better than leaving the head un-driven.
    if (!mapped.neck) {
      for (const bone of sortedBones) {
        if (usedBones.has(bone)) continue;
        const clean = stripName(bone.name);
        if (clean.includes('neck') && /twist/i.test(bone.name)) {
          mapped.neck = bone;
          usedBones.add(bone);
          this.boneMap.set('neck', bone);
          break;
        }
      }
    }

    // Fallback child discovery for ToeBase when naming differs
    if (!mapped.leftToeBase && mapped.leftFoot) {
      const toe = this._findToeBone(mapped.leftFoot);
      if (toe && !usedBones.has(toe)) {
        mapped.leftToeBase = toe;
        usedBones.add(toe);
        this.boneMap.set('leftToeBase', toe);
      }
    }
    if (!mapped.rightToeBase && mapped.rightFoot) {
      const toe = this._findToeBone(mapped.rightFoot);
      if (toe && !usedBones.has(toe)) {
        mapped.rightToeBase = toe;
        usedBones.add(toe);
        this.boneMap.set('rightToeBase', toe);
      }
    }

    this.extBoneMap = this._mapExtendedBones(sortedBones, usedBones, stripName);

    return mapped;
  }

  _mapExtendedBones(allBones, usedBones, stripName) {
    const fingers = {};
    const twists = {};
    let jaw = null;

    const matchSide = (rawName, clean) => {
      if (/(^|[^a-z])(left|l)([^a-z]|$)/i.test(rawName) || clean.startsWith('left') || clean.startsWith('lhand') || /(l$|\d+l$)/.test(clean)) {
        return 'left';
      }
      if (/(^|[^a-z])(right|r)([^a-z]|$)/i.test(rawName) || clean.startsWith('right') || clean.startsWith('rhand') || /(r$|\d+r$)/.test(clean)) {
        return 'right';
      }
      return null;
    };

    const fingerNames = ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky'];
    for (const bone of allBones) {
      if (usedBones.has(bone)) continue;
      const raw = bone.name || '';
      const clean = stripName(raw);
      if (!jaw && (clean === 'jaw' || clean === 'jawbone' || clean === 'chin')) {
        jaw = bone;
        usedBones.add(bone);
        continue;
      }
      if (/end|tip|metacarpal|carpal/i.test(clean)) continue;
      const side = matchSide(raw, clean);
      if (!side) continue;

      if (/twist|roll/i.test(clean)) {
        if (/forearm|lowerarm/.test(clean) && !twists[`${side}ForearmTwist`]) {
          twists[`${side}ForearmTwist`] = bone;
          usedBones.add(bone);
        } else if (/upperarm|arm/.test(clean) && !twists[`${side}ArmTwist`]) {
          twists[`${side}ArmTwist`] = bone;
          usedBones.add(bone);
        } else if (/upleg|thigh|upperleg/.test(clean) && !twists[`${side}UpLegTwist`]) {
          twists[`${side}UpLegTwist`] = bone;
          usedBones.add(bone);
        }
        continue;
      }

      for (const fName of fingerNames) {
        const lower = fName.toLowerCase();
        if (!clean.includes(lower) && !(fName === 'Pinky' && clean.includes('little'))) continue;
        const m = clean.match(/(?:thumb|index|middle|ring|pinky|little)0?([1-3])/);
        if (m) {
          const segIdx = m[1];
          const key = `${side}Hand${fName}${segIdx}`;
          if (!fingers[key]) {
            fingers[key] = bone;
            usedBones.add(bone);
          }
          break;
        }
      }
    }

    return { fingers, twists, jaw };
  }

  /**
   * Measure torso & thigh capsule radii directly from SkinnedMesh bind vertices
   * so self-collision avoidance in Rust adapts accurately to slim or bulky avatars.
   */
  _measureCharacterLimbRadii(character, bones, restWorldPositions) {
    const defaults = { torsoRadius: 0.145, thighRadius: 0.085 };
    if (!character || !bones) return defaults;

    const spineBone = bones.spine1 || bones.spine || bones.hips;
    const upBone = bones.spine2 || bones.neck;
    const thighBone = bones.leftUpLeg;
    const shinBone = bones.leftLeg;

    const spineA = spineBone ? restWorldPositions.get(spineBone.name) : null;
    const spineB = upBone ? restWorldPositions.get(upBone.name) : null;
    const thighA = thighBone ? restWorldPositions.get(thighBone.name) : null;
    const thighB = shinBone ? restWorldPositions.get(shinBone.name) : null;
    if (!spineA && !thighA) return defaults;

    const torsoBones = new Set([bones.spine, bones.spine1, bones.spine2].filter(Boolean));
    const thighBones = new Set([bones.leftUpLeg, bones.rightUpLeg].filter(Boolean));

    const torsoDists = [];
    const thighDists = [];
    const vTmp = new THREE.Vector3();
    const pClosest = new THREE.Vector3();

    const segDist = (pt, a, b) => {
      const abX = b.x - a.x;
      const abY = b.y - a.y;
      const abZ = b.z - a.z;
      const l2 = abX * abX + abY * abY + abZ * abZ;
      if (l2 < 1e-8) return pt.distanceTo(a);
      const t = THREE.MathUtils.clamp(((pt.x - a.x) * abX + (pt.y - a.y) * abY + (pt.z - a.z) * abZ) / l2, 0, 1);
      pClosest.set(a.x + abX * t, a.y + abY * t, a.z + abZ * t);
      return pt.distanceTo(pClosest);
    };

    character.traverse((obj) => {
      if (!obj.isSkinnedMesh || !obj.skeleton || !obj.geometry) return;
      const posAttr = obj.geometry.attributes?.position;
      const idxAttr = obj.geometry.attributes?.skinIndex;
      const wgtAttr = obj.geometry.attributes?.skinWeight;
      if (!posAttr || !idxAttr || !wgtAttr) return;

      const skelBones = obj.skeleton.bones;
      const bindMat = obj.bindMatrix || obj.matrixWorld;
      const step = Math.max(1, Math.floor(posAttr.count / 900));
      for (let i = 0; i < posAttr.count; i += step) {
        const w0 = wgtAttr.getX(i);
        const bi0 = Math.round(idxAttr.getX(i));
        const bone0 = skelBones[bi0];
        if (!bone0 || w0 < 0.45) continue;

        vTmp.fromBufferAttribute(posAttr, i).applyMatrix4(bindMat);
        if (torsoBones.has(bone0) && spineA && spineB) {
          const d = segDist(vTmp, spineA, spineB);
          if (d > 0.04 && d < 0.35) torsoDists.push(d);
        } else if (thighBones.has(bone0) && thighA && thighB) {
          const a = bone0 === bones.rightUpLeg && bones.rightUpLeg && bones.rightLeg
            ? restWorldPositions.get(bones.rightUpLeg.name)
            : thighA;
          const b = bone0 === bones.rightUpLeg && bones.rightUpLeg && bones.rightLeg
            ? restWorldPositions.get(bones.rightLeg.name)
            : thighB;
          if (a && b) {
            const d = segDist(vTmp, a, b);
            if (d > 0.025 && d < 0.22) thighDists.push(d);
          }
        }
      }
    });

    const pct75 = (arr, fb, lo, hi) => {
      if (arr.length < 8) return fb;
      arr.sort((a, b) => a - b);
      const v = arr[Math.floor(arr.length * 0.75)];
      return THREE.MathUtils.clamp(v, lo, hi);
    };

    return {
      torsoRadius: Number(pct75(torsoDists, defaults.torsoRadius, 0.11, 0.24).toFixed(4)),
      thighRadius: Number(pct75(thighDists, defaults.thighRadius, 0.06, 0.15).toFixed(4)),
    };
  }

  _findToeBone(footBone) {
    if (!footBone) return null;
    for (const child of footBone.children) {
      if (child.isBone && /toe|ball/i.test(child.name)) return child;
    }
    for (const child of footBone.children) {
      if (child.isBone) return child;
    }
    return null;
  }

  /**
   * Capture a character's original rest/bind pose permanently in a WeakMap.
   * Subsequent calls on the same object never overwrite the original bind pose.
   */
  static captureBindPose(character) {
    if (!character) return null;
    if (_BIND_POSE_CACHE.has(character)) {
      return _BIND_POSE_CACHE.get(character);
    }
    const quats = new Map();
    const positions = new Map();
    const scales = new Map();
    character.traverse((o) => {
      if (o.isBone) {
        quats.set(o.name, o.quaternion.clone());
        positions.set(o.name, o.position.clone());
        scales.set(o.name, o.scale.clone());
      }
    });
    const entry = { quats, positions, scales };
    _BIND_POSE_CACHE.set(character, entry);
    return entry;
  }

  /**
   * Detach active timeline clips and stop/uncache AnimationMixer on `character`
   * before mutating bones so no mixer overwrites bind transforms on re-apply.
   */
  _detachAndCleanupMixer(character) {
    const timeline = this.timelineEngine || (typeof window !== 'undefined' ? window.timelineEngine : null);
    try {
      timeline?.detachClip?.(character);
    } catch (_) { /* ignore */ }
    if (this.mixer) {
      try {
        this.mixer.stopAllAction();
        if (this.character) this.mixer.uncacheRoot(this.character);
        if (character && character !== this.character) this.mixer.uncacheRoot(character);
      } catch (_) { /* ignore */ }
      this.mixer = null;
      this.action = null;
    }
  }

  /**
   * Capture the original bind pose once per character, then restore it before every take.
   */
  _ensureBindPose(character) {
    const entry = MocapRetargeter.captureBindPose(character);
    if (!entry) return;

    this._bindCharacter = character;
    this._bindQuats = entry.quats;
    this._bindPositions = entry.positions;

    character.traverse((o) => {
      if (!o.isBone) return;
      const q = entry.quats.get(o.name);
      const p = entry.positions.get(o.name);
      const s = entry.scales.get(o.name);
      if (q) o.quaternion.copy(q);
      if (p) o.position.copy(p);
      if (s) o.scale.copy(s);
    });
    character.updateMatrixWorld(true);
  }

  /**
   * Restore `character` cleanly back to its captured canonical bind pose.
   */
  restoreBindPose(character = this.character) {
    if (!character) return false;
    this._detachAndCleanupMixer(character);
    this._ensureBindPose(character);
    if (typeof window !== 'undefined') {
      try { window.rigSystem?.updateSkeletonHelper?.(); } catch (_) { /* ignore */ }
    }
    return true;
  }

  /**
   * Estimate dominant facing yaw & readable label for horizontal subject->character alignment.
   */
  _computeFacingSummary(frames, charBasis, mirrorX = false, autoAlign = true, yawOffsetDeg = 0) {
    let sumSin = 0;
    let sumCos = 0;
    let sumFz = 0;
    let sumFx = 0;
    let count = 0;

    const startIdx = frames.length > 20 ? Math.floor(frames.length * 0.08) : 0;
    const endIdx = frames.length > 20 ? Math.ceil(frames.length * 0.92) : frames.length;

    const readPt = (p) => (mirrorX ? [-p[0], p[1], p[2]] : p);

    for (let i = startIdx; i < endIdx; i++) {
      const f = frames[i];
      if (!f?.leftHip || !f?.rightHip || !f?.leftShoulder || !f?.rightShoulder) continue;
      const lh = v3(readPt(f.leftHip));
      const rh = v3(readPt(f.rightHip));
      const ls = v3(readPt(f.leftShoulder));
      const rs = v3(readPt(f.rightShoulder));

      const hipDiff = lh.sub(rh);
      const shDiff = ls.sub(rs);
      if (hipDiff.lengthSq() > 1e-8) hipDiff.normalize();
      if (shDiff.lengthSq() > 1e-8) shDiff.normalize();

      const pelvisSide = hipDiff.multiplyScalar(0.55).addScaledVector(shDiff, 0.45);
      const sideXZ = new THREE.Vector3(pelvisSide.x, 0, pelvisSide.z);
      if (sideXZ.lengthSq() <= 1e-6) continue;
      sideXZ.normalize();
      const fwdXZ = new THREE.Vector3().crossVectors(sideXZ, _Y_AXIS).normalize();
      const yaw = signedAngleXZ(fwdXZ, charBasis.fwd);
      sumSin += Math.sin(yaw);
      sumCos += Math.cos(yaw);
      sumFx += fwdXZ.x;
      sumFz += fwdXZ.z;
      count++;
    }

    const avgYaw = count > 0 ? Math.atan2(sumSin / count, sumCos / count) : 0;
    const inferredYawDeg = THREE.MathUtils.radToDeg(avgYaw);
    const avgFwdLen = Math.hypot(sumFx, sumFz);
    const avgFwdX = avgFwdLen > 1e-5 ? sumFx / avgFwdLen : charBasis.fwd.x;
    const avgFwdZ = avgFwdLen > 1e-5 ? sumFz / avgFwdLen : charBasis.fwd.z;
    const avgFz = THREE.MathUtils.clamp(count > 0 ? sumFz / count : 1, -1, 1);
    const angle = Math.round(THREE.MathUtils.radToDeg(Math.acos(avgFz)));
    let facingLabel = 'Front-facing (facing toward camera)';
    if (avgFz <= 0.6) {
      facingLabel = avgFz < -0.6
        ? 'Back-facing (turned away from camera)'
        : `Side-angled ~${angle}° relative to camera axis`;
    }

    const applyYawRad = THREE.MathUtils.degToRad((autoAlign ? inferredYawDeg : 0) + yawOffsetDeg);
    const videoMatchAzimuthDeg = THREE.MathUtils.radToDeg(applyYawRad);
    const baseFwdX = autoAlign ? charBasis.fwd.x : avgFwdX;
    const baseFwdZ = autoAlign ? charBasis.fwd.z : avgFwdZ;
    const yawOffRad = THREE.MathUtils.degToRad(yawOffsetDeg);
    const worldCharFwdX = baseFwdX * Math.cos(yawOffRad) + baseFwdZ * Math.sin(yawOffRad);
    const worldCharFwdZ = -baseFwdX * Math.sin(yawOffRad) + baseFwdZ * Math.cos(yawOffRad);
    const frontAzimuthDeg = THREE.MathUtils.radToDeg(Math.atan2(worldCharFwdX, worldCharFwdZ));

    return {
      inferredYawDeg,
      facingLabel,
      cameraHint: {
        videoMatchAzimuthDeg,
        frontAzimuthDeg,
        elevationDeg: 10,
      },
    };
  }

  _bindClipToMixer(character, clip) {
    this.currentClip = clip;
    character.animations = [clip];
    this.mixer = new THREE.AnimationMixer(character);
    this.action = this.mixer.clipAction(clip);
    if (clip.duration <= 1e-6) {
      this.action.setLoop(THREE.LoopOnce, 1);
      this.action.clampWhenFinished = true;
    } else {
      this.action.setLoop(THREE.LoopRepeat);
      this.action.clampWhenFinished = false;
    }
    this.action.play();
    this.isPlaying = true;
    this.engine?.requestRender?.();
  }

  /**
   * High-precision Retargeting using 3D Metric Mocap Frames
   *
   * @param {THREE.Object3D} character target rig
   * @param {Object} mocapResult output of /api/mocap/track
   * @param {Object} options {
   *   autoAlign = true,
   *   yawOffsetDeg = 0,
   *   groundFeet = true,
   *   rootMotion = true,
   *   rootMotionScale = 0.85,
   *   smoothing = 0.35,
   *   depthStability = 0.50,
   *   footLock = true,
   * }
   */
  retarget(character, mocapResult, options = {}) {
    if (!character) {
      return { success: false, error: 'No character specified' };
    }
    if (!mocapResult || (!mocapResult.mocapFrames && !mocapResult.animationClip)) {
      return { success: false, error: 'Invalid mocap animation data' };
    }

    const rawSourceFrames = mocapResult.rawMocapFrames || mocapResult.mocapFrames;
    if (!rawSourceFrames || rawSourceFrames.length === 0) {
      return { success: false, error: 'No 3D mocap frames available' };
    }

    let frames = _normalizeFramesYUp(rawSourceFrames);

    // Foot-Lock IK: anchor planted feet so the character stops sliding.
    let footLockCounts = null;
    let footLockFlags = null;
    if (options.footLockFlags && options.footLockFlags.length >= frames.length * 2) {
      footLockFlags = options.footLockFlags;
    } else if (options.footLock !== false) {
      const fpsVal = Number(mocapResult.fps) || 30;
      const wasmLock = isMocapKernelReady()
        ? applyFootLockWasm(frames, {
          fps: fpsVal,
          heightTol: options.footLockHeightTol,
          speedTol: options.footLockSpeedTol,
        })
        : null;
      if (wasmLock) {
        frames = wasmLock.frames;
        footLockCounts = wasmLock.locked;
        footLockFlags = wasmLock.flags;
      } else {
        const locked = applyFootLock(frames, {
          fps: fpsVal,
          heightTol: options.footLockHeightTol,
          speedTol: options.footLockSpeedTol,
        });
        frames = locked.frames;
        footLockCounts = locked.locked;
      }
    }

    this.character = character;
    this.mocapData = mocapResult;

    const autoAlign = options.autoAlign !== false;
    const yawOffsetDeg = Number(options.yawOffsetDeg) || 0;
    const groundFeet = options.groundFeet !== false;
    const enableRootMotion = options.rootMotion !== false;
    const rootMotionScale = THREE.MathUtils.clamp(
      options.rootMotionScale !== undefined ? Number(options.rootMotionScale) : 0.85,
      0,
      2.0
    );
    const smoothing = THREE.MathUtils.clamp(
      options.smoothing !== undefined ? Number(options.smoothing) : 0.35,
      0,
      0.92
    );
    const depthStability = THREE.MathUtils.clamp(
      options.depthStability !== undefined ? Number(options.depthStability) : 0.50,
      0,
      0.95
    );

    // 1. Map bones
    const bones = this._mapBones(character);
    if (!bones.hips) {
      return {
        success: false,
        error: `Could not find root Hips bone in model "${character.name}". Ensure model has a standard humanoid skeleton.`
      };
    }

    console.log(`[MocapRetargeter] Mapped bones for "${character.name}":`, Object.keys(bones));

    // 2. Detach any conflicting timeline clip & stop/uncache old mixer before editing bones
    this._detachAndCleanupMixer(character);

    // 3. Restore original canonical bind pose and read rest world transforms
    this._ensureBindPose(character);
    const restQuats = this._bindQuats;
    const restPositions = this._bindPositions;

    const restWorldPositions = new Map();
    const restWorldQuats = new Map();
    character.traverse((o) => {
      if (!o.isBone) return;
      restWorldPositions.set(o.name, o.getWorldPosition(new THREE.Vector3()));
      restWorldQuats.set(o.name, o.getWorldQuaternion(new THREE.Quaternion()));
    });

    // 4. Canonical Character Bind Basis (strictly horizontal XZ side/fwd & vertical +Y up)
    const wHips = restWorldPositions.get(bones.hips.name);
    const leftThighBone = bones.leftUpLeg || bones.leftLeg;
    const rightThighBone = bones.rightUpLeg || bones.rightLeg;
    const wLThigh = leftThighBone ? restWorldPositions.get(leftThighBone.name) : null;
    const wRThigh = rightThighBone ? restWorldPositions.get(rightThighBone.name) : null;

    let charBasis = {
      side: new THREE.Vector3(1, 0, 0),
      up: _Y_AXIS.clone(),
      fwd: new THREE.Vector3(0, 0, 1),
    };
    if (wLThigh && wRThigh) {
      const sideXZ = new THREE.Vector3(wLThigh.x - wRThigh.x, 0, wLThigh.z - wRThigh.z);
      if (sideXZ.lengthSq() > 1e-8) {
        sideXZ.normalize();
        const fwdXZ = new THREE.Vector3().crossVectors(sideXZ, _Y_AXIS).normalize();
        charBasis = { side: sideXZ, up: _Y_AXIS.clone(), fwd: fwdXZ };
      }
    }
    const qCharCanonical = basisQuaternion(charBasis.side, charBasis.up, charBasis.fwd);
    const qCharCanonicalInv = qCharCanonical.clone().invert();

    // 5. Measure rest limb directions in parent space (pure swing reference)
    const limbPairs = [
      { key: 'leftShoulder', bone: bones.leftShoulder, child: bones.leftArm },
      { key: 'leftArm', bone: bones.leftArm, child: bones.leftForearm },
      { key: 'leftForearm', bone: bones.leftForearm, child: bones.leftHand },
      { key: 'rightShoulder', bone: bones.rightShoulder, child: bones.rightArm },
      { key: 'rightArm', bone: bones.rightArm, child: bones.rightForearm },
      { key: 'rightForearm', bone: bones.rightForearm, child: bones.rightHand },
      { key: 'leftUpLeg', bone: bones.leftUpLeg, child: bones.leftLeg },
      { key: 'leftLeg', bone: bones.leftLeg, child: bones.leftFoot },
      { key: 'rightUpLeg', bone: bones.rightUpLeg, child: bones.rightLeg },
      { key: 'rightLeg', bone: bones.rightLeg, child: bones.rightFoot },
    ];

    const restBoneDirs = new Map();
    for (const pair of limbPairs) {
      if (!pair.bone || !pair.child || !pair.bone.parent) continue;
      const p1 = restWorldPositions.get(pair.bone.name);
      const p2 = restWorldPositions.get(pair.child.name);
      if (!p1 || !p2) continue;
      const dirWorld = p2.clone().sub(p1);
      if (dirWorld.lengthSq() < 1e-10) continue;
      dirWorld.normalize();

      const parentWorldQ = pair.bone.parent.getWorldQuaternion(new THREE.Quaternion());
      const dirParent = dirWorld.clone().applyQuaternion(parentWorldQ.invert());
      restBoneDirs.set(pair.bone.name, { dirParent, dirWorld });
    }

    // Hand rest directions (aligned with forearm at bind pose)
    for (const [handKey, forearmKey] of [['leftHand', 'leftForearm'], ['rightHand', 'rightForearm']]) {
      const handBone = bones[handKey];
      const forearmBone = bones[forearmKey];
      if (!handBone || !forearmBone || !handBone.parent) continue;
      const p1 = restWorldPositions.get(forearmBone.name);
      const p2 = restWorldPositions.get(handBone.name);
      if (!p1 || !p2) continue;
      const dirWorld = p2.clone().sub(p1);
      if (dirWorld.lengthSq() < 1e-8) continue;
      dirWorld.normalize();
      const parentWorldQ = handBone.parent.getWorldQuaternion(new THREE.Quaternion());
      restBoneDirs.set(handBone.name, {
        dirParent: dirWorld.clone().applyQuaternion(parentWorldQ.invert()),
        dirWorld,
      });
    }

    // Foot rest directions (ankle -> toe)
    const footPairs = [];
    if (bones.leftFoot) footPairs.push({ key: 'leftFoot', ankle: 'leftAnkle', toe: 'leftFoot', toeBone: this._findToeBone(bones.leftFoot) });
    if (bones.rightFoot) footPairs.push({ key: 'rightFoot', ankle: 'rightAnkle', toe: 'rightFoot', toeBone: this._findToeBone(bones.rightFoot) });
    const footRestDirs = new Map();
    for (const fp of footPairs) {
      const footBone = bones[fp.key];
      const footPos = restWorldPositions.get(footBone.name);
      const toePos = fp.toeBone ? restWorldPositions.get(fp.toeBone.name) : null;
      let dirWorld = (footPos && toePos) ? toePos.clone().sub(footPos) : null;
      if (!dirWorld || dirWorld.lengthSq() < 1e-8) {
        dirWorld = charBasis.fwd.clone().multiplyScalar(0.85).add(new THREE.Vector3(0, -0.5, 0));
      }
      dirWorld.normalize();
      const parentWorldQ = footBone.parent.getWorldQuaternion(new THREE.Quaternion());
      footRestDirs.set(fp.key, {
        dirParent: dirWorld.clone().applyQuaternion(parentWorldQ.invert()),
        dirWorld: dirWorld.clone(),
      });
    }

    // Measure lowest foot/toe world Y at bind pose for floor grounding
    const groundProbeBones = [
      bones.leftFoot,
      bones.rightFoot,
      this._findToeBone(bones.leftFoot),
      this._findToeBone(bones.rightFoot),
    ].filter(Boolean);
    let restMinFootY = 0;
    if (groundProbeBones.length > 0) {
      restMinFootY = Math.min(
        ...groundProbeBones.map((b) => restWorldPositions.get(b.name)?.y ?? 0)
      );
    }

    // 5b. Fast Pure-Rust WASM Kernel path (22-bone FK + Pole Vector Solver + Fullbody IK + Hermite Smooth)
    if (isMocapKernelReady() && !options.forceJS) {
      const limbRadii = this._measureCharacterLimbRadii(character, bones, restWorldPositions);
      const wasmRes = retargetHumanoidWasm({
        THREE,
        character,
        bones,
        restQuats,
        restPositions,
        restWorldPositions,
        restWorldQuats,
        charBasis,
        restMinFootY,
        frames,
        footLockFlags,
        fps: Number(mocapResult.fps) || 30,
        options: {
          autoAlign,
          yawOffsetDeg,
          groundFeet,
          rootMotion: enableRootMotion,
          rootMotionScale,
          smoothing,
          depthStability,
          mirrorX: Boolean(options.mirrorX),
          rootRotationWeight: options.rootRotationWeight,
          poleWeight: options.poleWeight,
          torsoRadius: limbRadii.torsoRadius,
          thighRadius: limbRadii.thighRadius,
          fullbodyIK: options.fullbodyIK !== false,
          visSeries: mocapResult.rawJointVisibilities || null,
        },
        findToeBone: (b) => this._findToeBone(b),
      });

      if (wasmRes && Array.isArray(wasmRes.tracks) && wasmRes.tracks.length > 0) {
        const facing = this._computeFacingSummary(
          frames,
          charBasis,
          Boolean(options.mirrorX),
          autoAlign,
          yawOffsetDeg,
        );
        const totalYawRad = THREE.MathUtils.degToRad((autoAlign ? facing.inferredYawDeg : 0) + yawOffsetDeg);
        const ext = this.extBoneMap || { fingers: {}, twists: {} };

        // Optional HandLandmarker finger + palm twist refinement
        let fingerTracksCount = 0;
        if (options.trackHands !== false && Array.isArray(mocapResult.handFrames) && wasmRes.coreQuatBuffers) {
          const fingerTracks = solveHandAndFingerTracks({
            handFrames: mocapResult.handFrames,
            rig: { ...bones, fingers: ext.fingers },
            times: wasmRes.times,
            fps: Number(mocapResult.fps) || 30,
            yFlip: -1,
            mirrorX: Boolean(options.mirrorX),
            totalYaw: totalYawRad,
            coreQuatBuffers: wasmRes.coreQuatBuffers,
            character,
          });
          fingerTracksCount = fingerTracks.length;
          for (const ft of fingerTracks) {
            wasmRes.tracks.push(ft);
          }
          // Sync any refined Hand track buffers cleanly into WASM track instances
          for (const hKey of ['leftHand', 'rightHand']) {
            const hb = bones[hKey];
            const buf = wasmRes.coreQuatBuffers[hKey];
            if (!hb || !buf) continue;
            const tr = wasmRes.tracks.find((t) => t.name === `${hb.name}.quaternion`);
            if (tr && tr.values?.length === buf.length) tr.values.set(buf);
          }
        }

        // Twist/Roll deformation bone distribution (ForearmTwist, ArmTwist, UpLegTwist)
        let twistTracksCount = 0;
        if (options.twistDistribution !== false && wasmRes.coreQuatBuffers) {
          const twistTracks = applyTwistDistribution({
            rig: { ...bones, twists: ext.twists },
            coreQuatBuffers: wasmRes.coreQuatBuffers,
            times: wasmRes.times,
            fps: Number(mocapResult.fps) || 30,
          });
          twistTracksCount = twistTracks.length;
          for (const tt of twistTracks) {
            wasmRes.tracks.push(tt);
          }
        }

        // Optional FaceLandmarker blendshapes + jaw + fine head pose refinement
        let faceTracksCount = 0;
        if (options.trackFace !== false && Array.isArray(mocapResult.faceFrames) && wasmRes.coreQuatBuffers) {
          const faceRes = solveFaceAndExpressionTracks({
            faceFrames: mocapResult.faceFrames,
            character,
            rig: { ...bones, jaw: ext.jaw || null },
            times: wasmRes.times,
            fps: Number(mocapResult.fps) || 30,
            mirrorX: Boolean(options.mirrorX),
            coreQuatBuffers: wasmRes.coreQuatBuffers,
          });
          faceTracksCount = faceRes.tracks.length;
          for (const ftr of faceRes.tracks) {
            wasmRes.tracks.push(ftr);
          }
          if (faceRes.headTrackUpdated && bones.head && wasmRes.coreQuatBuffers.head) {
            const htr = wasmRes.tracks.find((t) => t.name === `${bones.head.name}.quaternion`);
            if (htr && htr.values?.length === wasmRes.coreQuatBuffers.head.length) {
              htr.values.set(wasmRes.coreQuatBuffers.head);
            }
          }
        }

        const clip = new THREE.AnimationClip('Mocap_MediaPipe_Action', wasmRes.duration, wasmRes.tracks);
        this._bindClipToMixer(character, clip);

        this.lastAlignment = {
          autoAlign,
          yawOffsetDeg,
          inferredYawDeg: facing.inferredYawDeg,
          facingLabel: facing.facingLabel,
          cameraHint: facing.cameraHint,
          aligned: autoAlign,
          groundFeet,
          rootMotion: enableRootMotion,
          smoothing,
          depthStability,
          footLock: footLockCounts,
          fingerTracks: fingerTracksCount,
          twistTracks: twistTracksCount,
          faceTracks: faceTracksCount,
          limbRadii,
          engine: 'rust-wasm',
        };

        if (typeof window !== 'undefined') {
          try { window.rigSystem?.updateSkeletonHelper?.(); } catch (_) { /* ignore */ }
        }

        console.log(
          `[MocapRetargeter] Rust WASM retarget complete! ${wasmRes.tracks.length} tracks / ${wasmRes.numFrames} frames ` +
          `(${wasmRes.duration.toFixed(2)}s). Aligned: ${autoAlign}, inferred yaw ${facing.inferredYawDeg.toFixed(1)}°, facing: ${facing.facingLabel}.`
        );

        return {
          success: true,
          engine: 'rust-wasm',
          duration: wasmRes.duration,
          numFrames: wasmRes.numFrames,
          tracksCount: wasmRes.tracks.length,
          clipName: clip.name,
          inferredYawDeg: facing.inferredYawDeg,
          facingLabel: facing.facingLabel,
          aligned: autoAlign,
          autoAlign,
          yawOffsetDeg,
          cameraHint: facing.cameraHint,
          footLock: footLockCounts,
          fingerTracks: fingerTracksCount,
          twistTracks: twistTracksCount,
          faceTracks: faceTracksCount,
        };
      }
    }

    // 6. Subject torso basis per frame (blending hip & shoulder lines for stability)
    const frameBases = new Array(frames.length);
    const fwdSamples = [];

    for (let i = 0; i < frames.length; i++) {
      const f = frames[i];
      const lHip = v3(f.leftHip);
      const rHip = v3(f.rightHip);
      const lSh = v3(f.leftShoulder);
      const rSh = v3(f.rightShoulder);
      const midHipPt = v3(f.midHip);
      const neckPt = f.neck ? v3(f.neck) : v3(f.spine);

      const hipDiff = lHip.clone().sub(rHip);
      const shDiff = lSh.clone().sub(rSh);
      if (hipDiff.lengthSq() > 1e-8) hipDiff.normalize();
      if (shDiff.lengthSq() > 1e-8) shDiff.normalize();

      // Blend hip and shoulder lateral axes so single-hip depth noise cannot spin the pelvis
      const pelvisSide = hipDiff.clone().multiplyScalar(0.55).addScaledVector(shDiff, 0.45);
      const chestSide = shDiff.clone().multiplyScalar(0.80).addScaledVector(hipDiff, 0.20);
      if (pelvisSide.lengthSq() < 1e-8) pelvisSide.set(1, 0, 0);
      else pelvisSide.normalize();
      if (chestSide.lengthSq() < 1e-8) chestSide.copy(pelvisSide);
      else chestSide.normalize();

      const torsoUp = neckPt.clone().sub(midHipPt);
      if (torsoUp.lengthSq() < 1e-8) {
        torsoUp.set(0, 1, 0);
      } else {
        torsoUp.normalize();
        const t = Math.max(0, Math.min(1, (torsoUp.y + 0.22) / 0.57));
        const smoothW = t * t * (3 - 2 * t);
        torsoUp.lerp(_Y_AXIS, 1 - smoothW);
        if (torsoUp.lengthSq() < 1e-8) torsoUp.set(0, 1, 0);
        else torsoUp.normalize();
      }

      const sideXZ = new THREE.Vector3(pelvisSide.x, 0, pelvisSide.z);
      if (sideXZ.lengthSq() > 1e-6) sideXZ.normalize();
      else sideXZ.set(1, 0, 0);
      const fwdXZ = new THREE.Vector3().crossVectors(sideXZ, _Y_AXIS).normalize();

      frameBases[i] = { pelvisSide, chestSide, torsoUp, sideXZ, fwdXZ };
      fwdSamples.push(fwdXZ);
    }

    // Compute canonical subject reference basis using trimmed circular average
    // across the clip (ignores initial fade-in outlier frames).
    let refFwd = new THREE.Vector3(0, 0, 1);
    if (fwdSamples.length > 0) {
      const startIdx = fwdSamples.length > 20 ? Math.floor(fwdSamples.length * 0.08) : 0;
      const endIdx = fwdSamples.length > 20 ? Math.ceil(fwdSamples.length * 0.92) : fwdSamples.length;
      const sumFwd = new THREE.Vector3();
      for (let i = startIdx; i < endIdx; i++) {
        sumFwd.add(fwdSamples[i]);
      }
      if (sumFwd.lengthSq() > 1e-6) {
        refFwd.copy(sumFwd).setY(0).normalize();
      } else {
        refFwd.copy(fwdSamples[Math.floor(fwdSamples.length / 2)]);
      }
    }
    const refSide = new THREE.Vector3().crossVectors(_Y_AXIS, refFwd).normalize();
    const refBasis = { side: refSide, up: _Y_AXIS.clone(), fwd: refFwd };

    // Reference hip position (median of clip) = model origin
    const refMidHip = new THREE.Vector3(
      medianOf(frames.map((f) => f.midHip?.[0])) ?? 0,
      medianOf(frames.map((f) => f.midHip?.[1])) ?? 0,
      medianOf(frames.map((f) => f.midHip?.[2])) ?? 0
    );

    // 7. Pure Horizontal Yaw Alignment (Camera Space -> Model Space)
    const inferredYawDeg = THREE.MathUtils.radToDeg(signedAngleXZ(refBasis.fwd, charBasis.fwd));
    const autoAlignQ = new THREE.Quaternion().setFromAxisAngle(
      _Y_AXIS,
      autoAlign ? THREE.MathUtils.degToRad(inferredYawDeg) : 0
    );
    const yawOffsetQ = new THREE.Quaternion().setFromAxisAngle(
      _Y_AXIS,
      THREE.MathUtils.degToRad(yawOffsetDeg)
    );
    const alignQ = yawOffsetQ.clone().multiply(autoAlignQ);

    let facingLabel = 'Front-facing (facing toward camera)';
    {
      const fz = THREE.MathUtils.clamp(refBasis.fwd.z, -1, 1);
      const angle = Math.round(THREE.MathUtils.radToDeg(Math.acos(fz)));
      if (fz > 0.6) facingLabel = 'Front-facing (facing toward camera)';
      else if (fz < -0.6) facingLabel = 'Back-facing (turned away from camera)';
      else facingLabel = `Side-angled ~${angle}° relative to camera axis`;
    }

    // 8. Measure character height ratio vs mocap person (leg length)
    let heightScale = 1.0;
    if (bones.leftUpLeg && bones.leftLeg && bones.leftFoot) {
      const p1 = restWorldPositions.get(bones.leftUpLeg.name);
      const p2 = restWorldPositions.get(bones.leftLeg.name);
      const p3 = restWorldPositions.get(bones.leftFoot.name);
      if (p1 && p2 && p3) {
        const charLegLen = p1.distanceTo(p2) + p2.distanceTo(p3);
        const fMid = frames[Math.floor(frames.length / 2)];
        const mocapLegLen =
          v3(fMid.leftHip).distanceTo(v3(fMid.leftKnee)) +
          v3(fMid.leftKnee).distanceTo(v3(fMid.leftAnkle));
        if (mocapLegLen > 0.1 && charLegLen > 0.1) {
          heightScale = charLegLen / mocapLegLen;
        }
      }
    }

    // 9. Pre-stabilize camera-depth (Z) jitter on limb vectors across frames
    const stabilizedFrames = this._stabilizeFrameDepths(frames, depthStability);

    // 10. Prepare track containers
    const jsClipFps = Math.max(1, Number(mocapResult.fps) || 30);
    const spineChain = [bones.spine, bones.spine1, bones.spine2].filter(Boolean);
    const trackBoneSet = new Set([
      bones.hips,
      ...spineChain,
      bones.neck,
      bones.head,
      ...limbPairs.map((p) => p.bone),
      bones.leftHand,
      bones.rightHand,
      ...footPairs.map((fp) => bones[fp.key]),
    ].filter(Boolean));
    const trackBones = [...trackBoneSet];

    const times = [];
    const trackValues = {};
    for (const b of trackBones) {
      trackValues[`${b.name}.quaternion`] = [];
    }
    trackValues[`${bones.hips.name}.position`] = [];

    const restHipsWorldPos = restWorldPositions.get(bones.hips.name).clone();
    const restHipsWorldQ = restWorldQuats.get(bones.hips.name).clone();
    const hipsParent = bones.hips.parent;
    const hipsParentWorldQ = hipsParent
      ? hipsParent.getWorldQuaternion(new THREE.Quaternion())
      : new THREE.Quaternion();
    const hipsParentWorldInv = hipsParentWorldQ.clone().invert();
    const hipsParentMatrixWorldInv = hipsParent
      ? hipsParent.matrixWorld.clone().invert()
      : new THREE.Matrix4();

    const qParentWorld = new THREE.Quaternion();
    const qParentInv = new THREE.Quaternion();

    /**
     * Pure-swing parent-space bone solver.
     * Avoids collinear T-pose child twist calculation which spins thighs/arms 180°.
     */
    const solveBone = (bone, targetDirWorld, weight = 1.0, maxAngleRad = Math.PI) => {
      if (!bone || !bone.parent || !targetDirWorld || targetDirWorld.lengthSq() < 1e-10) return;
      const info = restBoneDirs.get(bone.name);
      if (!info) return;

      bone.parent.getWorldQuaternion(qParentWorld);
      qParentInv.copy(qParentWorld).invert();

      const targetInParent = targetDirWorld.clone().normalize().applyQuaternion(qParentInv);
      let swing = new THREE.Quaternion().setFromUnitVectors(info.dirParent, targetInParent);
      if (weight < 0.999) {
        swing = _IDENTITY_Q.clone().slerp(swing, weight);
      }
      if (maxAngleRad < Math.PI - 1e-3) {
        swing = clampQuaternionAngle(swing, maxAngleRad);
      }
      const restQ = restQuats.get(bone.name);
      bone.quaternion.copy(swing.multiply(restQ));
      bone.updateMatrixWorld(true);
    };

    const solveFoot = (footBone, footKey, targetDirWorld, charFwdNow) => {
      if (!footBone || !footBone.parent) return;
      const info = footRestDirs.get(footKey);
      if (!info) return;

      const naturalFootDir = charFwdNow.clone().multiplyScalar(0.85).add(new THREE.Vector3(0, -0.5, 0)).normalize();
      let blendedDir = naturalFootDir;
      if (targetDirWorld && targetDirWorld.lengthSq() > 1e-8) {
        const capDir = targetDirWorld.clone().normalize();
        // Prevent upside-down or backward-snapped toe detections
        if (capDir.dot(charFwdNow) < -0.15) {
          capDir.addScaledVector(charFwdNow, -capDir.dot(charFwdNow) + 0.2).normalize();
        }
        blendedDir = naturalFootDir.clone().lerp(capDir, 0.55).normalize();
      }

      footBone.parent.getWorldQuaternion(qParentWorld);
      qParentInv.copy(qParentWorld).invert();
      const targetInParent = blendedDir.applyQuaternion(qParentInv);
      let swing = new THREE.Quaternion().setFromUnitVectors(info.dirParent, targetInParent);
      swing = clampQuaternionAngle(swing, THREE.MathUtils.degToRad(35));
      footBone.quaternion.copy(swing.multiply(restQuats.get(footBone.name)));
      footBone.updateMatrixWorld(true);
    };

    // Pass 1: Solve all bone rotations per frame and compute raw world hip positions + foot heights
    const rawHipsWorldPositions = new Array(frames.length);
    const rawGroundCorrections = new Float32Array(frames.length);

    for (let i = 0; i < stabilizedFrames.length; i++) {
      const f = stabilizedFrames[i];
      const pb = frameBases[i];
      times.push(Number.isFinite(f.time) ? f.time : Number((i / jsClipFps).toFixed(5)));

      // Instantaneous subject basis mapped into model space
      const pelvisSideM = pb.pelvisSide.clone().applyQuaternion(alignQ).normalize();
      const chestSideM = pb.chestSide.clone().applyQuaternion(alignQ).normalize();
      const torsoUpM = pb.torsoUp.clone().applyQuaternion(alignQ).normalize();

      // A. Upright-stabilized Hips orientation (pelvis takes ~28% of torso lean & damped roll)
      const hipsUp = _Y_AXIS.clone().lerp(torsoUpM, 0.28).normalize();
      const hipsSide = pelvisSideM.clone();
      hipsSide.y *= 0.35; // damp pelvic hip-hike roll
      hipsSide.addScaledVector(hipsUp, -hipsSide.dot(hipsUp));
      if (hipsSide.lengthSq() < 1e-6) hipsSide.copy(charBasis.side);
      else hipsSide.normalize();
      const hipsFwd = new THREE.Vector3().crossVectors(hipsSide, hipsUp).normalize();

      const qPelvisWorld = basisQuaternion(hipsSide, hipsUp, hipsFwd);
      const deltaPelvisWorld = qPelvisWorld.clone().multiply(qCharCanonicalInv);
      const targetHipsWorldQ = deltaPelvisWorld.multiply(restHipsWorldQ);
      bones.hips.quaternion.copy(hipsParentWorldInv.clone().multiply(targetHipsWorldQ));
      bones.hips.updateMatrixWorld(true);

      // B. Multi-bone Spine distribution (remaining 72% torso lean + shoulder-vs-hip twist)
      if (spineChain.length > 0) {
        const qRemainSwing = new THREE.Quaternion().setFromUnitVectors(hipsUp, torsoUpM);

        // Axial twist between pelvisSideM and chestSideM around torsoUpM
        const pSideProj = hipsSide.clone().addScaledVector(torsoUpM, -hipsSide.dot(torsoUpM));
        const cSideProj = chestSideM.clone().addScaledVector(torsoUpM, -chestSideM.dot(torsoUpM));
        let twistAngle = 0;
        if (pSideProj.lengthSq() > 1e-6 && cSideProj.lengthSq() > 1e-6) {
          pSideProj.normalize();
          cSideProj.normalize();
          const cross = new THREE.Vector3().crossVectors(pSideProj, cSideProj);
          twistAngle = Math.atan2(cross.dot(torsoUpM), pSideProj.dot(cSideProj));
          twistAngle = THREE.MathUtils.clamp(twistAngle, -0.65, 0.65);
        }
        const qTwist = new THREE.Quaternion().setFromAxisAngle(torsoUpM, twistAngle);
        const qTotalSpine = qTwist.multiply(qRemainSwing);
        const qStepWorld = _IDENTITY_Q.clone().slerp(qTotalSpine, 1.0 / spineChain.length);

        for (const spBone of spineChain) {
          spBone.parent.getWorldQuaternion(qParentWorld);
          qParentInv.copy(qParentWorld).invert();
          const curWorldQ = spBone.parent.getWorldQuaternion(new THREE.Quaternion()).multiply(restQuats.get(spBone.name));
          const nextWorldQ = qStepWorld.clone().multiply(curWorldQ);
          spBone.quaternion.copy(qParentInv.multiply(nextWorldQ));
          spBone.updateMatrixWorld(true);
        }
      }

      // C. Subtle Neck & Head orientation
      if (f.nose && f.neck && (bones.neck || bones.head)) {
        const headVec = v3(f.nose).sub(v3(f.neck)).applyQuaternion(alignQ);
        if (headVec.lengthSq() > 1e-6) {
          headVec.normalize();
          const neutralHeadDir = torsoUpM.clone().multiplyScalar(0.65).addScaledVector(hipsFwd, 0.76).normalize();
          let qHeadDelta = new THREE.Quaternion().setFromUnitVectors(neutralHeadDir, headVec);
          qHeadDelta = clampQuaternionAngle(qHeadDelta, THREE.MathUtils.degToRad(22));
          const headTargets = [bones.neck, bones.head].filter(Boolean);
          const qHeadStep = _IDENTITY_Q.clone().slerp(qHeadDelta, 0.55 / headTargets.length);
          for (const hb of headTargets) {
            hb.parent.getWorldQuaternion(qParentWorld);
            qParentInv.copy(qParentWorld).invert();
            const curWorldQ = hb.parent.getWorldQuaternion(new THREE.Quaternion()).multiply(restQuats.get(hb.name));
            hb.quaternion.copy(qParentInv.multiply(qHeadStep.clone().multiply(curWorldQ)));
            hb.updateMatrixWorld(true);
          }
        }
      }

      // D. Stabilize & Solve Arms
      {
        const lSh = v3(f.leftShoulder).applyQuaternion(alignQ);
        const lElb = v3(f.leftElbow).applyQuaternion(alignQ);
        const lWri = v3(f.leftWrist).applyQuaternion(alignQ);
        const dUpper = this._constrainArmVector(lElb.clone().sub(lSh), hipsSide, torsoUpM, hipsFwd, true);
        const dLower = this._constrainForearmVector(lWri.clone().sub(lElb), dUpper, hipsFwd);

        if (bones.leftShoulder) {
          solveBone(bones.leftShoulder, dUpper, 0.15, THREE.MathUtils.degToRad(15));
        }
        solveBone(bones.leftArm, dUpper);
        solveBone(bones.leftForearm, dLower);

        if (bones.leftHand) {
          const handDir = f.leftHandIndex
            ? v3(f.leftHandIndex).applyQuaternion(alignQ).sub(lWri).normalize().lerp(dLower.clone().normalize(), 0.6)
            : dLower;
          solveBone(bones.leftHand, handDir, 0.5, THREE.MathUtils.degToRad(25));
        }
      }
      {
        const rSh = v3(f.rightShoulder).applyQuaternion(alignQ);
        const rElb = v3(f.rightElbow).applyQuaternion(alignQ);
        const rWri = v3(f.rightWrist).applyQuaternion(alignQ);
        const dUpper = this._constrainArmVector(rElb.clone().sub(rSh), hipsSide, torsoUpM, hipsFwd, false);
        const dLower = this._constrainForearmVector(rWri.clone().sub(rElb), dUpper, hipsFwd);

        if (bones.rightShoulder) {
          solveBone(bones.rightShoulder, dUpper, 0.15, THREE.MathUtils.degToRad(15));
        }
        solveBone(bones.rightArm, dUpper);
        solveBone(bones.rightForearm, dLower);

        if (bones.rightHand) {
          const handDir = f.rightHandIndex
            ? v3(f.rightHandIndex).applyQuaternion(alignQ).sub(rWri).normalize().lerp(dLower.clone().normalize(), 0.6)
            : dLower;
          solveBone(bones.rightHand, handDir, 0.5, THREE.MathUtils.degToRad(25));
        }
      }

      // E. Stabilize & Solve Legs (with anti-crossover & knee hinge limits)
      {
        const lHip = v3(f.leftHip).applyQuaternion(alignQ);
        const lKnee = v3(f.leftKnee).applyQuaternion(alignQ);
        const lAnk = v3(f.leftAnkle).applyQuaternion(alignQ);
        const dThigh = this._constrainThighVector(lKnee.clone().sub(lHip), hipsSide, _Y_AXIS, hipsFwd, true);
        const dShin = this._constrainShinVector(lAnk.clone().sub(lKnee), dThigh, hipsSide, hipsFwd, true);
        solveBone(bones.leftUpLeg, dThigh);
        solveBone(bones.leftLeg, dShin);
      }
      {
        const rHip = v3(f.rightHip).applyQuaternion(alignQ);
        const rKnee = v3(f.rightKnee).applyQuaternion(alignQ);
        const rAnk = v3(f.rightAnkle).applyQuaternion(alignQ);
        const dThigh = this._constrainThighVector(rKnee.clone().sub(rHip), hipsSide, _Y_AXIS, hipsFwd, false);
        const dShin = this._constrainShinVector(rAnk.clone().sub(rKnee), dThigh, hipsSide, hipsFwd, false);
        solveBone(bones.rightUpLeg, dThigh);
        solveBone(bones.rightLeg, dShin);
      }

      // F. Feet: ankle -> toe roll with anatomical clamping
      for (const fp of footPairs) {
        const targetDir = (f[fp.ankle] && f[fp.toe])
          ? v3(f[fp.toe]).sub(v3(f[fp.ankle])).applyQuaternion(alignQ)
          : null;
        solveFoot(bones[fp.key], fp.key, targetDir, hipsFwd);
      }

      // G. Root translation in world space + floor grounding probe
      const curMidHip = v3(f.midHip);
      const deltaPosWorld = enableRootMotion
        ? curMidHip.sub(refMidHip).multiplyScalar(heightScale * rootMotionScale).applyQuaternion(alignQ)
        : new THREE.Vector3();
      // Damp vertical root bob slightly to avoid camera-scale bounce
      deltaPosWorld.y *= 0.65;

      const targetHipsWorldPos = restHipsWorldPos.clone().add(deltaPosWorld);
      rawHipsWorldPositions[i] = targetHipsWorldPos;

      // Temporarily apply targetHipsWorldPos to measure lowest foot height in world space
      const tempLocalPos = targetHipsWorldPos.clone().applyMatrix4(hipsParentMatrixWorldInv);
      bones.hips.position.copy(tempLocalPos);
      bones.hips.updateMatrixWorld(true);

      if (groundFeet && groundProbeBones.length > 0) {
        const curMinFootY = Math.min(
          ...groundProbeBones.map((b) => b.getWorldPosition(new THREE.Vector3()).y)
        );
        rawGroundCorrections[i] = restMinFootY - curMinFootY;
      }

      // Record bone quaternions for this frame
      for (const b of trackBones) {
        trackValues[`${b.name}.quaternion`].push(
          b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w
        );
      }
    }

    // 11. Smooth floor grounding offset & finalize parent-space Hips position track
    const smoothedGroundY = this._smoothScalarArray(rawGroundCorrections, 3);
    for (let i = 0; i < frames.length; i++) {
      const worldPos = rawHipsWorldPositions[i].clone();
      if (groundFeet) {
        worldPos.y += smoothedGroundY[i];
      }
      const localPos = worldPos.applyMatrix4(hipsParentMatrixWorldInv);
      trackValues[`${bones.hips.name}.position`].push(localPos.x, localPos.y, localPos.z);
    }

    // 12. Enforce quaternion hemisphere continuity, despike glitches & zero-phase SLERP smoothing
    const clipFps = Number(mocapResult.fps) || 30;
    for (const b of trackBones) {
      const key = `${b.name}.quaternion`;
      trackValues[key] = this._smoothQuaternionTrack(trackValues[key], smoothing, clipFps);
    }

    // 13. Reset character to bind transforms before building/playing the clip
    character.traverse((o) => {
      if (!o.isBone) return;
      const q = restQuats.get(o.name);
      const p = restPositions.get(o.name);
      if (q) o.quaternion.copy(q);
      if (p) o.position.copy(p);
    });
    character.updateMatrixWorld(true);

    // 14. Build keyframe tracks
    const tracks = [];
    const timesArr = new Float32Array(times);

    for (const [trackName, vals] of Object.entries(trackValues)) {
      if (trackName.endsWith('.position')) {
        tracks.push(new THREE.VectorKeyframeTrack(trackName, timesArr, new Float32Array(vals)));
      } else if (trackName.endsWith('.quaternion')) {
        tracks.push(new THREE.QuaternionKeyframeTrack(trackName, timesArr, new Float32Array(vals)));
      }
    }

    const duration = times[times.length - 1] || 0;
    const clip = new THREE.AnimationClip('Mocap_MediaPipe_Action', duration, tracks);

    // 15. Bind clip to character & mixer (reusing unified cleanup/mixer binding)
    this._bindClipToMixer(character, clip);

    const jsFacing = this._computeFacingSummary(
      frames,
      charBasis,
      Boolean(options.mirrorX),
      autoAlign,
      yawOffsetDeg,
    );
    this.lastAlignment = {
      autoAlign,
      yawOffsetDeg,
      inferredYawDeg,
      facingLabel,
      cameraHint: jsFacing.cameraHint,
      aligned: autoAlign,
      groundFeet,
      rootMotion: enableRootMotion,
      smoothing,
      depthStability,
      footLock: footLockCounts,
      engine: 'js',
    };

    if (typeof window !== 'undefined') {
      try { window.rigSystem?.updateSkeletonHelper?.(); } catch (_) { /* ignore */ }
    }

    console.log(
      `[MocapRetargeter] Retargeting complete! ${tracks.length} tracks / ${times.length} frames (${duration.toFixed(2)}s). ` +
      `Aligned: ${this.lastAlignment.aligned}, inferred yaw ${inferredYawDeg.toFixed(1)}°, facing: ${facingLabel}.`
    );

    return {
      success: true,
      engine: 'js',
      duration,
      numFrames: times.length,
      tracksCount: tracks.length,
      clipName: clip.name,
      inferredYawDeg,
      facingLabel,
      aligned: this.lastAlignment.aligned,
      autoAlign,
      yawOffsetDeg,
      footLock: footLockCounts,
    };
  }

  // ---------------------------------------------------------------- //
  // Anatomical & Temporal Stabilization Helpers
  // ---------------------------------------------------------------- //

  /**
   * Damps high-frequency monocular depth (camera Z) jitter on limb joints
   * while preserving 2D image-plane (X, Y) crispness.
   */
  _stabilizeFrameDepths(frames, depthStability) {
    if (!frames || frames.length <= 2 || depthStability <= 0.01) return frames;
    const limbKeys = [
      'leftShoulder', 'rightShoulder',
      'leftElbow', 'rightElbow',
      'leftWrist', 'rightWrist',
      'leftHandIndex', 'rightHandIndex',
      'leftHip', 'rightHip',
      'leftKnee', 'rightKnee',
      'leftAnkle', 'rightAnkle',
      'leftFoot', 'rightFoot',
    ];
    const cloned = frames.map((f) => {
      const copy = { time: f.time };
      for (const k of Object.keys(f)) {
        if (Array.isArray(f[k])) copy[k] = f[k].slice();
      }
      return copy;
    });

    // Zero-phase forward-backward smoothing specifically on camera Z coordinate
    // and damping extreme relative Z spikes.
    const alpha = THREE.MathUtils.clamp(1.0 - depthStability * 0.78, 0.15, 0.95);
    const zScale = 1.0 - depthStability * 0.35;

    for (const key of limbKeys) {
      // Forward pass on Z
      for (let i = 1; i < cloned.length; i++) {
        if (!cloned[i][key] || !cloned[i - 1][key]) continue;
        cloned[i][key][2] = alpha * cloned[i][key][2] + (1 - alpha) * cloned[i - 1][key][2];
      }
      // Backward pass on Z
      for (let i = cloned.length - 2; i >= 0; i--) {
        if (!cloned[i][key] || !cloned[i + 1][key]) continue;
        cloned[i][key][2] = alpha * cloned[i][key][2] + (1 - alpha) * cloned[i + 1][key][2];
      }
      // Compress extreme Z excursions relative to midHip.z
      for (let i = 0; i < cloned.length; i++) {
        if (!cloned[i][key] || !cloned[i].midHip) continue;
        const relZ = cloned[i][key][2] - cloned[i].midHip[2];
        cloned[i][key][2] = cloned[i].midHip[2] + relZ * zScale;
      }
    }
    return cloned;
  }

  /**
   * Prevents thigh vectors from crossing over the body midline (scissor legs)
   * or splaying at impossible angles due to monocular depth noise.
   */
  _constrainThighVector(vec, sideAxis, upAxis, fwdAxis, isLeft) {
    const len = vec.length();
    if (len < 1e-6) return new THREE.Vector3(0, -1, 0);
    const u = vec.clone().divideScalar(len);

    let s = u.dot(sideAxis); // +s is Left, -s is Right
    let y = u.dot(upAxis);
    let f = u.dot(fwdAxis);

    if (isLeft) {
      // Left thigh cannot cross inward past -0.06 into right leg space
      s = THREE.MathUtils.clamp(s, -0.06, 0.65);
    } else {
      // Right thigh cannot cross inward past +0.06 into left leg space
      s = THREE.MathUtils.clamp(s, -0.65, 0.06);
    }
    // Prevent thigh from flipping above horizontal (> +35°)
    y = Math.min(y, 0.55);

    return new THREE.Vector3()
      .addScaledVector(sideAxis, s)
      .addScaledVector(upAxis, y)
      .addScaledVector(fwdAxis, f)
      .normalize()
      .multiplyScalar(len);
  }

  /**
   * Enforces anatomical knee hinge limits (no forward flamingo hyperextension)
   * and prevents shins/ankles from crossing the midline.
   */
  _constrainShinVector(vec, thighVec, sideAxis, fwdAxis, isLeft) {
    const len = vec.length();
    if (len < 1e-6) return thighVec.clone().normalize();
    const u = vec.clone().divideScalar(len);
    const uThigh = thighVec.clone().normalize();

    // 1. Prevent inward ankle crossover along sideAxis
    let s = u.dot(sideAxis);
    if (isLeft) {
      if (s < -0.04) u.addScaledVector(sideAxis, -0.04 - s);
    } else {
      if (s > 0.04) u.addScaledVector(sideAxis, 0.04 - s);
    }
    u.normalize();

    // 2. Knee hinge constraint: shin cannot bend forward (+fwdAxis) ahead of thigh direction
    const along = u.dot(uThigh);
    const perp = u.clone().addScaledVector(uThigh, -along);
    const fwdComponent = perp.dot(fwdAxis);
    if (fwdComponent > 0.03) {
      u.addScaledVector(fwdAxis, -(fwdComponent - 0.03));
      u.normalize();
    }

    return u.multiplyScalar(len);
  }

  /**
   * Prevents upper arms from clipping deeply across the chest midline.
   */
  _constrainArmVector(vec, sideAxis, upAxis, fwdAxis, isLeft) {
    const len = vec.length();
    if (len < 1e-6) return sideAxis.clone().multiplyScalar(isLeft ? 1 : -1);
    const u = vec.clone().divideScalar(len);

    let s = u.dot(sideAxis);
    const f = u.dot(fwdAxis);
    // If arm is not reaching far forward, prevent it from penetrating inside the torso
    if (f < 0.35) {
      if (isLeft && s < -0.15) {
        u.addScaledVector(sideAxis, -0.15 - s);
      } else if (!isLeft && s > 0.15) {
        u.addScaledVector(sideAxis, 0.15 - s);
      }
    }
    return u.normalize().multiplyScalar(len);
  }

  /**
   * Prevents elbows from hyperextending backward.
   */
  _constrainForearmVector(vec, upperArmVec, fwdAxis) {
    const len = vec.length();
    if (len < 1e-6) return upperArmVec.clone();
    const u = vec.clone().divideScalar(len);
    const uUpper = upperArmVec.clone().normalize();

    const along = u.dot(uUpper);
    const perp = u.clone().addScaledVector(uUpper, -along);
    const backComponent = perp.dot(fwdAxis);
    if (backComponent < -0.25) {
      u.addScaledVector(fwdAxis, -0.25 - backComponent);
      u.normalize();
    }
    return u.multiplyScalar(len);
  }

  _smoothScalarArray(arr, radius = 3) {
    const n = arr.length;
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let sum = 0;
      let count = 0;
      for (let k = Math.max(0, i - radius); k <= Math.min(n - 1, i + radius); k++) {
        sum += arr[k];
        count++;
      }
      out[i] = count > 0 ? sum / count : arr[i];
    }
    return out;
  }

  /**
   * Enforces quaternion hemisphere continuity (q_i · q_{i-1} >= 0) so
   * THREE.QuaternionKeyframeTrack never interpolates the long way around (360°),
   * and applies zero-phase forward-backward SLERP smoothing.
   */
  _smoothQuaternionTrack(flatVals, smoothing = 0.35, fps = 30) {
    const n = Math.floor(flatVals.length / 4);
    if (n <= 1) return flatVals;

    const quats = new Array(n);
    for (let i = 0; i < n; i++) {
      quats[i] = new THREE.Quaternion(
        flatVals[i * 4],
        flatVals[i * 4 + 1],
        flatVals[i * 4 + 2],
        flatVals[i * 4 + 3]
      ).normalize();
    }

    const alignHemi = () => {
      for (let i = 1; i < n; i++) {
        if (quats[i - 1].dot(quats[i]) < 0) {
          quats[i].set(-quats[i].x, -quats[i].y, -quats[i].z, -quats[i].w);
        }
      }
    };

    // 1. Hemisphere sign continuity pass
    alignHemi();

    // 2. Single-frame spike despiker (suppresses pole-flip or 2D glitch jumps > ~26 deg * dtScale)
    if (n >= 5) {
      const dtScale = 30.0 / Math.max(10, Number(fps) || 30);
      const maxJumpRad = THREE.MathUtils.degToRad(26 * dtScale);
      const next = quats.map((q) => q.clone());
      for (let i = 1; i < n - 1; i++) {
        const qMid = quats[i - 1].clone().slerp(quats[i + 1], 0.5).normalize();
        if (qMid.dot(quats[i]) < 0) {
          qMid.set(-qMid.x, -qMid.y, -qMid.z, -qMid.w);
        }
        const angMid = 2 * Math.acos(THREE.MathUtils.clamp(Math.abs(qMid.dot(quats[i])), 0, 1));
        const spanAng = 2 * Math.acos(THREE.MathUtils.clamp(Math.abs(quats[i - 1].dot(quats[i + 1])), 0, 1));
        if (angMid > maxJumpRad && spanAng < maxJumpRad * 1.15) {
          next[i].copy(qMid);
        }
      }
      for (let i = 0; i < n; i++) quats[i].copy(next[i]);
      alignHemi();
    }

    // 3. Multi-pass zero-phase dt-aware SLERP smoothing
    if (smoothing > 0.01 && n >= 3) {
      const fpsFactor = THREE.MathUtils.clamp(30.0 / Math.max(10, Number(fps) || 30), 0.35, 1.5);
      const alpha = THREE.MathUtils.clamp(1.0 - smoothing * 0.65 * fpsFactor, 0.18, 0.98);
      const passes = smoothing > 0.45 ? 2 : 1;
      for (let p = 0; p < passes; p++) {
        for (let i = 1; i < n; i++) {
          if (quats[i - 1].dot(quats[i]) < 0) {
            quats[i].set(-quats[i].x, -quats[i].y, -quats[i].z, -quats[i].w);
          }
          quats[i].slerp(quats[i - 1], 1.0 - alpha);
        }
        for (let i = n - 2; i >= 0; i--) {
          if (quats[i + 1].dot(quats[i]) < 0) {
            quats[i].set(-quats[i].x, -quats[i].y, -quats[i].z, -quats[i].w);
          }
          quats[i].slerp(quats[i + 1], 1.0 - alpha);
        }
        alignHemi();
      }
    }

    const out = new Array(n * 4);
    for (let i = 0; i < n; i++) {
      out[i * 4] = quats[i].x;
      out[i * 4 + 1] = quats[i].y;
      out[i * 4 + 2] = quats[i].z;
      out[i * 4 + 3] = quats[i].w;
    }
    return out;
  }

  // ---------------------------------------------------------------- //
  // Playback Controls
  // ---------------------------------------------------------------- //

  play() {
    if (this.action) {
      this.action.paused = false;
      this.action.play();
      this.isPlaying = true;
      this.engine?.requestRender?.();
    }
  }

  pause() {
    if (this.action) {
      this.action.paused = true;
      this.isPlaying = false;
    }
  }

  /** Play the current clip once from the beginning (used by video render). */
  playOnceFromStart() {
    if (!this.mixer || !this.action) return false;
    this.action.reset();
    this.action.setLoop(THREE.LoopOnce, 1);
    this.action.clampWhenFinished = true;
    this.action.paused = false;
    this.action.play();
    this.mixer.setTime(0);
    this.isPlaying = true;
    this.engine?.requestRender?.();
    return true;
  }

  setLoopRepeat() {
    if (!this.action) return;
    this.action.setLoop(THREE.LoopRepeat);
    this.action.clampWhenFinished = false;
  }

  seek(timeInSeconds) {
    if (this.mixer && this.currentClip && this.action) {
      const dur = this.currentClip.duration || 0;
      // Avoid wrapping t === duration back to t = 0 on Three.js LoopRepeat actions
      const endEps = this.action.loop === THREE.LoopRepeat && dur > 2e-4 ? 1e-4 : 0;
      const clamped = dur > 0 ? Math.max(0, Math.min(timeInSeconds, dur - endEps)) : 0;
      // Three.js AnimationAction.paused=true freezes mixer.setTime() evaluation;
      // temporarily unpause during manual/scripted scrubbing so skeleton pose updates.
      const prevPaused = this.action.paused;
      this.action.paused = false;
      this.mixer.setTime(clamped);
      this.action.paused = prevPaused;
      if (this.character) {
        this.character.updateMatrixWorld(true);
        if (typeof window !== 'undefined') {
          try { window.rigSystem?.updateSkeletonHelper?.(); } catch (_) { /* ignore */ }
        }
      }
    }
  }

  _update({ delta }) {
    if (this.mixer && this.isPlaying && !this.action?.paused) {
      this.mixer.update(delta || 0.016);
      if (this.character && typeof window !== 'undefined') {
        try { window.rigSystem?.updateSkeletonHelper?.(); } catch (_) { /* ignore */ }
      }
    }
  }

  /**
   * Pause the mocap mixer and hand the skeleton over to manual editing.
   */
  enterManualEdit() {
    if (this.mixer) {
      this.mixer.stopAllAction();
      try { this.mixer.uncacheRoot(this.character); } catch (e) { /* ignore */ }
    }
    const resumeClip = this.currentClip;
    const resumeAction = this.action;
    if (this.character) {
      this.character.updateMatrixWorld(true);
    }
    return { clip: resumeClip, action: resumeAction };
  }

  /**
   * Re-bind and restart the current clip after manual editing.
   */
  exitManualEdit(clip = null) {
    if (clip) this.currentClip = clip;
    if (!this.character || !this.currentClip) return false;
    this.character.animations = [this.currentClip];
    this.mixer = new THREE.AnimationMixer(this.character);
    this.action = this.mixer.clipAction(this.currentClip);
    if (this.currentClip.duration <= 1e-6) {
      this.action.setLoop(THREE.LoopOnce, 1);
      this.action.clampWhenFinished = true;
    } else {
      this.action.setLoop(THREE.LoopRepeat);
      this.action.clampWhenFinished = false;
    }
    this.action.play();
    this.mixer.setTime(0);
    this.isPlaying = true;
    this.engine?.requestRender?.();
    return true;
  }

  /**
   * Export the active retargeted AnimationClip + rigged skeleton to standard `.bvh` text.
   */
  exportBVH(character = null, options = {}) {
    const targetChar = character || this.character;
    if (!targetChar || !this.currentClip) {
      throw new Error('No active retargeted animation clip to export as BVH.');
    }
    const fps = Number(options.fps || this._lastFps || 30);
    return exportClipToBVH(targetChar, this.currentClip, { fps, ...options });
  }

  /**
   * Export the active retargeted AnimationClip + rigged skeleton to Binary FBX 7.4 (or ASCII via options.format).
   */
  exportFBX(character = null, options = {}) {
    const targetChar = character || this.character;
    if (!targetChar || !this.currentClip) {
      throw new Error('No active retargeted animation clip to export as FBX.');
    }
    const fps = Number(options.fps || this._lastFps || 30);
    return exportClipToFBX(targetChar, this.currentClip, { fps, ...options });
  }

  dispose() {
    if (this.mixer) {
      this.mixer.stopAllAction();
      this.mixer.uncacheRoot(this.character);
      this.mixer = null;
    }
    this.action = null;
    this.currentClip = null;
    this.isPlaying = false;
  }
}
