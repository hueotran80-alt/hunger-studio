/**
 * Anatomical Finger Solver, Hand Palm Orientation Refinement, and Limb Twist Distribution.
 *
 * Maps 21-point MediaPipe HandLandmarker frames cleanly onto standard Mixamo, VRM,
 * Character Creator, and Rigify finger bones (Thumb/Index/Middle/Ring/Pinky 1..3),
 * and decomposes longitudinal forearm/upper-arm/thigh twist onto dedicated Twist/Roll
 * deformation bones when available on the rig.
 */

import * as THREE from 'three';

const _vA = new THREE.Vector3();
const _vB = new THREE.Vector3();
const _vC = new THREE.Vector3();
const _vD = new THREE.Vector3();
const _qA = new THREE.Quaternion();
const _qB = new THREE.Quaternion();
const _mA = new THREE.Matrix4();
const _mB = new THREE.Matrix4();

/** 21-point MediaPipe hand bone segments matching Mixamo/VRM/CC4 3-phalanx finger chains. */
export const FINGER_CHAINS = Object.freeze({
  Thumb: [[1, 2], [2, 3], [3, 4]],
  Index: [[5, 6], [6, 7], [7, 8]],
  Middle: [[9, 10], [10, 11], [11, 12]],
  Ring: [[13, 14], [14, 15], [15, 16]],
  Pinky: [[17, 18], [18, 19], [19, 20]],
});

const FINGER_NAMES = Object.freeze(['Thumb', 'Index', 'Middle', 'Ring', 'Pinky']);

function clamp(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

function readPt(pts, idx, yFlip = -1, mirrorX = false, yawQ = null) {
  const row = pts?.[idx];
  if (!row) return null;
  const flipYZ = yFlip < 0 ? -1 : 1;
  const x = (Array.isArray(row) ? Number(row[0]) : Number(row.x)) * (mirrorX ? -1 : 1);
  const y = (Array.isArray(row) ? Number(row[1]) : Number(row.y)) * flipYZ;
  const z = (Array.isArray(row) ? Number(row[2]) : Number(row.z)) * flipYZ;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  const v = new THREE.Vector3(x, y, z);
  if (yawQ) v.applyQuaternion(yawQ);
  return v;
}

/**
 * Compute child aim axis in parent-local rest space for any bone, using its primary
 * finger child bone (or inheriting parent's rest aim axis for tip phalanges).
 */
function inferBoneLocalAim(bone, fallbackLocalAim) {
  if (!bone) return fallbackLocalAim ? fallbackLocalAim.clone() : new THREE.Vector3(0, 1, 0);
  const boneChild = bone.children?.find((c) => c.isBone && c.position.lengthSq() > 1e-6);
  if (boneChild) {
    return boneChild.position.clone().normalize();
  }
  return fallbackLocalAim ? fallbackLocalAim.clone().normalize() : new THREE.Vector3(0, 1, 0);
}

/**
 * Build an orthonormal right-handed basis from a primary forward aim direction and
 * secondary lateral vector (`across`).
 */
function basisFromAimAcross(aim, across, isLeft) {
  const f = aim.clone().normalize();
  const side = across.clone().addScaledVector(f, -across.dot(f));
  if (side.lengthSq() < 1e-6) return null;
  side.normalize();
  // Normal out of back of hand: ensure consistent sign across Left & Right hands
  const n = new THREE.Vector3().crossVectors(f, side);
  if (n.lengthSq() < 1e-6) return null;
  n.normalize();
  if (!isLeft) n.negate();
  const s = new THREE.Vector3().crossVectors(n, f).normalize();
  return new THREE.Matrix4().makeBasis(s, f, n);
}

/**
 * Forward-backward temporal SLERP + hemisphere alignment on a flattened `[x,y,z,w,...]` track.
 */
function smoothFlatQuatTrack(vals, nFrames, dt = 1 / 30, passScale = 0.35) {
  if (nFrames < 3) return;
  const alpha = clamp(1 - Math.exp(-dt * (10.5 / Math.max(0.2, passScale))), 0.18, 0.85);
  const fwd = new Float32Array(vals.length);
  const qPrev = new THREE.Quaternion();
  const qCur = new THREE.Quaternion();

  // Ensure shortest-arc hemisphere continuity
  for (let f = 1; f < nFrames; f++) {
    const p = (f - 1) * 4;
    const c = f * 4;
    const dot =
      vals[p] * vals[c] +
      vals[p + 1] * vals[c + 1] +
      vals[p + 2] * vals[c + 2] +
      vals[p + 3] * vals[c + 3];
    if (dot < 0) {
      vals[c] = -vals[c];
      vals[c + 1] = -vals[c + 1];
      vals[c + 2] = -vals[c + 2];
      vals[c + 3] = -vals[c + 3];
    }
  }

  for (let i = 0; i < 4; i++) fwd[i] = vals[i];
  for (let f = 1; f < nFrames; f++) {
    qPrev.fromArray(fwd, (f - 1) * 4);
    qCur.fromArray(vals, f * 4);
    qPrev.slerp(qCur, alpha).normalize();
    qPrev.toArray(fwd, f * 4);
  }

  const tail = (nFrames - 1) * 4;
  for (let i = 0; i < 4; i++) vals[tail + i] = fwd[tail + i];
  for (let f = nFrames - 2; f >= 0; f--) {
    qPrev.fromArray(vals, (f + 1) * 4);
    qCur.fromArray(fwd, f * 4);
    qPrev.slerp(qCur, alpha).normalize();
    qPrev.toArray(vals, f * 4);
  }
}

/**
 * Clamp a local rotation relative to bind rest quaternion cleanly by angle.
 */
function clampDeltaFromRest(qLocal, qRest, maxRad) {
  const delta = _qA.copy(qRest).invert().multiply(qLocal).normalize();
  const ang = 2 * Math.acos(clamp(Math.abs(delta.w), 0, 1));
  if (ang <= maxRad || ang < 1e-5) return qLocal;
  const s = maxRad / ang;
  return qRest.clone().slerp(qLocal, s).normalize();
}

/**
 * Compute anatomical finger tracks (`leftHandThumb1..3` etc.) & refine `Hand` palm twist
 * from 21-point MediaPipe `handFrames` aligned cleanly to each frame's solved `Hand` basis.
 */
export function solveHandAndFingerTracks({
  handFrames,
  rig,
  times,
  fps = 30,
  yFlip = -1,
  mirrorX = false,
  totalYaw = 0,
  coreQuatBuffers,
  character,
}) {
  if (!Array.isArray(handFrames) || !handFrames.length || !rig) return [];
  const fingers = rig.fingers || {};
  const hasAnyFinger = Object.keys(fingers).length > 0;
  if (!hasAnyFinger && !rig.leftHand && !rig.rightHand) return [];

  const nFrames = times.length;
  const dt = 1 / Math.max(10, fps);
  const yawQ = Math.abs(totalYaw) > 1e-6
    ? new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), totalYaw)
    : null;

  const extraTracks = [];
  const handTrackL = coreQuatBuffers?.leftHand || null;
  const handTrackR = coreQuatBuffers?.rightHand || null;
  const foreTrackL = coreQuatBuffers?.leftForearm || null;
  const foreTrackR = coreQuatBuffers?.rightForearm || null;

  const sides = [
    { sideKey: 'left', prefix: 'leftHand', isLeft: true, handBone: rig.leftHand, foreBone: rig.leftForearm, handTrack: handTrackL, foreTrack: foreTrackL },
    { sideKey: 'right', prefix: 'rightHand', isLeft: false, handBone: rig.rightHand, foreBone: rig.rightForearm, handTrack: handTrackR, foreTrack: foreTrackR },
  ];

  // Snapshot character rest quaternions so we can evaluate temporary FK safely and restore after
  const savedQuats = new Map();
  if (character) {
    character.traverse((o) => {
      if (o.isBone) savedQuats.set(o, o.quaternion.clone());
    });
  }

  try {
    for (const side of sides) {
      const { sideKey, prefix, isLeft, handBone, foreBone, handTrack } = side;
      if (!handBone) continue;

      // Collect rest local aim + rest quaternion for hand & each present finger bone
      const handRestLocalQ = handBone.quaternion.clone();
      const mid1Bone = fingers[`${prefix}Middle1`];
      const idx1Bone = fingers[`${prefix}Index1`];
      const pnk1Bone = fingers[`${prefix}Pinky1`];

      // Rest hand frame in character hand-local space (used to map MP hand basis -> character hand local)
      handBone.updateWorldMatrix(true, false);
      const rigHandAimLocal = mid1Bone && mid1Bone.position.lengthSq() > 1e-6
        ? mid1Bone.position.clone().normalize()
        : inferBoneLocalAim(handBone, new THREE.Vector3(0, 1, 0));

      let rigHandAcrossLocal = null;
      if (idx1Bone && pnk1Bone) {
        rigHandAcrossLocal = idx1Bone.position.clone().sub(pnk1Bone.position);
      } else if (idx1Bone && idx1Bone.position.lengthSq() > 1e-6) {
        rigHandAcrossLocal = idx1Bone.position.clone();
      } else {
        rigHandAcrossLocal = new THREE.Vector3(isLeft ? 0 : 0, 0, 1);
      }
      const rigBasisLocal = basisFromAimAcross(rigHandAimLocal, rigHandAcrossLocal, isLeft)
        || new THREE.Matrix4().identity();
      const rigBasisLocalInv = rigBasisLocal.clone().invert();

      // Extract palmar flexion direction in Hand local space (-n = -column 2 of rigBasisLocal)
      const palmFlexInHand = new THREE.Vector3(
        -rigBasisLocal.elements[8],
        -rigBasisLocal.elements[9],
        -rigBasisLocal.elements[10],
      ).normalize();

      // Precompute finger rest info & output arrays
      const fingerStates = [];
      for (const fName of FINGER_NAMES) {
        const segDefs = FINGER_CHAINS[fName];
        let prevAim = rigHandAimLocal.clone();
        let cumRestInHand = new THREE.Quaternion();
        const chainBones = [];
        for (let sIdx = 1; sIdx <= 3; sIdx++) {
          const key = `${prefix}${fName}${sIdx}`;
          const bone = fingers[key] || null;
          if (!bone) continue;
          const aimLocal = inferBoneLocalAim(bone, prevAim);
          prevAim = aimLocal;
          const restLocalQ = bone.quaternion.clone();
          cumRestInHand = cumRestInHand.clone().multiply(restLocalQ).normalize();
          const palmInBone = palmFlexInHand.clone().applyQuaternion(cumRestInHand.clone().invert()).normalize();
          const flexCross = new THREE.Vector3().crossVectors(aimLocal, palmInBone);
          const fallbackAxis = new THREE.Vector3().crossVectors(aimLocal, new THREE.Vector3(0, 1, 0));
          const flexAxisLocal = (flexCross.lengthSq() > 1e-5 ? flexCross : (fallbackAxis.lengthSq() > 1e-5 ? fallbackAxis : new THREE.Vector3(0, 0, 1))).normalize();
          const palmPerpLocal = new THREE.Vector3().crossVectors(flexAxisLocal, aimLocal).normalize();
          const relaxAngle = fName === 'Thumb' ? 0.08 : (sIdx === 1 ? 0.14 : 0.22);
          const relaxQ = restLocalQ.clone().multiply(new THREE.Quaternion().setFromAxisAngle(flexAxisLocal, relaxAngle)).normalize();
          chainBones.push({
            key,
            sIdx,
            bone,
            segPair: segDefs[sIdx - 1],
            aimLocal,
            flexAxisLocal,
            palmPerpLocal,
            restLocalQ,
            relaxQ,
            maxRad: sIdx === 1 ? (fName === 'Thumb' ? 1.15 : 1.05) : 1.55,
            outVals: new Float32Array(nFrames * 4),
          });
        }
        if (chainBones.length > 0) {
          fingerStates.push({ fName, chainBones });
        }
      }

      // Compute world forward-basis vectors on each frame & solve hand twist + fingers
      const chainSyncKeys = isLeft
        ? ['hips', 'spine', 'spine1', 'spine2', 'leftShoulder', 'leftArm', 'leftForearm', 'leftHand']
        : ['hips', 'spine', 'spine1', 'spine2', 'rightShoulder', 'rightArm', 'rightForearm', 'rightHand'];
      let heldPts = null;
      let heldBasis = null;
      let heldConf = 0;
      let missedGap = 0;
      const maxHoldGap = 8;

      for (let f = 0; f < nFrames; f++) {
        // Restore FULL parent chain (hips -> spine -> shoulder -> arm -> forearm -> hand)
        // from coreQuatBuffers so parentWorldQ matches real arm pose rather than rest T-pose
        for (const ck of chainSyncKeys) {
          const bObj = rig[ck];
          const bBuf = coreQuatBuffers?.[ck];
          if (bObj && bBuf) {
            bObj.quaternion.fromArray(bBuf, f * 4);
          }
        }
        if (character) character.updateMatrixWorld(true);
        else handBone.updateWorldMatrix(true, false);

        const rawSide = handFrames[f]?.[sideKey];
        const rawPts = rawSide?.worldLandmarks || null;
        const rawConf = rawSide ? clamp(Number(rawSide.confidence ?? 0.85), 0, 1) : 0;

        let freshBasis = null;
        if (rawPts && rawPts.length >= 21 && rawConf > 0.20) {
          const pWrist = readPt(rawPts, 0, yFlip, mirrorX, yawQ);
          const pIndexMcp = readPt(rawPts, 5, yFlip, mirrorX, yawQ);
          const pMiddleMcp = readPt(rawPts, 9, yFlip, mirrorX, yawQ);
          const pPinkyMcp = readPt(rawPts, 17, yFlip, mirrorX, yawQ);
          if (pWrist && pIndexMcp && pMiddleMcp && pPinkyMcp) {
            const mpAim = _vA.subVectors(pMiddleMcp, pWrist);
            const mpAcross = _vB.subVectors(pIndexMcp, pPinkyMcp);
            freshBasis = basisFromAimAcross(mpAim, mpAcross, isLeft);
          }
        }

        let pts = null;
        let mpBasisWorld = null;
        let conf = 0;
        if (freshBasis) {
          pts = rawPts;
          mpBasisWorld = freshBasis;
          conf = rawConf;
          heldPts = rawPts;
          heldBasis = freshBasis.clone();
          heldConf = rawConf;
          missedGap = 0;
        } else if (heldBasis && missedGap < maxHoldGap) {
          missedGap++;
          const decay = Math.pow(0.84, missedGap);
          pts = heldPts;
          mpBasisWorld = heldBasis;
          conf = heldConf * decay;
        } else {
          heldPts = null;
          heldBasis = null;
          heldConf = 0;
        }

        // Refine Hand palm orientation by blending palm twist when MediaPipe Hand basis is confident
        if (handTrack && mpBasisWorld && conf > 0.25) {
          const parentWorldQ = _qA;
          if (handBone.parent) {
            handBone.parent.getWorldQuaternion(parentWorldQ);
          } else {
            parentWorldQ.identity();
          }
          // Target world matrix = mpBasisWorld * rigBasisLocalInv
          _mA.multiplyMatrices(mpBasisWorld, rigBasisLocalInv);
          _qB.setFromRotationMatrix(_mA).normalize();
          const targetLocalHandQ = parentWorldQ.clone().invert().multiply(_qB).normalize();
          const curHandQ = new THREE.Quaternion().fromArray(handTrack, f * 4);
          // Clamp both wrist angular excursion and pronation/supination twist safely
          const deltaWrist = curHandQ.clone().invert().multiply(targetLocalHandQ).normalize();
          const wristTwist = extractTwistAroundAxis(deltaWrist, rigHandAimLocal);
          const twistAng = 2 * Math.acos(clamp(Math.abs(wristTwist.w), 0, 1));
          const safeTargetQ = twistAng > 0.72
            ? curHandQ.clone().multiply(deltaWrist.multiply(wristTwist.clone().invert())).multiply(new THREE.Quaternion().slerpQuaternions(new THREE.Quaternion(), wristTwist, 0.72 / twistAng)).normalize()
            : targetLocalHandQ;
          const clampedTarget = clampDeltaFromRest(safeTargetQ, curHandQ, 0.78);
          curHandQ.slerp(clampedTarget, clamp(conf * 0.60, 0, 0.60)).normalize();
          curHandQ.toArray(handTrack, f * 4);
          handBone.quaternion.copy(curHandQ);
          handBone.updateWorldMatrix(true, false);
        }

        // Solve finger chains in canonical rig-hand local space:
        // Map every MP bone segment direction into Hand local space using:
        //   dir_handLocal = rigBasisLocal * mpBasisWorld^T * dir_mpWorld
        const mpToRigHandLocal = mpBasisWorld
          ? _mB.copy(rigBasisLocal).multiply(_mA.copy(mpBasisWorld).transpose())
          : null;

        for (const fs of fingerStates) {
          // Walk FK relative to Hand bone (Hand local space = identity root)
          let parentQInHand = new THREE.Quaternion();
          for (const cb of fs.chainBones) {
            let solvedLocalQ = cb.relaxQ.clone();
            if (mpToRigHandLocal && pts) {
              const [iA, iB] = cb.segPair;
              const pA = readPt(pts, iA, yFlip, mirrorX, yawQ);
              const pB = readPt(pts, iB, yFlip, mirrorX, yawQ);
              if (pA && pB) {
                const segDirMp = _vC.subVectors(pB, pA);
                if (segDirMp.lengthSq() > 1e-7) {
                  segDirMp.normalize();
                  // Direction expressed inside Hand's local coordinate frame
                  const targetDirInHand = segDirMp.clone().transformDirection(mpToRigHandLocal).normalize();
                  const baseRotInHand = _qA.copy(parentQInHand).multiply(cb.restLocalQ).normalize();
                  let clamped;
                  if (cb.sIdx >= 2 && fs.fName !== 'Thumb') {
                    // PIP & DIP are 1-DOF flexion hinge joints (no axial twist or lateral bend)
                    const targetDirInBone = targetDirInHand.clone().applyQuaternion(baseRotInHand.clone().invert()).normalize();
                    const projAim = targetDirInBone.dot(cb.aimLocal);
                    const projPalm = targetDirInBone.dot(cb.palmPerpLocal);
                    const hingeTheta = clamp(Math.atan2(projPalm, projAim), -0.10, 1.85);
                    clamped = cb.restLocalQ.clone().multiply(new THREE.Quaternion().setFromAxisAngle(cb.flexAxisLocal, hingeTheta)).normalize();
                  } else {
                    // MCP / Thumb: remove spurious axial roll around bone aim axis
                    const curAimInHand = _vD.copy(cb.aimLocal).applyQuaternion(baseRotInHand).normalize();
                    const swing = _qB.setFromUnitVectors(curAimInHand, targetDirInHand);
                    const targetWorldInHand = swing.multiply(baseRotInHand).normalize();
                    const rawLocal = parentQInHand.clone().invert().multiply(targetWorldInHand).normalize();
                    const deltaLocal = cb.restLocalQ.clone().invert().multiply(rawLocal).normalize();
                    const axialTwist = extractTwistAroundAxis(deltaLocal, cb.aimLocal);
                    const swingOnlyLocal = cb.restLocalQ.clone().multiply(deltaLocal).multiply(axialTwist.invert()).normalize();
                    clamped = clampDeltaFromRest(swingOnlyLocal, cb.restLocalQ, cb.maxRad);
                  }
                  solvedLocalQ = cb.relaxQ.clone().slerp(clamped, clamp(conf * 1.1, 0, 1)).normalize();
                }
              }
            }
            solvedLocalQ.toArray(cb.outVals, f * 4);
            parentQInHand.multiply(solvedLocalQ).normalize();
          }
        }
      }

      // Smooth all solved finger tracks temporally & emit KeyframeTracks
      for (const fs of fingerStates) {
        for (const cb of fs.chainBones) {
          smoothFlatQuatTrack(cb.outVals, nFrames, dt, 0.35);
          extraTracks.push(new THREE.QuaternionKeyframeTrack(`${cb.bone.name}.quaternion`, times, cb.outVals));
        }
      }
      if (handTrack) {
        smoothFlatQuatTrack(handTrack, nFrames, dt, 0.35);
        // Velocity-limit single-frame wrist spikes (>13 deg @ 30fps) caused by fast flick dropouts
        const maxStepRad = (13.0 * Math.PI / 180) * clamp(dt * 30, 0.65, 1.8);
        const qPrev = new THREE.Quaternion();
        const qCur = new THREE.Quaternion();
        for (let f = 1; f < nFrames; f++) {
          qPrev.fromArray(handTrack, (f - 1) * 4);
          qCur.fromArray(handTrack, f * 4);
          if (qPrev.dot(qCur) < 0) qCur.set(-qCur.x, -qCur.y, -qCur.z, -qCur.w);
          const ang = 2 * Math.acos(clamp(qPrev.dot(qCur), -1, 1));
          if (ang > maxStepRad) {
            qPrev.slerp(qCur, maxStepRad / ang).normalize().toArray(handTrack, f * 4);
          }
        }
      }
    }
  } finally {
    // Restore original bind/scene pose cleanly
    for (const [bone, q] of savedQuats.entries()) {
      bone.quaternion.copy(q);
    }
    character?.updateMatrixWorld(true);
  }

  return extraTracks;
}

/**
 * Swing-twist helper: splits `qDelta = qSwing * qTwist` around unit `axis`, returning `qTwist`.
 */
function extractTwistAroundAxis(qDelta, axis) {
  const dot = qDelta.x * axis.x + qDelta.y * axis.y + qDelta.z * axis.z;
  const twist = new THREE.Quaternion(axis.x * dot, axis.y * dot, axis.z * dot, qDelta.w);
  const lenSq = twist.lengthSq();
  if (lenSq < 1e-8) return new THREE.Quaternion();
  return twist.normalize();
}

/**
 * Distribute longitudinal limb roll onto anatomical Twist/Roll helper bones
 * (`{left,right}{Arm,Forearm,UpLeg}Twist`) when present on CC4 / VRM / UE / Rigify rigs.
 */
export function applyTwistDistribution({ rig, coreQuatBuffers, times, fps = 30 }) {
  if (!rig || !rig.twists || !coreQuatBuffers || !times?.length) return [];
  const nFrames = times.length;
  const dt = 1 / Math.max(10, fps);
  const extraTracks = [];

  const specs = [
    { parentKey: 'leftForearm', twistKey: 'leftForearmTwist', childBoneKey: 'leftHand', ratio: 0.55 },
    { parentKey: 'rightForearm', twistKey: 'rightForearmTwist', childBoneKey: 'rightHand', ratio: 0.55 },
    { parentKey: 'leftArm', twistKey: 'leftArmTwist', childBoneKey: 'leftForearm', ratio: 0.42 },
    { parentKey: 'rightArm', twistKey: 'rightArmTwist', childBoneKey: 'rightForearm', ratio: 0.42 },
    { parentKey: 'leftUpLeg', twistKey: 'leftUpLegTwist', childBoneKey: 'leftLeg', ratio: 0.35 },
    { parentKey: 'rightUpLeg', twistKey: 'rightUpLegTwist', childBoneKey: 'rightLeg', ratio: 0.35 },
  ];

  const qRest = new THREE.Quaternion();
  const qCur = new THREE.Quaternion();
  const qDelta = new THREE.Quaternion();
  const qTwistDelta = new THREE.Quaternion();

  for (const spec of specs) {
    const twistBone = rig.twists[spec.twistKey];
    const parentBone = rig[spec.parentKey];
    const childBone = rig[spec.childBoneKey];
    const parentBuf = coreQuatBuffers[spec.parentKey];
    if (!twistBone || !parentBone || !parentBuf) continue;

    // Infer longitudinal bone axis along parent -> child (fallback +Y)
    const axis = childBone && childBone.position.lengthSq() > 1e-6
      ? childBone.position.clone().normalize()
      : new THREE.Vector3(0, 1, 0);

    const twistRestQ = twistBone.quaternion.clone();
    const parentRestQ = parentBone.quaternion.clone();
    const twistVals = new Float32Array(nFrames * 4);
    const isChildOfParent = twistBone.parent === parentBone;

    for (let f = 0; f < nFrames; f++) {
      qCur.fromArray(parentBuf, f * 4).normalize();
      qRest.copy(parentRestQ).normalize();
      // Delta in parent's rest frame: qCur = qRest * qDelta
      qDelta.copy(qRest).invert().multiply(qCur).normalize();
      const twist = extractTwistAroundAxis(qDelta, axis);
      qTwistDelta.identity().slerp(twist, spec.ratio).normalize();

      if (isChildOfParent) {
        // Remove partial twist from parent or apply smooth roll fraction onto twist helper
        const qOut = twistRestQ.clone().multiply(qTwistDelta).normalize();
        qOut.toArray(twistVals, f * 4);
      } else {
        // Sibling helper bone: copy full parent swing + scaled twist
        const qSwing = qDelta.clone().multiply(twist.clone().invert()).normalize();
        const qOut = twistRestQ.clone().multiply(qSwing).multiply(qTwistDelta).normalize();
        qOut.toArray(twistVals, f * 4);
      }
    }

    smoothFlatQuatTrack(twistVals, nFrames, dt, 0.3);
    extraTracks.push(new THREE.QuaternionKeyframeTrack(`${twistBone.name}.quaternion`, times, twistVals));
  }

  return extraTracks;
}
