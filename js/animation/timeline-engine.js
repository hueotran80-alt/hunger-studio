/**
 * Web Blender Studio - Timeline & Keyframe Animation Engine
 * Full-featured keyframe animation system supporting:
 * - Position (X,Y,Z), Rotation (Euler X,Y,Z), Scale (X,Y,Z) tracks per object.
 * - Keyframe insertion, deletion, and retrieval.
 * - Interpolations: Linear, Smooth Cubic (Catmull-Rom Spline), EaseInOut.
 * - Timeline playback: Play, Pause, Stop, Seek, Step, Loop, variable FPS (24, 30, 60).
 * - Turntable Camera 360 showcase mode and turntable keyframe baker.
 * - Auto-keyframing (Record mode) on object transform changes.
 */

import * as THREE from 'three';
import {
  evaluateFCurve,
  resolveFCurvePoints,
  updateHandlePair,
  cloneHandlePair,
  normalizeHandleType,
  normalizeExtrapolation
} from '../core/fcurve-math.js';
import {
  DriverManager,
  cloneActionData,
  computeActionRange,
  evaluateNLATracks,
  compileDriverExpression,
} from './nla-drivers.js';

function cloneHandlesMap(handles) {
  if (!handles || typeof handles !== 'object') return undefined;
  const out = {};
  let hasAny = false;
  for (const [k, v] of Object.entries(handles)) {
    const c = cloneHandlePair(v);
    if (c) {
      out[k] = c;
      hasAny = true;
    }
  }
  return hasAny ? out : undefined;
}

function cloneFCurveMetaMap(meta) {
  if (!meta || typeof meta !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(meta)) {
    if (v && typeof v === 'object') {
      out[k] = {
        extrapolation: normalizeExtrapolation(v.extrapolation)
      };
    }
  }
  return out;
}

function cloneObjectKeyframe(k) {
  const copy = {
    frame: k.frame,
    interpolation: k.interpolation || 'smooth',
    position: k.position ? { ...k.position } : null,
    rotation: k.rotation ? { ...k.rotation } : null,
    scale: k.scale ? { ...k.scale } : null
  };
  const h = cloneHandlesMap(k.handles);
  if (h) copy.handles = h;
  return copy;
}

function cloneBoneRotKeyframe(k) {
  const copy = {
    frame: k.frame,
    interpolation: k.interpolation || 'smooth',
    quaternion: k.quaternion ? { ...k.quaternion } : null,
    euler: k.euler ? { ...k.euler } : null
  };
  if (k.eulerModified) copy.eulerModified = true;
  const h = cloneHandlesMap(k.handles);
  if (h) copy.handles = h;
  return copy;
}

function cloneBonePosKeyframe(k) {
  const copy = {
    frame: k.frame,
    interpolation: k.interpolation || 'smooth',
    position: k.position ? { ...k.position } : null
  };
  const h = cloneHandlesMap(k.handles);
  if (h) copy.handles = h;
  return copy;
}

/**
 * Event emitter for animation events
 */
class EventEmitter {
  constructor() {
    this._listeners = new Map();
  }

  on(event, handler) {
    if (!this._listeners.has(event)) {
      this._listeners.set(event, new Set());
    }
    this._listeners.get(event).add(handler);
    return () => this.off(event, handler);
  }

  off(event, handler) {
    if (this._listeners.has(event)) {
      this._listeners.get(event).delete(handler);
    }
  }

  emit(event, data) {
    if (this._listeners.has(event)) {
      this._listeners.get(event).forEach(handler => {
        try {
          handler(data);
        } catch (err) {
          console.error(`[TimelineEngine] Error in listener for "${event}":`, err);
        }
      });
    }
  }
}

/**
 * Timeline Animation Engine
 */
export class TimelineEngine extends EventEmitter {
  /**
   * @param {Object} [options]
   * @param {number} [options.fps=30]
   * @param {number} [options.startFrame=0]
   * @param {number} [options.endFrame=250]
   * @param {string} [options.defaultInterpolation='smooth']
   */
  constructor(options = {}) {
    super();

    // Configuration
    this.fps = options.fps || 30;
    this.startFrame = options.startFrame !== undefined ? options.startFrame : 0;
    this.endFrame = options.endFrame !== undefined ? options.endFrame : 250;
    this.defaultInterpolation = options.defaultInterpolation || 'smooth'; // 'smooth' | 'linear' | 'easeInOut'

    // Playback state
    this.currentFrame = this.startFrame;
    this.isPlaying = false;
    this.loop = true;
    this.autoKeyframe = false;

    // Internal timing
    this._accumulatedTime = 0;
    this._isEvaluating = false; // Prevents recursive auto-keyframing during playback

    // Track storage: Map<objectUuid, TrackObject>
    // TrackObject: { object, uuid, name, keyframes: Array<Keyframe> }
    this.tracks = new Map();

    // Clip storage: Map<objectUuid, { object, clip, mixer, action, duration }>
    // AnimationClip gắn trên vật thể (mocap, .glb import) — Play/seek của
    // timeline phát chúng bằng AnimationMixer, không cần keyframe thủ công.
    this.clips = new Map();

    // Turntable 360 mode
    this.turntable = {
      active: false,
      targetObject: null,
      targetCenter: new THREE.Vector3(0, 1, 0),
      radius: 8,
      height: 4,
      originalCameraPos: null,
      originalControlsTarget: null
    };

    // External references
    this.engine = options.engine || null;
    this.sceneManager = options.sceneManager || null;
    if (this.sceneManager && !this.sceneManager.timelineEngine) {
      this.sceneManager.timelineEngine = this;
    }
    this._renderCallbackUnregister = null;

    // Wave 4B: Actions, NLA Tracks & Sandboxed Drivers
    this.actionsMap = new Map();
    this.activeActionByObject = new Map();
    this.nlaTracks = new Map();
    this._nlaObjectRefs = new Map();
    this.driverManager = new DriverManager({ sceneManager: this.sceneManager });
  }

  /**
   * Binds Engine and SceneManager to TimelineEngine
   * @param {Engine} engine 
   * @param {SceneManager} sceneManager 
   */
  bindEngine(engine, sceneManager) {
    this.engine = engine;
    this.sceneManager = sceneManager;
    if (this.driverManager) {
      this.driverManager.sceneManager = sceneManager;
    }

    // Register render callback with Three.js Engine loop
    if (this._renderCallbackUnregister) {
      this._renderCallbackUnregister();
    }
    this._renderCallbackUnregister = this.engine.addRenderCallback(
      (delta) => { this.update(delta); },
      { isActive: () => this.isPlaying }
    );

    // Listen to SceneManager object removal to clean up dead tracks, clips, NLA & Drivers
    if (this.sceneManager) {
      this.sceneManager.on('objectRemoved', ({ object }) => {
        if (!object) return;
        this.clearTracksUnder(object);
      });
    }

    // Hook into TransformControls for Auto-Keyframing
    if (this.engine.transformControls) {
      this.engine.transformControls.addEventListener('mouseUp', () => {
        if (this.autoKeyframe && !this._isEvaluating) {
          const active = this.sceneManager ? this.sceneManager.getActiveObject() : null;
          if (active) {
            this.insertKeyframe(active, Math.round(this.currentFrame));
          }
        }
      });
    }

    // Also hook into SceneManager history changes for auto-keyframing if properties change
    if (this.sceneManager) {
      this.sceneManager.on('historyChanged', () => {
        if (this.autoKeyframe && !this._isEvaluating && !this.isPlaying) {
          const active = this.sceneManager.getActiveObject();
          if (active) {
            this.insertKeyframe(active, Math.round(this.currentFrame));
          }
        }
      });
    }
  }

  // =========================================================================
  // KEYFRAME MANAGEMENT (Track & Keyframe CRUD)
  // =========================================================================

  /**
   * Gets or initializes track entry for an object
   * @param {THREE.Object3D} object 
   * @returns {Object}
   */
  _ensureTrack(object) {
    if (!object || !object.uuid) return null;
    if (!this.tracks.has(object.uuid)) {
      this.tracks.set(object.uuid, {
        object: object,
        uuid: object.uuid,
        name: object.name || 'Object',
        keyframes: [],
        fcurveMeta: {},
        boneTracks: new Map() // boneName -> { boneName, bone, rotationTrack: [], positionTrack: [] }
      });
    }
    const track = this.tracks.get(object.uuid);
    if (!track.boneTracks) {
      track.boneTracks = new Map();
    }
    if (!track.fcurveMeta || typeof track.fcurveMeta !== 'object') {
      track.fcurveMeta = {};
    }
    track.object = object;
    track.name = object.name || track.name;
    return track;
  }

  /**
   * Finds the root Armature, SkinnedMesh, or Character object for a given bone or sub-object
   * @param {THREE.Object3D} target
   * @returns {THREE.Object3D|null}
   */
  _findArmatureRoot(target) {
    if (!target) return null;
    if (target.userData?.isArmature || target.isSkinnedMesh || target.skeleton || target.userData?.skeleton) {
      return target;
    }
    if (target.isBone) {
      let cur = target.parent;
      while (cur) {
        if (cur.userData?.isArmature || cur.isSkinnedMesh || cur.userData?.skeleton) {
          return cur;
        }
        if (!cur.parent || cur.parent.type === 'Scene' || cur.userData?.isSystemObject) {
          return cur;
        }
        cur = cur.parent;
      }
    }
    if (typeof window !== 'undefined' && window.rigSystem && window.rigSystem.activeCharacter) {
      return window.rigSystem.activeCharacter;
    }
    return target;
  }

  /**
   * Extracts all bones from an Armature, SkinnedMesh, or Character
   * @param {THREE.Object3D} target
   * @returns {Array<THREE.Bone>}
   */
  _extractBones(target) {
    if (!target) return [];
    if (target.bones && Array.isArray(target.bones)) return target.bones;
    if (target.isBone) return [target];
    if (target.skeleton && target.skeleton.bones) return target.skeleton.bones;
    if (target.userData?.skeleton && target.userData.skeleton.bones) return target.userData.skeleton.bones;

    const bones = [];
    if (target.traverse) {
      target.traverse((child) => {
        if (child.isBone && !bones.includes(child)) {
          bones.push(child);
        }
        if (child.skeleton && child.skeleton.bones) {
          child.skeleton.bones.forEach(b => {
            if (!bones.includes(b)) bones.push(b);
          });
        }
      });
    }
    return bones;
  }

  /**
   * Inserts a keyframe on a specific bone of an Armature or SkinnedMesh
   * Supports Quaternion & Euler rotations with SLERP and position channels
   * Tracks: bone_{boneName}_rotation, bone_{boneName}_position
   * @param {THREE.Object3D} [armatureOrMesh]
   * @param {THREE.Bone|string} [boneNameOrBone]
   * @param {number} [frame=this.currentFrame]
   * @param {Array<string>} [channels=['rotation']]
   * @param {string} [interpolation=this.defaultInterpolation]
   * @returns {Object|null}
   */
  insertBoneKeyframe(
    armatureOrMesh = null,
    boneNameOrBone = null,
    frame = this.currentFrame,
    channels = ['rotation'],
    interpolation = this.defaultInterpolation
  ) {
    let armature = armatureOrMesh;
    let bone = null;
    let boneName = '';

    if (boneNameOrBone && boneNameOrBone.isBone) {
      bone = boneNameOrBone;
      boneName = bone.name;
      if (!armature) {
        armature = this._findArmatureRoot(bone);
      }
    } else if (typeof boneNameOrBone === 'string') {
      boneName = boneNameOrBone;
    }

    if (!armature) {
      armature = (this.sceneManager ? this.sceneManager.getActiveObject() : null);
      if (!armature && typeof window !== 'undefined' && window.rigSystem) {
        armature = window.rigSystem.activeCharacter;
      }
    }

    if (!armature) {
      console.warn('[TimelineEngine] No armature or character found for bone keyframe.');
      return null;
    }

    if (!bone && boneName) {
      const allBones = this._extractBones(armature);
      bone = allBones.find(b => b.name === boneName || b.name.toLowerCase() === boneName.toLowerCase());
    }

    if (!bone) {
      if (typeof window !== 'undefined' && window.rigSystem && window.rigSystem.activeBone) {
        bone = window.rigSystem.activeBone;
        boneName = bone.name;
      }
    }

    if (!bone) {
      console.warn(`[TimelineEngine] Bone "${boneName}" not found on armature "${armature.name}".`);
      return null;
    }

    const track = this._ensureTrack(armature);
    if (!track.boneTracks.has(bone.name)) {
      track.boneTracks.set(bone.name, {
        boneName: bone.name,
        bone: bone,
        rotationTrack: [], // Track: bone_{boneName}_rotation
        positionTrack: []  // Track: bone_{boneName}_position
      });
    }

    const boneEntry = track.boneTracks.get(bone.name);
    boneEntry.bone = bone;
    const frameNumber = Math.round(frame);
    const resKf = { frame: frameNumber };

    // 1. Rotation Track (Quaternion + Euler)
    if (channels.includes('rotation') || channels.includes('all')) {
      let rKf = boneEntry.rotationTrack.find(k => k.frame === frameNumber);
      if (!rKf) {
        rKf = {
          frame: frameNumber,
          interpolation: interpolation || this.defaultInterpolation,
          quaternion: null,
          euler: null
        };
        boneEntry.rotationTrack.push(rKf);
      } else if (interpolation) {
        rKf.interpolation = interpolation;
      }

      rKf.quaternion = {
        x: Number(bone.quaternion.x.toFixed(6)),
        y: Number(bone.quaternion.y.toFixed(6)),
        z: Number(bone.quaternion.z.toFixed(6)),
        w: Number(bone.quaternion.w.toFixed(6))
      };
      rKf.euler = {
        x: Number(bone.rotation.x.toFixed(5)),
        y: Number(bone.rotation.y.toFixed(5)),
        z: Number(bone.rotation.z.toFixed(5))
      };
      boneEntry.rotationTrack.sort((a, b) => a.frame - b.frame);
      resKf.rotation = rKf;
    }

    // 2. Position Track (e.g. Hips vertical/horizontal movement)
    if (channels.includes('position') || channels.includes('location') || channels.includes('all')) {
      let pKf = boneEntry.positionTrack.find(k => k.frame === frameNumber);
      if (!pKf) {
        pKf = {
          frame: frameNumber,
          interpolation: interpolation || this.defaultInterpolation,
          position: null
        };
        boneEntry.positionTrack.push(pKf);
      } else if (interpolation) {
        pKf.interpolation = interpolation;
      }

      pKf.position = {
        x: Number(bone.position.x.toFixed(5)),
        y: Number(bone.position.y.toFixed(5)),
        z: Number(bone.position.z.toFixed(5))
      };
      boneEntry.positionTrack.sort((a, b) => a.frame - b.frame);
      resKf.position = pKf;
    }

    this.syncActiveActionFromTrack(armature);
    this.emit('boneKeyframeAdded', {
      armature,
      bone,
      boneName: bone.name,
      frame: frameNumber,
      keyframe: resKf
    });
    this.emit('tracksChanged', { reason: 'boneKeyframeAdded', object: armature, bone });
    return resKf;
  }

  /**
   * Inserts keyframes for ALL bones in an Armature at once (Blender Whole Armature Keyframing)
   * @param {THREE.Object3D} [armatureOrMesh]
   * @param {number} [frame=this.currentFrame]
   * @param {Array<string>} [channels=['rotation']]
   * @param {string} [interpolation=this.defaultInterpolation]
   * @returns {Array<Object>}
   */
  insertAllBonesKeyframe(
    armatureOrMesh = null,
    frame = this.currentFrame,
    channels = ['rotation'],
    interpolation = this.defaultInterpolation
  ) {
    let armature = armatureOrMesh;
    if (!armature) {
      armature = (this.sceneManager ? this.sceneManager.getActiveObject() : null);
      if (!armature && typeof window !== 'undefined' && window.rigSystem) {
        armature = window.rigSystem.activeCharacter;
      }
    }
    if (!armature) {
      console.warn('[TimelineEngine] No armature selected to keyframe all bones.');
      return [];
    }

    const bones = this._extractBones(armature);
    if (!bones || bones.length === 0) {
      console.warn(`[TimelineEngine] Armature "${armature.name}" has no bones.`);
      return [];
    }

    const results = [];
    for (const b of bones) {
      const ch = (b.name === 'Hips' || b.name === 'hips' || b.name === 'Root')
        ? ['rotation', 'position']
        : channels;
      const kf = this.insertBoneKeyframe(armature, b, frame, ch, interpolation);
      if (kf) results.push(kf);
    }

    this.emit('tracksChanged', { reason: 'allBonesKeyframed', object: armature, count: results.length });
    return results;
  }

  /**
   * Deletes a bone keyframe at the given frame
   */
  deleteBoneKeyframe(armatureOrMesh, boneName, frame = this.currentFrame, channel = null) {
    const armature = armatureOrMesh || (this.sceneManager ? this.sceneManager.getActiveObject() : null);
    if (!armature || !this.tracks.has(armature.uuid)) return false;

    const track = this.tracks.get(armature.uuid);
    if (!track.boneTracks || !track.boneTracks.has(boneName)) return false;

    const boneEntry = track.boneTracks.get(boneName);
    const frameNumber = Math.round(frame);

    if (!channel || channel === 'rotation' || channel === 'all') {
      const rIdx = boneEntry.rotationTrack.findIndex(k => k.frame === frameNumber);
      if (rIdx !== -1) boneEntry.rotationTrack.splice(rIdx, 1);
    }
    if (!channel || channel === 'position' || channel === 'location' || channel === 'all') {
      const pIdx = boneEntry.positionTrack.findIndex(k => k.frame === frameNumber);
      if (pIdx !== -1) boneEntry.positionTrack.splice(pIdx, 1);
    }

    if (boneEntry.rotationTrack.length === 0 && boneEntry.positionTrack.length === 0) {
      track.boneTracks.delete(boneName);
    }

    this.syncActiveActionFromTrack(armature);
    this.emit('tracksChanged', { reason: 'boneKeyframeRemoved', object: armature, boneName, frame: frameNumber });
    return true;
  }

  /**
   * Retrieves all bone tracks for an armature
   */
  getBoneTracks(armatureOrMesh) {
    const armature = armatureOrMesh || (this.sceneManager ? this.sceneManager.getActiveObject() : null);
    if (!armature || !this.tracks.has(armature.uuid)) return new Map();
    const track = this.tracks.get(armature.uuid);
    return track.boneTracks || new Map();
  }

  /**
   * Inserts a keyframe on an object at a given frame.
   * Blender hotkey 'I' equivalent.
   * Automatically detects Bone selection in Pose Mode or whole Armature.
   * @param {THREE.Object3D} [object] Object to keyframe (defaults to active object)
   * @param {number} [frame=this.currentFrame] Target frame number
   * @param {Array<string>} [channels=['position','rotation','scale']] Channels to keyframe
   * @param {string} [interpolation=this.defaultInterpolation]
   * @returns {Object|null} The inserted or updated keyframe
   */
  insertKeyframe(
    object = null,
    frame = this.currentFrame,
    channels = ['position', 'rotation', 'scale'],
    interpolation = this.defaultInterpolation
  ) {
    const rs = (typeof window !== 'undefined' ? window.rigSystem : null);

    // Guard the public API: a bad frame (e.g. a channel name passed by mistake)
    // used to create NaN keyframes that corrupted every later evaluate().
    const safeFrame = Number(frame);
    if (!Number.isFinite(safeFrame)) {
      console.warn('[TimelineEngine] insertKeyframe: frame must be a finite number, got', frame);
      return null;
    }
    frame = safeFrame;

    // If target is directly a bone, delegate to insertBoneKeyframe
    if (object && object.isBone) {
      return this.insertBoneKeyframe(null, object, frame, channels, interpolation);
    }

    // If no object passed but Pose Mode is active with an activeBone, keyframe that bone
    if (!object && rs && rs.isPoseMode && rs.activeBone) {
      return this.insertBoneKeyframe(null, rs.activeBone, frame, ['rotation', 'position'], interpolation);
    }

    const target = object || (this.sceneManager ? this.sceneManager.getActiveObject() : null);
    if (!target) {
      console.warn('[TimelineEngine] No object specified or selected for keyframe.');
      return null;
    }

    // If channel requested is all_bones or bones, insert all bones on armature
    if (channels.includes('all_bones') || channels.includes('bones')) {
      return this.insertAllBonesKeyframe(target, frame, ['rotation'], interpolation);
    }

    if (channels.includes('active_bone') && rs && rs.activeBone) {
      return this.insertBoneKeyframe(target, rs.activeBone, frame, ['rotation', 'position'], interpolation);
    }

    const track = this._ensureTrack(target);
    const frameNumber = Math.round(frame);

    // Look for existing keyframe at this exact frame
    let kf = track.keyframes.find(k => k.frame === frameNumber);

    if (!kf) {
      kf = {
        frame: frameNumber,
        interpolation: interpolation,
        position: null,
        rotation: null,
        scale: null
      };
      track.keyframes.push(kf);
    } else {
      if (interpolation) {
        kf.interpolation = interpolation;
      }
    }

    // Capture object transform snapshot for requested channels
    if (channels.includes('position') || channels.includes('all') || channels.includes('location')) {
      kf.position = {
        x: Number(target.position.x.toFixed(5)),
        y: Number(target.position.y.toFixed(5)),
        z: Number(target.position.z.toFixed(5))
      };
    }

    if (channels.includes('rotation') || channels.includes('all')) {
      kf.rotation = {
        x: Number(target.rotation.x.toFixed(5)),
        y: Number(target.rotation.y.toFixed(5)),
        z: Number(target.rotation.z.toFixed(5))
      };
    }

    if (channels.includes('scale') || channels.includes('all')) {
      kf.scale = {
        x: Number(target.scale.x.toFixed(5)),
        y: Number(target.scale.y.toFixed(5)),
        z: Number(target.scale.z.toFixed(5))
      };
    }

    // Sort keyframes ascending by frame
    track.keyframes.sort((a, b) => a.frame - b.frame);

    this.syncActiveActionFromTrack(target);
    this.emit('keyframeAdded', {
      object: target,
      track,
      frame: frameNumber,
      keyframe: kf
    });
    this.emit('tracksChanged', { reason: 'keyframeAdded', object: target });

    return kf;
  }

  /**
   * Deletes a keyframe from an object at the given frame
   * @param {THREE.Object3D} [object]
   * @param {number} [frame=this.currentFrame]
   * @param {Array<string>|null} [channels=null] Specific channels to remove, or all if null
   * @returns {boolean} True if a keyframe or channel was removed
   */
  deleteKeyframe(object = null, frame = this.currentFrame, channels = null) {
    const target = object || (this.sceneManager ? this.sceneManager.getActiveObject() : null);
    if (!target || !this.tracks.has(target.uuid)) return false;

    const track = this.tracks.get(target.uuid);
    const frameNumber = Math.round(frame);
    const index = track.keyframes.findIndex(k => k.frame === frameNumber);

    if (index === -1) return false;

    const kf = track.keyframes[index];

    if (!channels || channels.includes('all')) {
      // Remove entire keyframe
      track.keyframes.splice(index, 1);
    } else {
      // Remove specific channels
      if (channels.includes('position') || channels.includes('location')) kf.position = null;
      if (channels.includes('rotation')) kf.rotation = null;
      if (channels.includes('scale')) kf.scale = null;

      // If no channels remain on this keyframe, remove it completely
      if (!kf.position && !kf.rotation && !kf.scale) {
        track.keyframes.splice(index, 1);
      }
    }

    // Object keyframes hết, nhưng bone track có thể vẫn còn keyed: giữ track
    // để xoá keyframe của object không xoá luôn toàn bộ track của rig.
    const hasBoneTracks = track.boneTracks instanceof Map && track.boneTracks.size > 0;
    if (track.keyframes.length === 0 && !hasBoneTracks) {
      this.tracks.delete(target.uuid);
    }

    this.syncActiveActionFromTrack(target);
    this.emit('keyframeRemoved', { object: target, frame: frameNumber });
    this.emit('tracksChanged', { reason: 'keyframeRemoved', object: target });
    return true;
  }

  /**
   * Checks if an object has a keyframe at the given frame
   * @param {THREE.Object3D} object 
   * @param {number} frame 
   * @returns {boolean}
   */
  hasKeyframe(object, frame) {
    if (!object || !this.tracks.has(object.uuid)) return false;
    const track = this.tracks.get(object.uuid);
    const frameNumber = Math.round(frame);
    return track.keyframes.some(k => k.frame === frameNumber);
  }

  /**
   * Retrieves keyframe at a specific frame
   * @param {THREE.Object3D} object 
   * @param {number} frame 
   * @returns {Object|null}
   */
  getKeyframe(object, frame) {
    if (!object || !this.tracks.has(object.uuid)) return null;
    const track = this.tracks.get(object.uuid);
    const frameNumber = Math.round(frame);
    return track.keyframes.find(k => k.frame === frameNumber) || null;
  }

  /**
   * Retrieves all keyframes for an object
   * @param {THREE.Object3D} object 
   * @returns {Array<Object>}
   */
  getKeyframes(object) {
    if (!object || !this.tracks.has(object.uuid)) return [];
    return this.tracks.get(object.uuid).keyframes;
  }

  /**
   * Serializes manual keyframe tracks for project save. Bone tracks use Maps
   * internally, so they are converted to arrays here.
   */
  exportTracks() {
    const entries = [];
    for (const track of this.tracks.values()) {
      if (!track?.object) continue;
      const boneTracks = [];
      if (track.boneTracks instanceof Map) {
        for (const bone of track.boneTracks.values()) {
          if (!bone || (!bone.rotationTrack?.length && !bone.positionTrack?.length)) continue;
          boneTracks.push({
            boneName: bone.boneName,
            rotationTrack: bone.rotationTrack || [],
            positionTrack: bone.positionTrack || []
          });
        }
      }
      if (!track.keyframes?.length && !boneTracks.length) continue;
      entries.push({
        objectId: track.object.userData?.id || track.object.uuid,
        name: track.name,
        keyframes: (track.keyframes || []).map(cloneObjectKeyframe),
        fcurveMeta: cloneFCurveMetaMap(track.fcurveMeta),
        boneTracks: boneTracks.map((bt) => ({
          boneName: bt.boneName,
          rotationTrack: (bt.rotationTrack || []).map(cloneBoneRotKeyframe),
          positionTrack: (bt.positionTrack || []).map(cloneBonePosKeyframe)
        }))
      });
    }
    return entries;
  }

  /**
   * Restores tracks produced by exportTracks().
   * @param {Array} entries
   * @param {(id:string)=>THREE.Object3D|null} resolve
   */
  restoreTracks(entries, resolve = () => null) {
    if (!Array.isArray(entries)) return 0;
    let restored = 0;
    for (const entry of entries) {
      if (!entry || !Array.isArray(entry.keyframes) && !entry.boneTracks?.length) continue;
      const object = resolve(entry.objectId);
      if (!object) continue;
      const track = this._ensureTrack(object);
      if (!track) continue;
      track.name = entry.name || object.name || 'Object';
      track.keyframes = (entry.keyframes || []).map(cloneObjectKeyframe)
        .sort((a, b) => a.frame - b.frame);
      track.fcurveMeta = cloneFCurveMetaMap(entry.fcurveMeta);
      track.boneTracks = track.boneTracks || new Map();
      track.boneTracks.clear();
      for (const boneEntry of entry.boneTracks || []) {
        const bone = object.getObjectByName?.(boneEntry.boneName) || null;
        track.boneTracks.set(boneEntry.boneName, {
          boneName: boneEntry.boneName,
          bone,
          rotationTrack: (boneEntry.rotationTrack || []).map(cloneBoneRotKeyframe),
          positionTrack: (boneEntry.positionTrack || []).map(cloneBonePosKeyframe)
        });
      }
      restored += 1;
    }
    if (restored) this.emit('tracksChanged', { reason: 'tracksRestored' });
    return restored;
  }

  /**
   * Gets list of all objects currently having keyframed tracks
   * @returns {Array<THREE.Object3D>}
   */
  getAllKeyframedObjects() {
    const list = [];
    for (const track of this.tracks.values()) {
      const hasBoneTracks = track.boneTracks instanceof Map && track.boneTracks.size > 0;
      if (track.object && (track.keyframes.length > 0 || hasBoneTracks)) {
        list.push(track.object);
      }
    }
    return list;
  }

  /**
   * Deep-clone mọi keyframe/bone track/clip dưới `root` (gồm cả root) theo uuid.
   * Undo cần bản chụp này vì xoá object sẽ huỷ toàn bộ track của nó.
   * @param {THREE.Object3D} root
   * @returns {Array<{uuid:string,name:string,keyframes:Array,boneTracks:Array,clip:Object|null}>}
   */
  captureTracks(root) {
    if (!root) return [];
    const nodes = new Map();
    const collect = (node) => { if (node?.uuid) nodes.set(node.uuid, node); };
    collect(root);
    if (typeof root.traverse === 'function') root.traverse(collect);

    const entries = [];
    for (const [uuid, object] of nodes) {
      const track = this.tracks.get(uuid);
      const keyframes = (track?.keyframes || []).map(cloneObjectKeyframe);
      const fcurveMeta = cloneFCurveMetaMap(track?.fcurveMeta);
      const boneTracks = [];
      for (const bone of (track?.boneTracks?.values?.() || [])) {
        if (!bone) continue;
        const rotationTrack = (bone.rotationTrack || []).map(cloneBoneRotKeyframe);
        const positionTrack = (bone.positionTrack || []).map(cloneBonePosKeyframe);
        if (!rotationTrack.length && !positionTrack.length) continue;
        boneTracks.push({ boneName: bone.boneName, rotationTrack, positionTrack });
      }
      const clip = this.clips.get(uuid)?.clip || null;
      const activeActionId = this.activeActionByObject.get(uuid) || null;
      const nlaList = this.nlaTracks.get(uuid);
      const nlaTracks = Array.isArray(nlaList) && nlaList.length > 0
        ? nlaList.map((t) => ({
            id: t.id,
            name: t.name,
            muted: !!t.muted,
            solo: !!t.solo,
            strips: (t.strips || []).map((s) => ({ ...s })),
          }))
        : [];
      const drivers = this.driverManager
        ? this.driverManager.drivers
            .filter((d) => d.targetUuid === uuid)
            .map((d) => ({
              ...d,
              variables: (d.variables || []).map((v) => ({ ...v })),
            }))
        : [];
      if (!keyframes.length && !boneTracks.length && !clip && !activeActionId && !nlaTracks.length && !drivers.length) continue;
      entries.push({ uuid, name: track?.name || object.name, keyframes, fcurveMeta, boneTracks, clip, activeActionId, nlaTracks, drivers });
    }
    return entries;
  }

  /**
   * Khôi phục bản chụp từ captureTracks(); các object phải đã ở lại trong cảnh
   * dưới `root`.
   * @param {Array} entries
   * @param {THREE.Object3D} [root]
   * @returns {number} số track đã khôi phục
   */
  restoreCapturedTracks(entries, root = null) {
    if (!Array.isArray(entries) || entries.length === 0) return 0;
    const byUuid = new Map();
    const collect = (node) => { if (node?.uuid) byUuid.set(node.uuid, node); };
    if (root) {
      collect(root);
      if (typeof root.traverse === 'function') root.traverse(collect);
    }

    let restored = 0;
    let restoredNla = false;
    let restoredDrv = false;
    for (const entry of entries) {
      const object = byUuid.get(entry.uuid);
      if (!object) continue;
      if (entry.keyframes?.length || entry.boneTracks?.length) {
        const track = this._ensureTrack(object);
        if (!track) continue;
        track.name = entry.name || object.name || 'Object';
        track.keyframes = (entry.keyframes || []).map(cloneObjectKeyframe)
          .sort((a, b) => a.frame - b.frame);
        track.fcurveMeta = cloneFCurveMetaMap(entry.fcurveMeta);
        track.boneTracks = new Map();
        for (const boneEntry of entry.boneTracks || []) {
          track.boneTracks.set(boneEntry.boneName, {
            boneName: boneEntry.boneName,
            bone: object.getObjectByName?.(boneEntry.boneName) || null,
            rotationTrack: (boneEntry.rotationTrack || []).map(cloneBoneRotKeyframe),
            positionTrack: (boneEntry.positionTrack || []).map(cloneBonePosKeyframe)
          });
        }
        restored += 1;
      }
      if (entry.activeActionId && this.actionsMap.has(entry.activeActionId)) {
        this.activeActionByObject.set(object.uuid, entry.activeActionId);
      }
      if (Array.isArray(entry.nlaTracks) && entry.nlaTracks.length > 0) {
        this._nlaObjectRefs.set(object.uuid, object);
        this.nlaTracks.set(object.uuid, entry.nlaTracks.map((t) => ({
          id: t.id,
          name: t.name,
          muted: !!t.muted,
          solo: !!t.solo,
          strips: (t.strips || []).map((s) => ({ ...s })),
        })));
        restoredNla = true;
      }
      if (Array.isArray(entry.drivers) && entry.drivers.length > 0 && this.driverManager) {
        for (const d of entry.drivers) {
          if (!this.driverManager.drivers.some((x) => x.id === d.id)) {
            this.driverManager.drivers.push({
              ...d,
              targetUuid: object.uuid,
              targetUserId: object.userData?.id || object.uuid,
              variables: (d.variables || []).map((v) => ({ ...v })),
            });
            restoredDrv = true;
          }
        }
      }
      if (entry.clip && !this.clips.has(object.uuid)) {
        try {
          this.attachClip(object, entry.clip, { syncRange: false });
        } catch (err) {
          console.warn('[TimelineEngine] Could not re-attach clip after undo:', err);
        }
      }
    }
    if (restored) this.emit('tracksChanged', { reason: 'tracksRestored', root });
    if (restoredNla) this.emit('nlaChanged', { reason: 'nlaRestored', root });
    if (restoredDrv) this.emit('driversChanged', { reason: 'driversRestored', root });
    return restored;
  }

  /**
   * Xoá mọi track/clip dưới `root` (gồm cả root) trong một lần, thay vì chỉ
   * object gốc — xoá group phải dọn luôn track của các con.
   * @param {THREE.Object3D} root
   * @returns {number} số track đã xoá
   */
  clearTracksUnder(root) {
    if (!root) return 0;
    const nodes = [];
    if (typeof root.traverse === 'function') root.traverse((node) => nodes.push(node));
    else nodes.push(root);

    let removed = 0;
    let nlaRemoved = false;
    let drvRemoved = false;
    const removedUuids = new Set(nodes.map((n) => n.uuid));
    for (const node of nodes) {
      if (this.tracks.delete(node.uuid)) removed += 1;
      if (this.clips.has(node.uuid)) this.detachClip(node);
      this.activeActionByObject.delete(node.uuid);
      if (this.nlaTracks.delete(node.uuid)) nlaRemoved = true;
      this._nlaObjectRefs.delete(node.uuid);
    }
    if (this.driverManager && Array.isArray(this.driverManager.drivers) && this.driverManager.drivers.length > 0) {
      const beforeLen = this.driverManager.drivers.length;
      this.driverManager.drivers = this.driverManager.drivers.filter((d) => {
        const keep = !removedUuids.has(d.targetUuid);
        if (!keep) this.driverManager._compiledCache.delete(d.id);
        return keep;
      });
      drvRemoved = this.driverManager.drivers.length !== beforeLen;
    }
    if (removed) this.emit('tracksChanged', { reason: 'tracksCleared', root });
    if (nlaRemoved) this.emit('nlaChanged', { reason: 'nlaCleared', root });
    if (drvRemoved) this.emit('driversChanged', { reason: 'driversCleared', root });
    return removed;
  }

  /**
   * Clears all keyframes for a specific object
   * @param {THREE.Object3D} object 
   */
  clearObjectKeyframes(object) {
    if (object && this.tracks.has(object.uuid)) {
      this.tracks.delete(object.uuid);
      this.emit('tracksChanged', { reason: 'trackCleared', object });
    }
  }

  /**
   * Clears all tracks and keyframes across the entire scene
   */
  clearAllKeyframes() {
    this.tracks.clear();
    this.activeActionByObject.clear();
    this.nlaTracks.clear();
    this._nlaObjectRefs.clear();
    if (this.driverManager) {
      this.driverManager.drivers = [];
      this.driverManager._compiledCache.clear();
    }
    this.emit('tracksChanged', { reason: 'allTracksCleared' });
    this.emit('nlaChanged', { reason: 'cleared' });
    this.emit('driversChanged', { reason: 'cleared' });
  }

  // =========================================================================
  // INTERPOLATION MATHEMATICS (Catmull-Rom, Linear, EaseInOut)
  // =========================================================================

  /**
   * Evaluates a single scalar property channel using cubic Bezier F-Curve solver
   * and per-curve extrapolation.
   * @param {Array<{frame: number, val: number, interpolation?: string, hl?: number[], hr?: number[], handleType?: string}>} points
   * @param {number} frame
   * @param {Object} [options]
   * @returns {number|null}
   */
  _interpolateChannel(points, frame, options = {}) {
    return evaluateFCurve(points, frame, {
      defaultInterpolation: this.defaultInterpolation,
      extrapolation: options.extrapolation || 'constant',
      unwrapAngles: false
    });
  }

  /**
   * Angle-aware rotation F-Curve interpolation (Euler unwrapping + cubic Bezier handles).
   * @param {Array<{frame: number, val: number, interpolation?: string, hl?: number[], hr?: number[], handleType?: string}>} points
   * @param {number} frame
   * @param {Object} [options]
   * @returns {number|null}
   */
  _interpolateRotationChannel(points, frame, options = {}) {
    return evaluateFCurve(points, frame, {
      defaultInterpolation: this.defaultInterpolation,
      extrapolation: options.extrapolation || 'constant',
      unwrapAngles: true
    });
  }

  /**
   * Spherical Linear Interpolation (SLERP) for bone rotation quaternions
   * Smoothly interpolates 4D orientations avoiding gimbal lock
   * @param {Array<{frame: number, quaternion: {x,y,z,w}, interpolation?: string}>} points
   * @param {number} frame
   * @returns {THREE.Quaternion|null}
   */
  _interpolateQuaternion(points, frame) {
    if (!points || points.length === 0) return null;
    if (points.length === 1) {
      const q = points[0].quaternion;
      return new THREE.Quaternion(q.x, q.y, q.z, q.w);
    }

    if (frame <= points[0].frame) {
      const q = points[0].quaternion;
      return new THREE.Quaternion(q.x, q.y, q.z, q.w);
    }
    if (frame >= points[points.length - 1].frame) {
      const q = points[points.length - 1].quaternion;
      return new THREE.Quaternion(q.x, q.y, q.z, q.w);
    }

    let idx = 0;
    while (idx < points.length - 1 && points[idx + 1].frame < frame) {
      idx++;
    }

    const p1 = points[idx];
    const p2 = points[idx + 1];

    if (p1.frame === p2.frame) {
      const q = p1.quaternion;
      return new THREE.Quaternion(q.x, q.y, q.z, q.w);
    }

    let t = (frame - p1.frame) / (p2.frame - p1.frame);
    const mode = (p1.interpolation || this.defaultInterpolation || '').toLowerCase();

    if (mode === 'constant') {
      return new THREE.Quaternion(p1.quaternion.x, p1.quaternion.y, p1.quaternion.z, p1.quaternion.w);
    }

    // Cubic Hermite smoothstep for natural easing
    if (mode === 'easeinout' || mode === 'smooth' || mode === 'bezier') {
      t = t * t * (3 - 2 * t);
    }

    const q1 = new THREE.Quaternion(p1.quaternion.x, p1.quaternion.y, p1.quaternion.z, p1.quaternion.w);
    const q2 = new THREE.Quaternion(p2.quaternion.x, p2.quaternion.y, p2.quaternion.z, p2.quaternion.w);

    return q1.slerp(q2, t);
  }

  // =========================================================================
  // ANIMATION CLIPS (mocap / imported .glb)
  // =========================================================================

  /**
   * Gắn một AnimationClip lên vật thể để timeline phát nó theo frame.
   * Dùng cho clip mocap (được gắn vào nhân vật sau khi retarget) và clip của
   * file .glb import — trước đây Play chỉ chạy keyframe thủ công nên nhân vật
   * đứng yên dù đã có clip.
   * @param {THREE.Object3D} object
   * @param {THREE.AnimationClip} clip
   * @param {{ syncRange?: boolean }} [options] syncRange: nới endFrame cho đủ clip
   * @returns {Object|null} entry trong this.clips
   */
  attachClip(object, clip, options = {}) {
    if (!object || !clip || !Array.isArray(clip.tracks) || clip.tracks.length === 0) {
      return null;
    }

    // Chỉ giữ track trỏ tới node có thật trong vật thể — track mồ côi khiến mixer
    // không bind được gì và người dùng thấy nhân vật đứng yên.
    const usableTracks = clip.tracks.filter((track) => {
      try {
        const { nodeName } = THREE.PropertyBinding.parseTrackName(track.name);
        return !!THREE.PropertyBinding.findNode(object, nodeName);
      } catch (err) {
        return false;
      }
    });
    if (usableTracks.length === 0) {
      console.warn(`[TimelineEngine] Clip "${clip.name}" has no tracks targeting any node in "${object.name}"`);
      return null;
    }
    const usableClip = usableTracks.length === clip.tracks.length
      ? clip
      : new THREE.AnimationClip(clip.name, clip.duration, usableTracks, clip.blendMode);

    this.detachClip(object);

    const mixer = new THREE.AnimationMixer(object);
    const action = mixer.clipAction(usableClip);
    // `loop: false` must survive: a one-shot clip holds its last pose at the end
    // instead of snapping back to the clip's first pose.
    const loop = options.loop !== false;
    action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1);
    action.clampWhenFinished = !loop;
    action.play();

    const duration = usableClip.duration > 0 ? usableClip.duration : 0;
    const entry = { object, clip: usableClip, mixer, action, duration };
    this.clips.set(object.uuid, entry);

    if (options.syncRange !== false && duration > 0) {
      const neededEnd = this.startFrame + Math.max(1, Math.ceil(duration * this.fps));
      if (neededEnd > this.endFrame) {
        this.setFrameRange(this.startFrame, neededEnd);
      }
    }

    // Đặt ngay về đúng frame đang đứng để nhân vật khớp timeline.
    this.evaluate(this.currentFrame);

    this.emit('clipAttached', { object, clip: usableClip });
    this.emit('tracksChanged', { reason: 'clipAttached', object, clip: usableClip });
    return entry;
  }

  /**
   * Gỡ clip khỏi vật thể (khi xoá vật thể hoặc thay clip mới).
   * @param {THREE.Object3D} object
   */
  detachClip(object) {
    if (!object) return false;
    const entry = this.clips.get(object.uuid);
    if (!entry) return false;
    try {
      entry.action.stop();
      entry.mixer.stopAllAction();
      entry.mixer.uncacheRoot(entry.object);
    } catch (err) {
      console.warn('[TimelineEngine] detachClip:', err);
    }
    this.clips.delete(object.uuid);
    this.emit('clipDetached', { object, clip: entry.clip });
    this.emit('tracksChanged', { reason: 'clipDetached', object });
    return true;
  }

  /**
   * Đang phát clip nào trên vật thể (hoặc null).
   * @param {THREE.Object3D} object
   */
  getAttachedClip(object) {
    if (!object) return null;
    const entry = this.clips.get(object.uuid);
    return entry ? entry.clip : null;
  }

  /**
   * Đặt thời điểm của mọi clip gắn trên vật thể theo frame timeline.
   * @param {number} frame
   */
  _evaluateClips(frame) {
    if (this.clips.size === 0) return;
    const time = Math.max(0, (frame - this.startFrame) / this.fps);

    for (const entry of this.clips.values()) {
      const obj = entry.object;
      if (!obj || !obj.parent) continue;
      entry.mixer.setTime(time);
      if (obj.skeleton && typeof obj.skeleton.update === 'function') {
        obj.skeleton.update();
      }
      if (obj.userData?.skeleton && typeof obj.userData.skeleton.update === 'function') {
        obj.userData.skeleton.update();
      }
    }

    if (typeof window !== 'undefined') {
      const rs = window.rigSystem;
      if (rs && typeof rs.updateSkeletonHelper === 'function') rs.updateSkeletonHelper();
    }
  }

  // =========================================================================
  // SCENE EVALUATION & APPLICATION
  // =========================================================================

  /**
   * Evaluates all tracks at a given frame and applies transforms to 3D objects
   * @param {number} [frame=this.currentFrame]
   */
  evaluate(frame = this.currentFrame) {
    this._isEvaluating = true;

    try {
      // 0. Sync any active Action records & evaluate NLA Tracks & Strips bottom-to-top
      for (const objUuid of this.nlaTracks.keys()) {
        const nlaList = this.nlaTracks.get(objUuid);
        if (!Array.isArray(nlaList) || nlaList.length === 0) continue;
        let obj = this._nlaObjectRefs.get(objUuid) || this.tracks.get(objUuid)?.object || null;
        if ((!obj || !obj.parent) && this.sceneManager?.traverseObjects) {
          this.sceneManager.traverseObjects((o) => {
            if (!obj && o.uuid === objUuid) obj = o;
          });
          if (obj) this._nlaObjectRefs.set(objUuid, obj);
        }
        if (!obj || !obj.parent) continue;

        const nlaPose = evaluateNLATracks(
          nlaList,
          (id) => this.getAction(id),
          frame,
          this.defaultInterpolation
        );
        if (!nlaPose) continue;

        if (nlaPose.position) {
          if (Number.isFinite(nlaPose.position.x)) obj.position.x = nlaPose.position.x;
          if (Number.isFinite(nlaPose.position.y)) obj.position.y = nlaPose.position.y;
          if (Number.isFinite(nlaPose.position.z)) obj.position.z = nlaPose.position.z;
        }
        if (nlaPose.rotation) {
          if (Number.isFinite(nlaPose.rotation.x)) obj.rotation.x = nlaPose.rotation.x;
          if (Number.isFinite(nlaPose.rotation.y)) obj.rotation.y = nlaPose.rotation.y;
          if (Number.isFinite(nlaPose.rotation.z)) obj.rotation.z = nlaPose.rotation.z;
        }
        if (nlaPose.scale) {
          if (Number.isFinite(nlaPose.scale.x)) obj.scale.x = nlaPose.scale.x;
          if (Number.isFinite(nlaPose.scale.y)) obj.scale.y = nlaPose.scale.y;
          if (Number.isFinite(nlaPose.scale.z)) obj.scale.z = nlaPose.scale.z;
        }
        if (nlaPose.bones && nlaPose.bones.size > 0) {
          const allBones = (obj.skeleton && obj.skeleton.bones) || (obj.userData?.skeleton && obj.userData.skeleton.bones) || this._extractBones(obj);
          let boneDirty = false;
          for (const [bName, bPose] of nlaPose.bones.entries()) {
            const bone = allBones.find((b) => b.name === bName || b.name.toLowerCase() === bName.toLowerCase());
            if (!bone) continue;
            if (bPose.position) {
              if (Number.isFinite(bPose.position.x)) bone.position.x = bPose.position.x;
              if (Number.isFinite(bPose.position.y)) bone.position.y = bPose.position.y;
              if (Number.isFinite(bPose.position.z)) bone.position.z = bPose.position.z;
              boneDirty = true;
            }
            if (bPose.rotation) {
              if (Number.isFinite(bPose.rotation.x)) bone.rotation.x = bPose.rotation.x;
              if (Number.isFinite(bPose.rotation.y)) bone.rotation.y = bPose.rotation.y;
              if (Number.isFinite(bPose.rotation.z)) bone.rotation.z = bPose.rotation.z;
              boneDirty = true;
            }
            bone.updateMatrixWorld(true);
          }
          if (boneDirty) {
            obj.skeleton?.update?.();
            obj.userData?.skeleton?.update?.();
          }
        }
        obj.updateMatrixWorld(true);
      }

      // 1. Evaluate all active keyframed object tracks on top of NLA
      for (const track of this.tracks.values()) {
        const obj = track.object;
        if (!obj || !obj.parent) continue; // Skip detached objects

        const meta = track.fcurveMeta || {};
        const makePt = (k, val, chKey) => {
          const h = k.handles?.[chKey];
          return {
            frame: k.frame,
            val,
            interpolation: k.interpolation || this.defaultInterpolation,
            hl: h?.hl || null,
            hr: h?.hr || null,
            handleType: h?.type || 'auto_clamped'
          };
        };

        const kfs = track.keyframes;
        if (kfs && kfs.length > 0) {
          const posPointsX = [], posPointsY = [], posPointsZ = [];
          const rotPointsX = [], rotPointsY = [], rotPointsZ = [];
          const sclPointsX = [], sclPointsY = [], sclPointsZ = [];

          for (const k of kfs) {
            if (k.position) {
              if (Number.isFinite(k.position.x)) posPointsX.push(makePt(k, k.position.x, 'position.x'));
              if (Number.isFinite(k.position.y)) posPointsY.push(makePt(k, k.position.y, 'position.y'));
              if (Number.isFinite(k.position.z)) posPointsZ.push(makePt(k, k.position.z, 'position.z'));
            }
            if (k.rotation) {
              if (Number.isFinite(k.rotation.x)) rotPointsX.push(makePt(k, k.rotation.x, 'rotation.x'));
              if (Number.isFinite(k.rotation.y)) rotPointsY.push(makePt(k, k.rotation.y, 'rotation.y'));
              if (Number.isFinite(k.rotation.z)) rotPointsZ.push(makePt(k, k.rotation.z, 'rotation.z'));
            }
            if (k.scale) {
              if (Number.isFinite(k.scale.x)) sclPointsX.push(makePt(k, k.scale.x, 'scale.x'));
              if (Number.isFinite(k.scale.y)) sclPointsY.push(makePt(k, k.scale.y, 'scale.y'));
              if (Number.isFinite(k.scale.z)) sclPointsZ.push(makePt(k, k.scale.z, 'scale.z'));
            }
          }

          if (posPointsX.length > 0) {
            const px = this._interpolateChannel(posPointsX, frame, { extrapolation: meta['position.x']?.extrapolation });
            if (px !== null) obj.position.x = px;
          }
          if (posPointsY.length > 0) {
            const py = this._interpolateChannel(posPointsY, frame, { extrapolation: meta['position.y']?.extrapolation });
            if (py !== null) obj.position.y = py;
          }
          if (posPointsZ.length > 0) {
            const pz = this._interpolateChannel(posPointsZ, frame, { extrapolation: meta['position.z']?.extrapolation });
            if (pz !== null) obj.position.z = pz;
          }

          if (rotPointsX.length > 0) {
            const rx = this._interpolateRotationChannel(rotPointsX, frame, { extrapolation: meta['rotation.x']?.extrapolation });
            if (rx !== null) obj.rotation.x = rx;
          }
          if (rotPointsY.length > 0) {
            const ry = this._interpolateRotationChannel(rotPointsY, frame, { extrapolation: meta['rotation.y']?.extrapolation });
            if (ry !== null) obj.rotation.y = ry;
          }
          if (rotPointsZ.length > 0) {
            const rz = this._interpolateRotationChannel(rotPointsZ, frame, { extrapolation: meta['rotation.z']?.extrapolation });
            if (rz !== null) obj.rotation.z = rz;
          }

          if (sclPointsX.length > 0) {
            const sx = this._interpolateChannel(sclPointsX, frame, { extrapolation: meta['scale.x']?.extrapolation });
            if (sx !== null) obj.scale.x = sx;
          }
          if (sclPointsY.length > 0) {
            const sy = this._interpolateChannel(sclPointsY, frame, { extrapolation: meta['scale.y']?.extrapolation });
            if (sy !== null) obj.scale.y = sy;
          }
          if (sclPointsZ.length > 0) {
            const sz = this._interpolateChannel(sclPointsZ, frame, { extrapolation: meta['scale.z']?.extrapolation });
            if (sz !== null) obj.scale.z = sz;
          }

          obj.updateMatrixWorld(true);
        }

        // 1.b Evaluate Skeletal Bone Tracks (Bezier Euler when handles/extrap authored, else Quaternion SLERP)
        if (track.boneTracks && track.boneTracks.size > 0) {
          let hasUpdatedBones = false;
          const allBones = (obj.skeleton && obj.skeleton.bones) || (obj.userData?.skeleton && obj.userData.skeleton.bones) || this._extractBones(obj);

          for (const boneEntry of track.boneTracks.values()) {
            let bone = boneEntry.bone;
            if (!bone || !bone.parent) {
              bone = allBones.find(b => b.name === boneEntry.boneName || b.name.toLowerCase() === boneEntry.boneName.toLowerCase());
              if (bone) boneEntry.bone = bone;
            }
            if (!bone) continue;

            // Rotation Channel
            if (boneEntry.rotationTrack && boneEntry.rotationTrack.length > 0) {
              const bPrefix = `bone:${boneEntry.boneName}:`;
              const hasCustomRotCurves = boneEntry.rotationTrack.some((rk) =>
                rk.eulerModified ||
                (rk.handles && (rk.handles['rotation.x'] || rk.handles['rotation.y'] || rk.handles['rotation.z'])) ||
                (rk.euler && (!Number.isFinite(rk.euler.x) || !Number.isFinite(rk.euler.y) || !Number.isFinite(rk.euler.z)))
              ) || ['rotation.x', 'rotation.y', 'rotation.z'].some((ch) => {
                const ex = meta[bPrefix + ch]?.extrapolation;
                return ex && ex !== 'constant';
              });

              if (hasCustomRotCurves) {
                const rxPts = [], ryPts = [], rzPts = [];
                for (const rk of boneEntry.rotationTrack) {
                  let e = rk.euler;
                  if (!e && rk.quaternion) {
                    const tmpE = new THREE.Euler().setFromQuaternion(
                      new THREE.Quaternion(rk.quaternion.x, rk.quaternion.y, rk.quaternion.z, rk.quaternion.w)
                    );
                    e = { x: tmpE.x, y: tmpE.y, z: tmpE.z };
                  }
                  if (!e) continue;
                  if (Number.isFinite(e.x)) rxPts.push(makePt(rk, e.x, 'rotation.x'));
                  if (Number.isFinite(e.y)) ryPts.push(makePt(rk, e.y, 'rotation.y'));
                  if (Number.isFinite(e.z)) rzPts.push(makePt(rk, e.z, 'rotation.z'));
                }
                const rx = rxPts.length ? this._interpolateRotationChannel(rxPts, frame, { extrapolation: meta[bPrefix + 'rotation.x']?.extrapolation }) : bone.rotation.x;
                const ry = ryPts.length ? this._interpolateRotationChannel(ryPts, frame, { extrapolation: meta[bPrefix + 'rotation.y']?.extrapolation }) : bone.rotation.y;
                const rz = rzPts.length ? this._interpolateRotationChannel(rzPts, frame, { extrapolation: meta[bPrefix + 'rotation.z']?.extrapolation }) : bone.rotation.z;
                bone.rotation.set(rx ?? bone.rotation.x, ry ?? bone.rotation.y, rz ?? bone.rotation.z);
                hasUpdatedBones = true;
              } else {
                const q = this._interpolateQuaternion(boneEntry.rotationTrack, frame);
                if (q) {
                  bone.quaternion.copy(q);
                  hasUpdatedBones = true;
                }
              }
            }

            // Position Channel: 3D vector interpolation (e.g. Hips root motion)
            if (boneEntry.positionTrack && boneEntry.positionTrack.length > 0) {
              const bPrefix = `bone:${boneEntry.boneName}:`;
              const posX = [], posY = [], posZ = [];
              for (const pk of boneEntry.positionTrack) {
                if (pk.position) {
                  if (Number.isFinite(pk.position.x)) posX.push(makePt(pk, pk.position.x, 'position.x'));
                  if (Number.isFinite(pk.position.y)) posY.push(makePt(pk, pk.position.y, 'position.y'));
                  if (Number.isFinite(pk.position.z)) posZ.push(makePt(pk, pk.position.z, 'position.z'));
                }
              }
              if (posX.length > 0) {
                const px = this._interpolateChannel(posX, frame, { extrapolation: meta[bPrefix + 'position.x']?.extrapolation });
                if (px !== null) { bone.position.x = px; hasUpdatedBones = true; }
              }
              if (posY.length > 0) {
                const py = this._interpolateChannel(posY, frame, { extrapolation: meta[bPrefix + 'position.y']?.extrapolation });
                if (py !== null) { bone.position.y = py; hasUpdatedBones = true; }
              }
              if (posZ.length > 0) {
                const pz = this._interpolateChannel(posZ, frame, { extrapolation: meta[bPrefix + 'position.z']?.extrapolation });
                if (pz !== null) { bone.position.z = pz; hasUpdatedBones = true; }
              }
            }

            bone.updateMatrixWorld(true);
          }

          if (hasUpdatedBones) {
            if (obj.skeleton && typeof obj.skeleton.update === 'function') {
              obj.skeleton.update();
            }
            if (obj.userData?.skeleton && typeof obj.userData.skeleton.update === 'function') {
              obj.userData.skeleton.update();
            }
            const rs = (typeof window !== 'undefined' ? window.rigSystem : null);
            if (rs && typeof rs.updateSkeletonHelper === 'function') {
              rs.updateSkeletonHelper();
            }
          }
        }
      }

      // 1.c Clips gắn trên vật thể (mocap / .glb import) — phát theo frame
      this._evaluateClips(frame);

      // 2. Evaluate Turntable Camera 360 if active
      if (this.turntable.active && this.engine && this.engine.camera) {
        this._evaluateTurntable(frame);
      }

      // 3. Evaluate Sandboxed Drivers (dependency graph final pass)
      if (this.driverManager && this.driverManager.drivers.length > 0) {
        this.driverManager.sceneManager = this.sceneManager || this.driverManager.sceneManager;
        this.driverManager.evaluateAll({
          frame,
          fps: this.fps,
          time: frame / Math.max(1, this.fps),
        });
      }

      // 4. Update active transform selection helper if present
      if (this.engine && typeof this.engine.updateSelectionHelper === 'function') {
        this.engine.updateSelectionHelper();
      }
    } finally {
      this._isEvaluating = false;
    }
  }

  // =========================================================================
  // TURNTABLE CAMERA 360 SHOWCASE
  // =========================================================================

  /**
   * Toggles Turntable 360 camera showcase mode
   * @param {THREE.Object3D} [targetObject] Object to orbit around
   * @returns {boolean} New active state
   */
  toggleTurntable(targetObject = null) {
    if (this.turntable.active) {
      this.stopTurntable();
      return false;
    } else {
      this.startTurntable(targetObject);
      return true;
    }
  }

  /**
   * Sets turntable state directly
   */
  setTurntable(enabled, targetObject = null) {
    if (enabled) {
      this.startTurntable(targetObject);
    } else {
      this.stopTurntable();
    }
  }

  /**
   * Starts Turntable 360 mode
   * @param {THREE.Object3D} [targetObject]
   */
  startTurntable(targetObject = null) {
    const active = targetObject || (this.sceneManager ? this.sceneManager.getActiveObject() : null);
    this.turntable.targetObject = active;

    const camera = this.engine ? this.engine.camera : null;
    const controls = this.engine ? this.engine.controls : null;

    if (!camera) return;

    // Calculate center of target object
    if (active) {
      const box = new THREE.Box3().setFromObject(active);
      box.getCenter(this.turntable.targetCenter);
      const size = new THREE.Vector3();
      box.getSize(size);
      const maxDim = Math.max(size.x, size.y, size.z, 2);
      this.turntable.radius = maxDim * 2.5;
      this.turntable.height = maxDim * 1.0;
    } else {
      this.turntable.targetCenter.set(0, 1, 0);
      this.turntable.radius = 8;
      this.turntable.height = 4;
    }

    if (!this.turntable.originalCameraPos) {
      this.turntable.originalCameraPos = camera.position.clone();
      if (controls) {
        this.turntable.originalControlsTarget = controls.target.clone();
      }
    }

    this.turntable.active = true;
    this._evaluateTurntable(this.currentFrame);
    this.emit('turntableToggled', { active: true });
  }

  /**
   * Stops Turntable 360 mode and restores camera
   */
  stopTurntable() {
    this.turntable.active = false;
    if (this.engine && this.engine.camera && this.turntable.originalCameraPos) {
      this.engine.camera.position.copy(this.turntable.originalCameraPos);
      if (this.engine.controls && this.turntable.originalControlsTarget) {
        this.engine.controls.target.copy(this.turntable.originalControlsTarget);
        this.engine.controls.update();
      }
      this.turntable.originalCameraPos = null;
      this.turntable.originalControlsTarget = null;
    }
    this.emit('turntableToggled', { active: false });
  }

  _evaluateTurntable(frame) {
    if (!this.engine || !this.engine.camera) return;
    const camera = this.engine.camera;
    const controls = this.engine.controls;
    const target = this.turntable.targetCenter;

    const range = Math.max(1, this.endFrame - this.startFrame);
    const fraction = (frame - this.startFrame) / range;
    const theta = fraction * Math.PI * 2; // 0 to 360 degrees

    const camX = target.x + this.turntable.radius * Math.sin(theta);
    const camZ = target.z + this.turntable.radius * Math.cos(theta);
    const camY = target.y + this.turntable.height;

    camera.position.set(camX, camY, camZ);
    camera.lookAt(target);

    if (controls) {
      controls.target.copy(target);
      controls.update();
    }
  }

  /**
   * Bakes 360 Turntable rotation directly into camera keyframes
   * so it can be exported or tweaked in timeline.
   */
  bakeTurntableKeyframes(targetObject = null, steps = 8) {
    if (!this.engine || !this.engine.camera) return;
    const camera = this.engine.camera;
    const active = targetObject || (this.sceneManager ? this.sceneManager.getActiveObject() : null);

    const center = new THREE.Vector3(0, 1, 0);
    let radius = 8;
    let height = 4;

    if (active) {
      const box = new THREE.Box3().setFromObject(active);
      box.getCenter(center);
      const size = new THREE.Vector3();
      box.getSize(size);
      const maxDim = Math.max(size.x, size.y, size.z, 2);
      radius = maxDim * 2.5;
      height = maxDim * 1.0;
    }

    const range = this.endFrame - this.startFrame;
    for (let i = 0; i <= steps; i++) {
      const frac = i / steps;
      const f = Math.round(this.startFrame + frac * range);
      const theta = frac * Math.PI * 2;

      const px = center.x + radius * Math.sin(theta);
      const pz = center.z + radius * Math.cos(theta);
      const py = center.y + height;

      camera.position.set(px, py, pz);
      camera.lookAt(center);

      this.insertKeyframe(camera, f, ['position', 'rotation'], 'smooth');
    }

    this.seekToFrame(this.startFrame);
  }

  // =========================================================================
  // SKELETAL MOTION PRESETS (Walk Cycle, Combat Slash/Punch, Wave Hand)
  // =========================================================================

  /**
   * Returns definition of built-in Skeletal Motion Presets
   * @returns {Object}
   */
  getSkeletalMotionPresets() {
    return {
      walk_cycle: {
        id: 'walk_cycle',
        name: 'Walk Cycle (24f Walk Loop)',
        icon: '🚶',
        fps: 24,
        startFrame: 0,
        endFrame: 24,
        loop: true,
        keyframes: [
          {
            frame: 0,
            hips: { y: 0.96 },
            rotations: {
              LeftUpLeg: { x: -28, z: 2 },
              LeftLeg: { x: 8 },
              LeftFoot: { x: -10 },
              RightUpLeg: { x: 26, z: -2 },
              RightLeg: { x: 20 },
              RightFoot: { x: 15 },
              LeftArm: { x: 25, z: -65 },
              LeftForeArm: { y: -15 },
              RightArm: { x: -22, z: -65 },
              RightForeArm: { y: -25 },
              Spine: { y: 6, x: 2 },
              Head: { y: -3 }
            }
          },
          {
            frame: 6,
            hips: { y: 1.00 },
            rotations: {
              LeftUpLeg: { x: -5, z: 2 },
              LeftLeg: { x: 45 },
              LeftFoot: { x: 5 },
              RightUpLeg: { x: 4, z: -2 },
              RightLeg: { x: 0 },
              RightFoot: { x: -5 },
              LeftArm: { x: 0, z: -70 },
              LeftForeArm: { y: -10 },
              RightArm: { x: 0, z: -70 },
              RightForeArm: { y: -10 },
              Spine: { y: 0, x: 1 },
              Head: { y: 0 }
            }
          },
          {
            frame: 12,
            hips: { y: 0.96 },
            rotations: {
              LeftUpLeg: { x: 26, z: 2 },
              LeftLeg: { x: 20 },
              LeftFoot: { x: 15 },
              RightUpLeg: { x: -28, z: -2 },
              RightLeg: { x: 8 },
              RightFoot: { x: -10 },
              LeftArm: { x: -22, z: -65 },
              LeftForeArm: { y: -25 },
              RightArm: { x: 25, z: -65 },
              RightForeArm: { y: -15 },
              Spine: { y: -6, x: 2 },
              Head: { y: 3 }
            }
          },
          {
            frame: 18,
            hips: { y: 1.00 },
            rotations: {
              LeftUpLeg: { x: 4, z: 2 },
              LeftLeg: { x: 0 },
              LeftFoot: { x: -5 },
              RightUpLeg: { x: -5, z: -2 },
              RightLeg: { x: 45 },
              RightFoot: { x: 5 },
              LeftArm: { x: 0, z: -70 },
              LeftForeArm: { y: -10 },
              RightArm: { x: 0, z: -70 },
              RightForeArm: { y: -10 },
              Spine: { y: 0, x: 1 },
              Head: { y: 0 }
            }
          },
          {
            frame: 24,
            hips: { y: 0.96 },
            rotations: {
              LeftUpLeg: { x: -28, z: 2 },
              LeftLeg: { x: 8 },
              LeftFoot: { x: -10 },
              RightUpLeg: { x: 26, z: -2 },
              RightLeg: { x: 20 },
              RightFoot: { x: 15 },
              LeftArm: { x: 25, z: -65 },
              LeftForeArm: { y: -15 },
              RightArm: { x: -22, z: -65 },
              RightForeArm: { y: -25 },
              Spine: { y: 6, x: 2 },
              Head: { y: -3 }
            }
          }
        ]
      },
      combat_slash: {
        id: 'combat_slash',
        name: 'Combat Slash / Punch (30f Action)',
        icon: '⚔️',
        fps: 30,
        startFrame: 0,
        endFrame: 30,
        loop: true,
        keyframes: [
          {
            frame: 0,
            hips: { y: 0.95 },
            rotations: {
              Spine: { x: 6, y: -12 },
              Spine2: { x: 4, y: -8 },
              LeftUpLeg: { x: -18, z: 8 },
              LeftLeg: { x: 30 },
              RightUpLeg: { x: 16, z: -8 },
              RightLeg: { x: 32 },
              LeftArm: { x: -38, z: -55 },
              LeftForeArm: { y: -75 },
              RightArm: { x: -32, z: -50 },
              RightForeArm: { y: -70 },
              Head: { y: 15, x: -3 }
            }
          },
          {
            frame: 8,
            hips: { y: 0.92 },
            rotations: {
              Spine: { x: 10, y: -30 },
              Spine2: { x: 8, y: -20 },
              LeftUpLeg: { x: -10, z: 6 },
              LeftLeg: { x: 22 },
              RightUpLeg: { x: 22, z: -10 },
              RightLeg: { x: 40 },
              LeftArm: { x: -48, z: -40 },
              LeftForeArm: { y: -50 },
              RightArm: { x: -15, z: -35 },
              RightForeArm: { y: -95 },
              Head: { y: 25, x: 2 }
            }
          },
          {
            frame: 15,
            hips: { y: 0.96 },
            rotations: {
              Spine: { x: -6, y: 32 },
              Spine2: { x: -4, y: 20 },
              LeftUpLeg: { x: -28, z: 12 },
              LeftLeg: { x: 45 },
              RightUpLeg: { x: 28, z: -4 },
              RightLeg: { x: 12 },
              LeftArm: { x: -18, z: -72 },
              LeftForeArm: { y: -85 },
              RightArm: { x: -92, z: -5 },
              RightForeArm: { y: 0 },
              Head: { y: -10, x: -4 }
            }
          },
          {
            frame: 22,
            hips: { y: 0.96 },
            rotations: {
              Spine: { x: -4, y: 28 },
              RightArm: { x: -88, z: 0 },
              RightForeArm: { y: -8 },
              LeftArm: { x: -22, z: -68 },
              Head: { y: -6 }
            }
          },
          {
            frame: 30,
            hips: { y: 0.95 },
            rotations: {
              Spine: { x: 6, y: -12 },
              Spine2: { x: 4, y: -8 },
              LeftUpLeg: { x: -18, z: 8 },
              LeftLeg: { x: 30 },
              RightUpLeg: { x: 16, z: -8 },
              RightLeg: { x: 32 },
              LeftArm: { x: -38, z: -55 },
              LeftForeArm: { y: -75 },
              RightArm: { x: -32, z: -50 },
              RightForeArm: { y: -70 },
              Head: { y: 15, x: -3 }
            }
          }
        ]
      },
      wave_hand: {
        id: 'wave_hand',
        name: 'Wave Hand (16f Wave)',
        icon: '👋',
        fps: 24,
        startFrame: 0,
        endFrame: 16,
        loop: true,
        keyframes: [
          {
            frame: 0,
            rotations: {
              RightShoulder: { z: 15 },
              RightArm: { x: 10, z: 125 },
              RightForeArm: { y: -65 },
              RightHand: { z: -25 },
              LeftArm: { x: -4, z: -74 },
              LeftForeArm: { y: -12 },
              Spine: { x: 2, z: -3 },
              Head: { z: -8, x: 2 }
            }
          },
          {
            frame: 4,
            rotations: {
              RightArm: { x: 12, z: 128 },
              RightForeArm: { y: -50 },
              RightHand: { z: 30 },
              Head: { z: -5 }
            }
          },
          {
            frame: 8,
            rotations: {
              RightArm: { x: 10, z: 122 },
              RightForeArm: { y: -70 },
              RightHand: { z: -30 },
              Head: { z: -10 }
            }
          },
          {
            frame: 12,
            rotations: {
              RightArm: { x: 12, z: 128 },
              RightForeArm: { y: -50 },
              RightHand: { z: 30 },
              Head: { z: -5 }
            }
          },
          {
            frame: 16,
            rotations: {
              RightShoulder: { z: 15 },
              RightArm: { x: 10, z: 125 },
              RightForeArm: { y: -65 },
              RightHand: { z: -25 },
              LeftArm: { x: -4, z: -74 },
              LeftForeArm: { y: -12 },
              Spine: { x: 2, z: -3 },
              Head: { z: -8, x: 2 }
            }
          }
        ]
      }
    };

  }

  /**
   * Applies a Skeletal Motion Preset to an armature/character
   * @param {THREE.Object3D} [armatureOrMesh]
   * @param {'walk_cycle'|'combat_slash'|'wave_hand'} presetKey
   * @returns {boolean}
   */
  applyMotionPreset(armatureOrMesh = null, presetKey = 'walk_cycle') {
    let armature = armatureOrMesh;
    if (!armature) {
      armature = (this.sceneManager ? this.sceneManager.getActiveObject() : null);
      if (!armature && typeof window !== 'undefined' && window.rigSystem) {
        armature = window.rigSystem.activeCharacter;
      }
      if (!armature && this.engine && this.engine.scene) {
        this.engine.scene.traverse(node => {
          if (!armature && node.isBone) {
            armature = this._findArmatureRoot(node);
          }
        });
      }
    }
    armature = this._findArmatureRoot(armature);

    if (!armature) {
      console.warn('[TimelineEngine] No armature or character found to apply motion preset.');
      return false;
    }

    const presets = this.getSkeletalMotionPresets();
    const preset = presets[presetKey];
    if (!preset) {
      console.warn(`[TimelineEngine] Unknown motion preset "${presetKey}".`);
      return false;
    }

    const track = this._ensureTrack(armature);
    track.boneTracks.clear();

    const bones = this._extractBones(armature);
    const boneMap = new Map();
    bones.forEach(b => {
      boneMap.set(b.name, b);
      boneMap.set(b.name.toLowerCase(), b);
      const clean = b.name.replace(/^mixamorig:?/i, '');
      boneMap.set(clean, b);
      boneMap.set(clean.toLowerCase(), b);
    });

    const rs = (typeof window !== 'undefined' ? window.rigSystem : null);
    if (rs && typeof rs._prepareRig === 'function') {
      rs._prepareRig(armature);
    }

    // Apply each preset keyframe snapshot
    for (const snap of preset.keyframes) {
      const f = snap.frame;

      // Reset bones to calibrated rest bind pose if rigSystem exists
      if (rs) {
        bones.forEach(b => {
          if (b.userData.restQuat) b.quaternion.copy(b.userData.restQuat);
        });
      }

      // Apply Hips position
      if (snap.hips) {
        const hipsBone = boneMap.get('Hips') || boneMap.get('hips') || bones[0];
        if (hipsBone) {
          if (snap.hips.x !== undefined) hipsBone.position.x = snap.hips.x;
          if (snap.hips.y !== undefined) hipsBone.position.y = snap.hips.y;
          if (snap.hips.z !== undefined) hipsBone.position.z = snap.hips.z;
          this.insertBoneKeyframe(armature, hipsBone, f, ['position']);
        }
      }

      // Apply rotations for all defined bones
      if (snap.rotations) {
        for (const [bName, deltaDeg] of Object.entries(snap.rotations)) {
          const bone = boneMap.get(bName) || boneMap.get(bName.toLowerCase());
          if (bone) {
            if (rs && typeof rs._setBoneCharDeltaQuat === 'function' && typeof rs._degDeltaToQuat === 'function') {
              rs._setBoneCharDeltaQuat(bone, rs._degDeltaToQuat(deltaDeg));
            } else {
              const r = Math.PI / 180;
              const euler = new THREE.Euler((deltaDeg.x || 0) * r, (deltaDeg.y || 0) * r, (deltaDeg.z || 0) * r, 'XYZ');
              bone.quaternion.setFromEuler(euler);
            }
            this.insertBoneKeyframe(armature, bone, f, ['rotation']);
          }
        }
      }
    }

    // Configure timeline parameters
    this.setFrameRange(preset.startFrame, preset.endFrame);
    this.setFPS(preset.fps || 24);
    this.setLoop(true);
    this.seekToFrame(0);

    this.emit('tracksChanged', { reason: 'motionPresetApplied', preset: presetKey, object: armature });
    this.emit('motionPresetApplied', { preset: presetKey, object: armature });
    return true;
  }

  // =========================================================================
  // TIMELINE PLAYBACK CONTROLS
  // =========================================================================

  /**
   * Starts playback
   */
  play() {
    if (this.isPlaying) return;
    // If reached end, wrap to start
    if (this.currentFrame >= this.endFrame) {
      this.currentFrame = this.startFrame;
    }
    this.isPlaying = true;
    this._accumulatedTime = 0;
    this.engine?.requestRender?.();
    this.emit('playStateChanged', { isPlaying: true });
  }

  /**
   * Pauses playback
   */
  pause() {
    if (!this.isPlaying) return;
    this.isPlaying = false;
    this.emit('playStateChanged', { isPlaying: false });
  }

  /**
   * Toggles play/pause
   */
  togglePlay() {
    if (this.isPlaying) {
      this.pause();
    } else {
      this.play();
    }
  }

  /**
   * Stops playback and resets to start frame
   */
  stop() {
    this.isPlaying = false;
    this.seekToFrame(this.startFrame);
    this.emit('playStateChanged', { isPlaying: false });
  }

  /**
   * Seeks to a specific frame and evaluates the animation
   * @param {number} frame Target frame
   * @param {boolean} [evaluateNow=true]
   */
  seekToFrame(frame, evaluateNow = true) {
    const raw = Number(frame);
    let safeFrame;
    if (Number.isFinite(raw)) {
      safeFrame = raw;
    } else if (raw === Infinity) {
      safeFrame = this.endFrame;
    } else if (raw === -Infinity) {
      safeFrame = this.startFrame;
    } else {
      safeFrame = Number.isFinite(this.currentFrame) ? this.currentFrame : this.startFrame;
    }
    const clamped = Math.max(this.startFrame, Math.min(this.endFrame, safeFrame));
    this.currentFrame = clamped;

    if (evaluateNow) {
      this.evaluate(this.currentFrame);
      this.engine?.requestRender?.();
    }

    this.emit('frameChanged', {
      frame: Math.round(this.currentFrame),
      subframe: this.currentFrame,
      isPlaying: this.isPlaying
    });
  }

  /**
   * Alias for seekToFrame
   */
  seek(frame, evaluateNow = true) {
    return this.seekToFrame(frame, evaluateNow);
  }

  /**
   * Steps current frame forward or backward by delta frames
   * @param {number} [delta=1]
   */
  stepFrame(delta = 1) {
    this.seekToFrame(Math.round(this.currentFrame) + delta);
  }

  /**
   * Jumps to nearest previous keyframe
   */
  jumpToPrevKeyframe() {
    const cur = Math.round(this.currentFrame);
    let prevFrame = -Infinity;

    // Search across active object or all keyframes
    const targetObj = this.sceneManager ? this.sceneManager.getActiveObject() : null;
    const tracksToSearch = targetObj && this.tracks.has(targetObj.uuid)
      ? [this.tracks.get(targetObj.uuid)]
      : Array.from(this.tracks.values());

    for (const track of tracksToSearch) {
      for (const k of track.keyframes) {
        if (k.frame < cur && k.frame > prevFrame) {
          prevFrame = k.frame;
        }
      }
    }

    if (prevFrame !== -Infinity) {
      this.seekToFrame(prevFrame);
    } else {
      this.seekToFrame(this.startFrame);
    }
  }

  /**
   * Jumps to nearest next keyframe
   */
  jumpToNextKeyframe() {
    const cur = Math.round(this.currentFrame);
    let nextFrame = Infinity;

    const targetObj = this.sceneManager ? this.sceneManager.getActiveObject() : null;
    const tracksToSearch = targetObj && this.tracks.has(targetObj.uuid)
      ? [this.tracks.get(targetObj.uuid)]
      : Array.from(this.tracks.values());

    for (const track of tracksToSearch) {
      for (const k of track.keyframes) {
        if (k.frame > cur && k.frame < nextFrame) {
          nextFrame = k.frame;
        }
      }
    }

    if (nextFrame !== Infinity) {
      this.seekToFrame(nextFrame);
    } else {
      this.seekToFrame(this.endFrame);
    }
  }

  /**
   * Sets frames-per-second (e.g. 24, 30, 60)
   * @param {number} fps 
   */
  setFPS(fps) {
    this.fps = Math.max(1, Math.min(120, Number(fps) || 30));
    this.emit('fpsChanged', { fps: this.fps });
  }

  /**
   * Sets frame range bounds
   * @param {number} start 
   * @param {number} end 
   */
  setFrameRange(start, end) {
    this.startFrame = Math.max(0, Math.min(end - 1, Number(start) || 0));
    this.endFrame = Math.max(this.startFrame + 1, Number(end) || 250);
    this.currentFrame = Math.max(this.startFrame, Math.min(this.endFrame, this.currentFrame));
    this.emit('frameRangeChanged', { start: this.startFrame, end: this.endFrame });
  }

  /**
   * Toggles playback looping
   * @param {boolean} [loop]
   */
  setLoop(loop) {
    this.loop = (loop !== undefined) ? !!loop : !this.loop;
    this.emit('loopToggled', { loop: this.loop });
  }

  /**
   * Toggles auto-keyframe recording
   * @param {boolean} [active]
   */
  setAutoKeyframe(active) {
    this.autoKeyframe = (active !== undefined) ? !!active : !this.autoKeyframe;
    this.emit('autoKeyframeToggled', { active: this.autoKeyframe });
  }

  /**
   * Sets default interpolation mode
   * @param {'bezier'|'smooth'|'linear'|'easeInOut'|'constant'} mode
   */
  setDefaultInterpolation(mode) {
    if (['bezier', 'smooth', 'linear', 'easeInOut', 'constant'].includes(mode)) {
      this.defaultInterpolation = mode;
      this.emit('interpolationChanged', { mode });
    }
  }

  // =========================================================================
  // F-CURVE HANDLES, EXTRAPOLATION & GRAPH EDITOR EDITING API
  // =========================================================================

  _resolveTrackChannelInfo(object, channel = 'rotation.y', boneName = 'auto') {
    if (!object) return null;
    const track = this.tracks.get(object.uuid);
    if (!track) return null;
    const [prop, axis] = String(channel || 'rotation.y').split('.');
    if (!prop || !axis) return null;

    if (track.boneTracks && track.boneTracks.size > 0) {
      let bName = null;
      let bEntry = null;
      if (boneName && boneName !== 'auto' && track.boneTracks.has(boneName)) {
        bName = boneName;
        bEntry = track.boneTracks.get(boneName);
      } else if (boneName === 'auto' && (!track.keyframes || track.keyframes.length === 0)) {
        const firstEntry = track.boneTracks.entries().next().value;
        if (firstEntry) {
          bName = firstEntry[0];
          bEntry = firstEntry[1];
        }
      }
      if (bEntry) {
        const list = prop === 'rotation' ? bEntry.rotationTrack : (prop === 'position' ? bEntry.positionTrack : null);
        if (list) {
          return {
            track,
            isBone: true,
            boneName: bName,
            boneEntry: bEntry,
            list,
            prop,
            axis,
            channel: `${prop}.${axis}`,
            metaKey: `bone:${bName}:${prop}.${axis}`,
          };
        }
      }
    }

    return {
      track,
      isBone: false,
      boneName: null,
      boneEntry: null,
      list: track.keyframes,
      prop,
      axis,
      channel: `${prop}.${axis}`,
      metaKey: `${prop}.${axis}`,
    };
  }

  getFCurveExtrapolation(object, channel = 'rotation.y', boneName = 'auto') {
    const info = this._resolveTrackChannelInfo(object, channel, boneName);
    if (!info) return 'constant';
    return normalizeExtrapolation(info.track.fcurveMeta?.[info.metaKey]?.extrapolation);
  }

  setFCurveExtrapolation(object, channel, extrapolation, boneName = 'auto') {
    const info = this._resolveTrackChannelInfo(object, channel, boneName);
    if (!info) return false;
    info.track.fcurveMeta = info.track.fcurveMeta || {};
    info.track.fcurveMeta[info.metaKey] = { extrapolation: normalizeExtrapolation(extrapolation) };
    this.syncActiveActionFromTrack(object);
    this.evaluate(this.currentFrame);
    this.emit('tracksChanged', { reason: 'fcurveExtrapolation', object, channel: info.channel });
    return true;
  }

  getFCurvePoints(object, channel = 'rotation.y', boneName = 'auto') {
    const info = this._resolveTrackChannelInfo(object, channel, boneName);
    if (!info) return { points: [], resolved: [], extrapolation: 'constant', isBone: false, metaKey: channel };

    const rawPoints = [];
    for (const k of info.list) {
      let val = null;
      if (info.isBone) {
        if (info.prop === 'rotation') {
          if (k.euler && Number.isFinite(k.euler[info.axis])) val = k.euler[info.axis];
          else if (k.quaternion) {
            const tmp = new THREE.Euler().setFromQuaternion(
              new THREE.Quaternion(k.quaternion.x, k.quaternion.y, k.quaternion.z, k.quaternion.w)
            );
            val = tmp[info.axis];
          }
        } else if (info.prop === 'position' && k.position && Number.isFinite(k.position[info.axis])) {
          val = k.position[info.axis];
        }
      } else if (k[info.prop] && Number.isFinite(k[info.prop][info.axis])) {
        val = k[info.prop][info.axis];
      }
      if (val === null) continue;
      const h = k.handles?.[info.channel];
      rawPoints.push({
        frame: k.frame,
        val,
        interpolation: k.interpolation || this.defaultInterpolation,
        hl: h?.hl ? [...h.hl] : null,
        hr: h?.hr ? [...h.hr] : null,
        handleType: h?.type || 'auto_clamped',
      });
    }

    const extrapolation = this.getFCurveExtrapolation(object, channel, boneName);
    const resolved = resolveFCurvePoints(rawPoints, {
      defaultInterpolation: this.defaultInterpolation,
      unwrapAngles: info.prop === 'rotation',
    });

    return {
      points: rawPoints,
      resolved,
      extrapolation,
      isBone: info.isBone,
      boneName: info.boneName,
      metaKey: info.metaKey,
      channel: info.channel,
    };
  }

  _extractChannelValue(info, kf) {
    if (!kf) return undefined;
    if (info.isBone && info.prop === 'rotation') {
      if (kf.euler && Number.isFinite(kf.euler[info.axis])) return kf.euler[info.axis];
      if (kf.quaternion) {
        const e = new THREE.Euler().setFromQuaternion(
          new THREE.Quaternion(kf.quaternion.x, kf.quaternion.y, kf.quaternion.z, kf.quaternion.w)
        );
        return e[info.axis];
      }
      return undefined;
    }
    const obj = kf[info.prop];
    return obj && Number.isFinite(obj[info.axis]) ? obj[info.axis] : undefined;
  }

  _assignChannelValue(info, kf, val) {
    if (info.isBone && info.prop === 'rotation') {
      if (!kf.euler) {
        const e = kf.quaternion
          ? new THREE.Euler().setFromQuaternion(new THREE.Quaternion(kf.quaternion.x, kf.quaternion.y, kf.quaternion.z, kf.quaternion.w))
          : new THREE.Euler();
        kf.euler = { x: e.x, y: e.y, z: e.z };
      }
      kf.euler[info.axis] = Number(val.toFixed(5));
      kf.eulerModified = true;
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(kf.euler.x || 0, kf.euler.y || 0, kf.euler.z || 0));
      kf.quaternion = {
        x: Number(q.x.toFixed(6)),
        y: Number(q.y.toFixed(6)),
        z: Number(q.z.toFixed(6)),
        w: Number(q.w.toFixed(6)),
      };
      return;
    }
    if (!kf[info.prop]) kf[info.prop] = {};
    kf[info.prop][info.axis] = Number(val.toFixed(5));
  }

  _clearChannelEntry(info, kf) {
    if (!kf) return;
    if (kf.handles && kf.handles[info.channel]) {
      delete kf.handles[info.channel];
      if (Object.keys(kf.handles).length === 0) delete kf.handles;
    }
    if (info.isBone && info.prop === 'rotation') {
      if (kf.euler) {
        delete kf.euler[info.axis];
        if (!Number.isFinite(kf.euler.x) && !Number.isFinite(kf.euler.y) && !Number.isFinite(kf.euler.z)) {
          kf.euler = null;
          kf.quaternion = null;
        }
      }
    } else if (kf[info.prop]) {
      delete kf[info.prop][info.axis];
      if (!Number.isFinite(kf[info.prop].x) && !Number.isFinite(kf[info.prop].y) && !Number.isFinite(kf[info.prop].z)) {
        kf[info.prop] = null;
      }
    }
  }

  _isKeyframeEmpty(info, kf) {
    if (info.isBone) {
      if (info.prop === 'rotation') return !kf.euler && !kf.quaternion;
      return !kf.position;
    }
    return !kf.position && !kf.rotation && !kf.scale;
  }

  /**
   * Edits a keyframe's frame/value/interpolation/handle on one F-Curve channel without touching sibling channels.
   */
  updateFCurveKeyframe(object, channel, srcFrame, patch = {}, boneName = 'auto') {
    const info = this._resolveTrackChannelInfo(object, channel, boneName);
    if (!info) return null;

    const srcIdx = info.list.findIndex((k) => Math.abs(k.frame - srcFrame) < 1e-4 && this._extractChannelValue(info, k) !== undefined);
    if (srcIdx === -1) return null;

    let kf = info.list[srcIdx];
    const currentVal = this._extractChannelValue(info, kf);
    const resolvedBefore = this.getFCurvePoints(object, channel, boneName).resolved;
    const prevPt = resolvedBefore.find((p) => Math.abs(p.frame - kf.frame) < 1e-4);

    if (!kf.handles) kf.handles = {};
    if (!kf.handles[info.channel] && prevPt) {
      kf.handles[info.channel] = {
        hl: [...prevPt.hl],
        hr: [...prevPt.hr],
        type: prevPt.handleType || 'auto_clamped',
      };
    }
    const existingHandle = kf.handles[info.channel] || { hl: [-3, 0], hr: [3, 0], type: 'auto_clamped' };

    // Handle modification
    let nextHandle = cloneHandlePair(existingHandle);
    if (patch.handleType) {
      nextHandle.type = normalizeHandleType(patch.handleType);
      if (nextHandle.type === 'auto_clamped' || nextHandle.type === 'vector') {
        nextHandle.hl = prevPt ? [...prevPt.hl] : nextHandle.hl;
        nextHandle.hr = prevPt ? [...prevPt.hr] : nextHandle.hr;
      }
    }
    if (patch.editedSide && Array.isArray(patch.handleOffset)) {
      nextHandle = updateHandlePair(nextHandle, patch.editedSide, patch.handleOffset[0], patch.handleOffset[1], patch.handleType || null);
    }

    const nextInterp = patch.interpolation || kf.interpolation;
    const nextVal = Number.isFinite(patch.val) ? patch.val : currentVal;
    const targetFrame = Number.isFinite(patch.frame) ? Number(patch.frame.toFixed(3)) : kf.frame;

    if (Math.abs(targetFrame - kf.frame) > 1e-4) {
      // Move ONLY this channel's key to targetFrame cleanly
      this._clearChannelEntry(info, kf);
      if (this._isKeyframeEmpty(info, kf)) {
        info.list.splice(srcIdx, 1);
      }

      let destKf = info.list.find((k) => Math.abs(k.frame - targetFrame) < 1e-4);
      if (!destKf) {
        destKf = info.isBone
          ? (info.prop === 'rotation'
            ? { frame: targetFrame, interpolation: nextInterp, quaternion: null, euler: null }
            : { frame: targetFrame, interpolation: nextInterp, position: null })
          : { frame: targetFrame, interpolation: nextInterp, position: null, rotation: null, scale: null };
        info.list.push(destKf);
      }
      if (nextInterp) destKf.interpolation = nextInterp;
      this._assignChannelValue(info, destKf, nextVal);
      if (nextHandle.type !== 'auto_clamped' || patch.editedSide) {
        destKf.handles = destKf.handles || {};
        destKf.handles[info.channel] = nextHandle;
      }
      info.list.sort((a, b) => a.frame - b.frame);
      kf = destKf;
    } else {
      if (nextInterp) kf.interpolation = nextInterp;
      if (Number.isFinite(patch.val)) this._assignChannelValue(info, kf, nextVal);
      if (nextHandle.type === 'auto_clamped' && !patch.editedSide) {
        // Let auto solver recompute clean tangents if reset to auto_clamped
        delete kf.handles[info.channel];
        if (Object.keys(kf.handles).length === 0) delete kf.handles;
      } else {
        kf.handles[info.channel] = nextHandle;
      }
    }

    this.syncActiveActionFromTrack(object);
    this.evaluate(this.currentFrame);
    this.emit('tracksChanged', { reason: 'fcurveUpdated', object, channel: info.channel });
    return kf;
  }

  insertFCurveKeyframe(object, channel, frame, val, boneName = 'auto') {
    if (!object) return null;
    const track = this._ensureTrack(object);
    if (!track) return null;
    const [prop, axis] = String(channel || 'rotation.y').split('.');
    let info = this._resolveTrackChannelInfo(object, channel, boneName);
    if (!info) return null;

    if (info.isBone && !info.boneEntry) {
      this.insertBoneKeyframe(object, boneName, frame, [prop]);
      info = this._resolveTrackChannelInfo(object, channel, boneName);
    }

    const fNum = Number(Number(frame).toFixed(3));
    let kf = info.list.find((k) => Math.abs(k.frame - fNum) < 1e-4);
    if (!kf) {
      kf = info.isBone
        ? (prop === 'rotation'
          ? { frame: fNum, interpolation: this.defaultInterpolation, quaternion: null, euler: null }
          : { frame: fNum, interpolation: this.defaultInterpolation, position: null })
        : { frame: fNum, interpolation: this.defaultInterpolation, position: null, rotation: null, scale: null };
      info.list.push(kf);
    }
    this._assignChannelValue(info, kf, Number.isFinite(val) ? val : 0);
    info.list.sort((a, b) => a.frame - b.frame);
    this.syncActiveActionFromTrack(object);
    this.evaluate(this.currentFrame);
    this.emit('keyframeAdded', { object, track, frame: fNum, keyframe: kf });
    this.emit('tracksChanged', { reason: 'fcurveKeyframeAdded', object, channel: info.channel });
    return kf;
  }

  deleteFCurveKeyframe(object, channel, targetFrame, boneName = 'auto') {
    const info = this._resolveTrackChannelInfo(object, channel, boneName);
    if (!info) return false;
    const idx = info.list.findIndex((k) => Math.abs(k.frame - targetFrame) < 1e-4 && this._extractChannelValue(info, k) !== undefined);
    if (idx === -1) return false;
    const kf = info.list[idx];
    this._clearChannelEntry(info, kf);
    if (this._isKeyframeEmpty(info, kf)) {
      info.list.splice(idx, 1);
    }
    this.syncActiveActionFromTrack(object);
    this.evaluate(this.currentFrame);
    this.emit('keyframeRemoved', { object, frame: targetFrame });
    this.emit('tracksChanged', { reason: 'fcurveKeyframeRemoved', object, channel: info.channel });
    return true;
  }

  captureTrackSnapshot(object) {
    if (!object) return null;
    const track = this.tracks.get(object.uuid);
    if (!track) return { exists: false, uuid: object.uuid };
    const boneTracks = [];
    if (track.boneTracks) {
      for (const [bName, bData] of track.boneTracks.entries()) {
        boneTracks.push({
          boneName: bName,
          rotationTrack: (bData.rotationTrack || []).map(cloneBoneRotKeyframe),
          positionTrack: (bData.positionTrack || []).map(cloneBonePosKeyframe),
        });
      }
    }
    return {
      exists: true,
      uuid: object.uuid,
      name: track.name,
      defaultInterpolation: this.defaultInterpolation,
      keyframes: (track.keyframes || []).map(cloneObjectKeyframe),
      fcurveMeta: cloneFCurveMetaMap(track.fcurveMeta),
      boneTracks,
    };
  }

  restoreTrackSnapshot(object, snap) {
    if (!object || !snap) return false;
    if (!snap.exists) {
      this.tracks.delete(object.uuid);
    } else {
      const track = this._ensureTrack(object);
      track.name = snap.name || object.name;
      track.keyframes = (snap.keyframes || []).map(cloneObjectKeyframe).sort((a, b) => a.frame - b.frame);
      track.fcurveMeta = cloneFCurveMetaMap(snap.fcurveMeta);
      track.boneTracks = new Map();
      const allBones = this._extractBones(object);
      for (const bt of snap.boneTracks || []) {
        const bone = allBones.find((b) => b.name === bt.boneName || b.name.toLowerCase() === bt.boneName.toLowerCase()) || null;
        track.boneTracks.set(bt.boneName, {
          boneName: bt.boneName,
          bone,
          rotationTrack: (bt.rotationTrack || []).map(cloneBoneRotKeyframe),
          positionTrack: (bt.positionTrack || []).map(cloneBonePosKeyframe),
        });
      }
      if (snap.defaultInterpolation) this.defaultInterpolation = snap.defaultInterpolation;
    }
    this.syncActiveActionFromTrack(object);
    this.evaluate(this.currentFrame);
    this.emit('tracksChanged', { reason: 'fcurveSnapshotRestored', object });
    return true;
  }

  // =========================================================================
  // RENDER LOOP TICK
  // =========================================================================

  /**
   * Called every frame from Engine render loop
   * @param {number} delta Delta time in seconds
   */
  update(delta) {
    if (!this.isPlaying) return;
    if (!Number.isFinite(delta) || delta <= 0) return;

    const range = this.endFrame - this.startFrame;
    if (range <= 0) {
      this.currentFrame = this.startFrame;
      this.evaluate(this.currentFrame);
      if (!this.loop) this.pause();
      return;
    }

    // Advance frame time based on FPS
    const frameAdvance = delta * this.fps;
    let nextFrame = this.currentFrame + frameAdvance;

    if (nextFrame >= this.endFrame) {
      if (this.loop) {
        const overflow = nextFrame - this.endFrame;
        nextFrame = this.startFrame + (overflow % range);
      } else {
        nextFrame = this.endFrame;
        this.currentFrame = nextFrame;
        this.pause();
        this.evaluate(this.currentFrame);
        this.emit('frameChanged', {
          frame: Math.round(this.currentFrame),
          subframe: this.currentFrame,
          isPlaying: false
        });
        return;
      }
    }

    this.currentFrame = Math.max(this.startFrame, Math.min(this.endFrame, nextFrame));
    this.evaluate(this.currentFrame);

    this.emit('frameChanged', {
      frame: Math.round(this.currentFrame),
      subframe: this.currentFrame,
      isPlaying: true
    });
  }

  // =========================================================================
  // SERIALIZATION (Project Save & Load)
  // =========================================================================

  /**
   * Serializes animation data to a JSON-compatible object
   * @returns {Object}
   */
  toJSON() {
    const serializedTracks = [];
    for (const [uuid, track] of this.tracks.entries()) {
      const serializedBoneTracks = [];
      if (track.boneTracks) {
        for (const [bName, bData] of track.boneTracks.entries()) {
          serializedBoneTracks.push({
            boneName: bName,
            rotationTrack: (bData.rotationTrack || []).map(cloneBoneRotKeyframe),
            positionTrack: (bData.positionTrack || []).map(cloneBonePosKeyframe)
          });
        }
      }

      serializedTracks.push({
        uuid,
        name: track.name,
        keyframes: track.keyframes.map(cloneObjectKeyframe),
        fcurveMeta: cloneFCurveMetaMap(track.fcurveMeta),
        boneTracks: serializedBoneTracks
      });
    }

    return {
      fps: this.fps,
      startFrame: this.startFrame,
      endFrame: this.endFrame,
      defaultInterpolation: this.defaultInterpolation,
      loop: this.loop,
      tracks: serializedTracks,
      animationData: this.exportAnimationData(),
    };
  }

  /**
   * Deserializes animation data from JSON
   * @param {Object} data 
   */
  fromJSON(data) {
    if (!data) return;
    this.fps = data.fps || 30;
    this.startFrame = data.startFrame !== undefined ? data.startFrame : 0;
    this.endFrame = data.endFrame !== undefined ? data.endFrame : 250;
    this.defaultInterpolation = data.defaultInterpolation || 'smooth';
    this.loop = data.loop !== undefined ? data.loop : true;

    this.tracks.clear();

    const byKey = new Map();
    if (this.sceneManager?.traverseObjects) {
      this.sceneManager.traverseObjects((obj) => {
        byKey.set(obj.uuid, obj);
        if (obj.userData?.id) byKey.set(obj.userData.id, obj);
        if (obj.name && !byKey.has(`name:${obj.name}`)) byKey.set(`name:${obj.name}`, obj);
      });
    }

    if (Array.isArray(data.tracks) && this.sceneManager) {
      for (const t of data.tracks) {
        const foundObj = byKey.get(t.uuid) || byKey.get(`name:${t.name}`) || null;
        if (foundObj) {
          const track = {
            object: foundObj,
            uuid: foundObj.uuid,
            name: foundObj.name,
            keyframes: (t.keyframes || []).map(cloneObjectKeyframe),
            fcurveMeta: cloneFCurveMetaMap(t.fcurveMeta),
            boneTracks: new Map()
          };

          if (Array.isArray(t.boneTracks)) {
            const allBones = this._extractBones(foundObj);
            for (const bt of t.boneTracks) {
              const bone = allBones.find(b => b.name === bt.boneName || b.name.toLowerCase() === bt.boneName.toLowerCase());
              track.boneTracks.set(bt.boneName, {
                boneName: bt.boneName,
                bone: bone || null,
                rotationTrack: (bt.rotationTrack || []).map(cloneBoneRotKeyframe),
                positionTrack: (bt.positionTrack || []).map(cloneBonePosKeyframe)
              });
            }
          }

          this.tracks.set(foundObj.uuid, track);
        }
      }
    }

    if (data.animationData) {
      this.restoreAnimationData(data.animationData, (id, fallbackName) => byKey.get(id) || (fallbackName ? byKey.get(`name:${fallbackName}`) : null));
    }

    this.seekToFrame(this.startFrame);
    this.emit('tracksChanged', { reason: 'restoredFromJSON' });
  }

  // =========================================================================
  // WAVE 4B: ACTION EDITOR, NLA MIXER & SANDBOXED DRIVERS
  // =========================================================================

  _genActionId(name = 'Action') {
    const slug = String(name).replace(/[^A-Za-z0-9_]/g, '_').slice(0, 28) || 'Action';
    return `act_${slug}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`;
  }

  _serializeObjectTrackForAction(object) {
    const track = object ? this.tracks.get(object.uuid) : null;
    const boneTracks = [];
    if (track?.boneTracks) {
      for (const [bName, bData] of track.boneTracks.entries()) {
        boneTracks.push({
          boneName: bName,
          rotationTrack: (bData.rotationTrack || []).map(cloneBoneRotKeyframe),
          positionTrack: (bData.positionTrack || []).map(cloneBonePosKeyframe),
        });
      }
    }
    return {
      keyframes: (track?.keyframes || []).map(cloneObjectKeyframe),
      fcurveMeta: cloneFCurveMetaMap(track?.fcurveMeta),
      boneTracks,
    };
  }

  _applyActionToObjectTrack(object, action) {
    if (!object || !action) return;
    const track = this._ensureTrack(object);
    const cloned = cloneActionData(action);
    track.keyframes = cloned.keyframes;
    track.fcurveMeta = cloned.fcurveMeta;
    track.boneTracks = new Map();
    const allBones = this._extractBones(object);
    for (const bt of cloned.boneTracks) {
      const bone = allBones.find((b) => b.name === bt.boneName || b.name.toLowerCase() === bt.boneName.toLowerCase()) || null;
      track.boneTracks.set(bt.boneName, {
        boneName: bt.boneName,
        bone,
        rotationTrack: bt.rotationTrack,
        positionTrack: bt.positionTrack,
      });
    }
  }

  getAction(idOrName) {
    if (!idOrName) return null;
    if (this.actionsMap.has(idOrName)) return this.actionsMap.get(idOrName);
    for (const act of this.actionsMap.values()) {
      if (act.name === idOrName) return act;
    }
    return null;
  }

  getActiveAction(object) {
    if (!object) return null;
    const actId = this.activeActionByObject.get(object.uuid);
    return actId ? this.getAction(actId) : null;
  }

  syncActiveActionFromTrack(object) {
    if (!object) return null;
    const act = this.getActiveAction(object);
    if (!act) return null;
    const data = this._serializeObjectTrackForAction(object);
    act.keyframes = data.keyframes;
    act.fcurveMeta = data.fcurveMeta;
    act.boneTracks = data.boneTracks;
    const range = computeActionRange(act);
    act.rangeStart = range.start;
    act.rangeEnd = range.end;
    return act;
  }

  createAction(object = null, name = null, { cloneCurrent = true, fakeUser = false } = {}) {
    if (object) this.syncActiveActionFromTrack(object);
    const existingNames = new Set(Array.from(this.actionsMap.values()).map((a) => a.name));
    let finalName = name || `Action_${this.actionsMap.size + 1}`;
    let suffix = 1;
    while (existingNames.has(finalName)) {
      finalName = `${name || 'Action'}.${String(suffix++).padStart(3, '0')}`;
    }

    const baseData = (object && cloneCurrent)
      ? this._serializeObjectTrackForAction(object)
      : { keyframes: [], fcurveMeta: {}, boneTracks: [] };

    const action = cloneActionData({
      id: this._genActionId(finalName),
      name: finalName,
      fakeUser: !!fakeUser,
      ...baseData,
      createdAt: Date.now(),
    });
    const range = computeActionRange(action);
    action.rangeStart = range.start;
    action.rangeEnd = range.end;

    this.actionsMap.set(action.id, action);
    if (object) {
      if (!cloneCurrent) {
        this._applyActionToObjectTrack(object, action);
      }
      this.activeActionByObject.set(object.uuid, action.id);
    }
    this.emit('actionAdded', { name: action.name, action });
    this.emit('actionsChanged', { reason: 'created', action });
    this.emit('tracksChanged', { reason: 'actionCreated', object });
    return action;
  }

  assignAction(object, idOrName) {
    if (!object) return null;
    // Persist edits on previous active action before swapping
    this.syncActiveActionFromTrack(object);

    if (!idOrName) {
      this.activeActionByObject.delete(object.uuid);
      const track = this.tracks.get(object.uuid);
      if (track) {
        track.keyframes = [];
        track.boneTracks?.clear();
        track.fcurveMeta = {};
      }
      this.evaluate(this.currentFrame);
      this.emit('actionsChanged', { reason: 'unlinked', object });
      this.emit('tracksChanged', { reason: 'actionUnlinked', object });
      return null;
    }

    const action = this.getAction(idOrName);
    if (!action) return null;
    this._applyActionToObjectTrack(object, action);
    this.activeActionByObject.set(object.uuid, action.id);
    this.evaluate(this.currentFrame);
    this.emit('actionsChanged', { reason: 'assigned', action, object });
    this.emit('tracksChanged', { reason: 'actionAssigned', object });
    return action;
  }

  duplicateAction(idOrName, newName = null, object = null) {
    const src = this.getAction(idOrName);
    if (!src) return null;
    if (object && this.activeActionByObject.get(object.uuid) === src.id) {
      this.syncActiveActionFromTrack(object);
    }
    const baseName = newName || `${src.name}_Copy`;
    const clone = cloneActionData(src);
    clone.id = this._genActionId(baseName);
    clone.name = baseName;
    clone.createdAt = Date.now();
    this.actionsMap.set(clone.id, clone);
    if (object) {
      this._applyActionToObjectTrack(object, clone);
      this.activeActionByObject.set(object.uuid, clone.id);
    }
    this.emit('actionsChanged', { reason: 'duplicated', action: clone });
    this.emit('tracksChanged', { reason: 'actionDuplicated', object });
    return clone;
  }

  setActionFakeUser(idOrName, fakeUser) {
    const act = this.getAction(idOrName);
    if (!act) return false;
    act.fakeUser = !!fakeUser;
    this.emit('actionsChanged', { reason: 'fakeUser', action: act });
    return true;
  }

  deleteAction(idOrName) {
    const act = this.getAction(idOrName);
    if (!act) return false;
    this.actionsMap.delete(act.id);
    for (const [objUuid, activeId] of this.activeActionByObject.entries()) {
      if (activeId === act.id) this.activeActionByObject.delete(objUuid);
    }
    this.emit('actionsChanged', { reason: 'deleted', action: act });
    return true;
  }

  // Backward-compatible legacy alias
  addAction(name, actionData = null) {
    if (!this.actions) this.actions = new Map();
    const actionName = name || `Action_${this.actions.size + 1}`;
    const legacy = {
      name: actionName,
      data: actionData || this.toJSON(),
      createdAt: Date.now()
    };
    this.actions.set(actionName, legacy);
    if (!this.getAction(actionName)) {
      this.createAction(this.sceneManager?.getActiveObject?.() || null, actionName, { cloneCurrent: true, fakeUser: true });
    }
    this.emit('actionAdded', { name: actionName, action: legacy });
    return legacy;
  }

  getActions() {
    const list = Array.from(this.actionsMap.values());
    if (this.actions && this.actions.size > 0) {
      for (const a of this.actions.values()) {
        if (!list.some((x) => x.name === a.name)) list.push(a);
      }
    }
    return list;
  }

  // --- NLA Tracks & Strips API ---

  getNLATracks(object) {
    if (!object) return [];
    this._nlaObjectRefs.set(object.uuid, object);
    return this.nlaTracks.get(object.uuid) || [];
  }

  addNLATrack(object, name = null) {
    if (!object) return null;
    this._nlaObjectRefs.set(object.uuid, object);
    if (!this.nlaTracks.has(object.uuid)) this.nlaTracks.set(object.uuid, []);
    const list = this.nlaTracks.get(object.uuid);
    const nlaTrack = {
      id: `nlat_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      name: name || `NLATrack.${String(list.length + 1).padStart(3, '0')}`,
      muted: false,
      solo: false,
      strips: [],
    };
    list.push(nlaTrack);
    this.emit('nlaChanged', { reason: 'trackAdded', object, nlaTrack });
    return nlaTrack;
  }

  removeNLATrack(object, trackId) {
    if (!object || !this.nlaTracks.has(object.uuid)) return false;
    const list = this.nlaTracks.get(object.uuid);
    const idx = list.findIndex((t) => t.id === trackId);
    if (idx === -1) return false;
    list.splice(idx, 1);
    this.evaluate(this.currentFrame);
    this.emit('nlaChanged', { reason: 'trackRemoved', object, trackId });
    return true;
  }

  setNLATrackState(object, trackId, patch = {}) {
    const list = this.getNLATracks(object);
    const tr = list.find((t) => t.id === trackId);
    if (!tr) return false;
    if (patch.muted !== undefined) tr.muted = !!patch.muted;
    if (patch.solo !== undefined) tr.solo = !!patch.solo;
    if (patch.name !== undefined) tr.name = String(patch.name);
    this.evaluate(this.currentFrame);
    this.emit('nlaChanged', { reason: 'trackStateChanged', object, nlaTrack: tr });
    return true;
  }

  addNLAStrip(object, trackId, config = {}) {
    if (!object) return null;
    const list = this.getNLATracks(object);
    let tr = list.find((t) => t.id === trackId);
    if (!tr) tr = this.addNLATrack(object);

    const action = this.getAction(config.actionId);
    if (!action) return null;
    const aRange = computeActionRange(action);
    const actionStart = Number.isFinite(config.actionStart) ? config.actionStart : aRange.start;
    const actionEnd = Number.isFinite(config.actionEnd) ? config.actionEnd : aRange.end;
    const scale = Math.max(0.01, Number(config.scale) || 1);
    const repeat = Math.max(0.1, Number(config.repeat) || 1);
    const startFrame = Number.isFinite(config.startFrame) ? config.startFrame : actionStart;
    const defaultSpan = Math.max(1, actionEnd - actionStart) * scale * repeat;
    const endFrame = Number.isFinite(config.endFrame) ? Math.max(startFrame + 0.1, config.endFrame) : (startFrame + defaultSpan);

    const strip = {
      id: `strip_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      name: config.name || action.name,
      actionId: action.id,
      startFrame,
      endFrame,
      actionStart,
      actionEnd,
      scale,
      repeat,
      blendMode: ['replace', 'add', 'multiply'].includes(config.blendMode) ? config.blendMode : 'replace',
      influence: Number.isFinite(config.influence) ? Math.max(0, Math.min(1, config.influence)) : 1.0,
      extrapolate: ['nothing', 'hold', 'hold_forward'].includes(config.extrapolate) ? config.extrapolate : 'hold_forward',
    };
    tr.strips.push(strip);
    tr.strips.sort((a, b) => a.startFrame - b.startFrame);
    this.evaluate(this.currentFrame);
    this.emit('nlaChanged', { reason: 'stripAdded', object, nlaTrack: tr, strip });
    return strip;
  }

  updateNLAStrip(object, trackId, stripId, patch = {}) {
    const list = this.getNLATracks(object);
    const tr = list.find((t) => t.id === trackId);
    const strip = tr?.strips?.find((s) => s.id === stripId);
    if (!strip) return null;

    const action = this.getAction(strip.actionId);
    const aSpan = Math.max(1, (strip.actionEnd ?? 20) - (strip.actionStart ?? 0));

    if (patch.name !== undefined) strip.name = String(patch.name);
    if (patch.blendMode !== undefined && ['replace', 'add', 'multiply'].includes(patch.blendMode)) {
      strip.blendMode = patch.blendMode;
    }
    if (patch.influence !== undefined && Number.isFinite(Number(patch.influence))) {
      strip.influence = Math.max(0, Math.min(1, Number(patch.influence)));
    }
    if (patch.extrapolate !== undefined && ['nothing', 'hold', 'hold_forward'].includes(patch.extrapolate)) {
      strip.extrapolate = patch.extrapolate;
    }
    if (patch.scale !== undefined && Number.isFinite(Number(patch.scale))) {
      strip.scale = Math.max(0.01, Number(patch.scale));
      if (patch.endFrame === undefined) {
        strip.endFrame = strip.startFrame + aSpan * strip.scale * strip.repeat;
      }
    }
    if (patch.repeat !== undefined && Number.isFinite(Number(patch.repeat))) {
      strip.repeat = Math.max(0.1, Number(patch.repeat));
      if (patch.endFrame === undefined) {
        strip.endFrame = strip.startFrame + aSpan * strip.scale * strip.repeat;
      }
    }
    if (patch.startFrame !== undefined && Number.isFinite(Number(patch.startFrame))) {
      const oldSpan = Math.max(0.1, strip.endFrame - strip.startFrame);
      strip.startFrame = Number(patch.startFrame);
      if (patch.endFrame === undefined) strip.endFrame = strip.startFrame + oldSpan;
    }
    if (patch.endFrame !== undefined && Number.isFinite(Number(patch.endFrame))) {
      strip.endFrame = Math.max(strip.startFrame + 0.1, Number(patch.endFrame));
    }
    if (patch.actionId !== undefined && action?.id !== patch.actionId) {
      const nextAct = this.getAction(patch.actionId);
      if (nextAct) strip.actionId = nextAct.id;
    }

    tr.strips.sort((a, b) => a.startFrame - b.startFrame);
    this.evaluate(this.currentFrame);
    this.emit('nlaChanged', { reason: 'stripUpdated', object, nlaTrack: tr, strip });
    return strip;
  }

  removeNLAStrip(object, trackId, stripId) {
    const list = this.getNLATracks(object);
    const tr = list.find((t) => t.id === trackId);
    if (!tr) return false;
    const idx = tr.strips.findIndex((s) => s.id === stripId);
    if (idx === -1) return false;
    tr.strips.splice(idx, 1);
    this.evaluate(this.currentFrame);
    this.emit('nlaChanged', { reason: 'stripRemoved', object, trackId, stripId });
    return true;
  }

  pushActionToNLA(object, trackName = null) {
    if (!object) return null;
    let act = this.getActiveAction(object);
    if (act) {
      this.syncActiveActionFromTrack(object);
    } else {
      const track = this.tracks.get(object.uuid);
      const hasAny = (track?.keyframes?.length > 0) || (track?.boneTracks?.size > 0);
      if (!hasAny) return null;
      act = this.createAction(object, `${object.name || 'Obj'}_Action`, { cloneCurrent: true, fakeUser: true });
    }

    const nlaTrack = this.addNLATrack(object, trackName);
    const strip = this.addNLAStrip(object, nlaTrack.id, {
      actionId: act.id,
      startFrame: act.rangeStart,
      endFrame: act.rangeEnd,
      blendMode: 'replace',
      influence: 1.0,
      extrapolate: 'hold_forward',
    });

    // Clear active action slot from object so NLA strips drive cleanly without double application
    this.assignAction(object, null);
    this.evaluate(this.currentFrame);
    this.emit('nlaChanged', { reason: 'pushedDown', object, action: act, strip });
    return { action: act, track: nlaTrack, strip };
  }

  // --- Sandboxed Drivers API ---

  addDriver(config) {
    this.driverManager.sceneManager = this.sceneManager || this.driverManager.sceneManager;
    const rec = this.driverManager.addDriver(config);
    this.evaluate(this.currentFrame);
    this.emit('driversChanged', { reason: 'added', driver: rec });
    return rec;
  }

  updateDriver(id, patch) {
    const rec = this.driverManager.updateDriver(id, patch);
    if (rec) {
      this.evaluate(this.currentFrame);
      this.emit('driversChanged', { reason: 'updated', driver: rec });
    }
    return rec;
  }

  removeDriver(id) {
    const ok = this.driverManager.removeDriver(id);
    if (ok) {
      this.evaluate(this.currentFrame);
      this.emit('driversChanged', { reason: 'removed', id });
    }
    return ok;
  }

  getDrivers(object = null) {
    return object ? this.driverManager.getDriversForObject(object) : [...this.driverManager.drivers];
  }

  validateDriverExpression(expr) {
    compileDriverExpression(expr);
    return true;
  }

  // --- Complete Animation Bundle Serialization (Actions, NLA, Drivers) ---

  exportAnimationData() {
    for (const objUuid of this.activeActionByObject.keys()) {
      const tr = this.tracks.get(objUuid);
      if (tr?.object) this.syncActiveActionFromTrack(tr.object);
    }

    const actions = Array.from(this.actionsMap.values()).map((a) => cloneActionData(a));

    const activeActions = [];
    for (const [objUuid, actId] of this.activeActionByObject.entries()) {
      const obj = this.tracks.get(objUuid)?.object || this._nlaObjectRefs.get(objUuid) || null;
      activeActions.push({
        objectId: obj?.userData?.id || objUuid,
        objectName: obj?.name || null,
        actionId: actId,
      });
    }

    const nlaTracks = [];
    for (const [objUuid, tracks] of this.nlaTracks.entries()) {
      if (!tracks || tracks.length === 0) continue;
      const obj = this._nlaObjectRefs.get(objUuid) || this.tracks.get(objUuid)?.object || null;
      nlaTracks.push({
        objectId: obj?.userData?.id || objUuid,
        objectName: obj?.name || null,
        tracks: tracks.map((t) => ({
          id: t.id,
          name: t.name,
          muted: !!t.muted,
          solo: !!t.solo,
          strips: (t.strips || []).map((s) => ({ ...s })),
        })),
      });
    }

    return {
      actions,
      activeActions,
      nlaTracks,
      drivers: this.driverManager.toJSON(),
    };
  }

  restoreAnimationData(bundle, resolve = () => null) {
    if (!bundle || typeof bundle !== 'object') return false;

    this.actionsMap.clear();
    this.activeActionByObject.clear();
    this.nlaTracks.clear();
    this._nlaObjectRefs.clear();

    if (Array.isArray(bundle.actions)) {
      for (const a of bundle.actions) {
        if (!a || !a.id) continue;
        const cloned = cloneActionData(a);
        this.actionsMap.set(cloned.id, cloned);
      }
    }

    if (Array.isArray(bundle.activeActions)) {
      for (const entry of bundle.activeActions) {
        const obj = resolve(entry.objectId, entry.objectName);
        if (obj && entry.actionId && this.actionsMap.has(entry.actionId)) {
          this.activeActionByObject.set(obj.uuid, entry.actionId);
        }
      }
    }

    if (Array.isArray(bundle.nlaTracks)) {
      for (const entry of bundle.nlaTracks) {
        const obj = resolve(entry.objectId, entry.objectName);
        if (!obj) continue;
        this._nlaObjectRefs.set(obj.uuid, obj);
        this.nlaTracks.set(obj.uuid, (entry.tracks || []).map((t) => ({
          id: t.id,
          name: t.name,
          muted: !!t.muted,
          solo: !!t.solo,
          strips: (t.strips || []).map((s) => ({ ...s })),
        })));
      }
    }

    this.driverManager.sceneManager = this.sceneManager || this.driverManager.sceneManager;
    this.driverManager.fromJSON(bundle.drivers || [], resolve);

    this.evaluate(this.currentFrame);
    this.emit('actionsChanged', { reason: 'restored' });
    this.emit('nlaChanged', { reason: 'restored' });
    this.emit('driversChanged', { reason: 'restored' });
    return true;
  }
}
