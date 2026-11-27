import * as THREE from 'three';
import { clone, retargetClip } from '../../vendor/three/addons/utils/SkeletonUtils.js';
import { AgentError, assertArg } from './agent-core.js';

export function createAnimationTools(ctx) {
  const states = new Map();
  let unregister = null;

  function node(id) {
    const root = ctx.node(id);
    if (!root?.isObject3D) throw new AgentError('E_NOT_FOUND', `Animation root '${id}' not found`);
    return root;
  }

  function describe(root, id = ctx.ids.assign(root)) {
    return (root.animations || []).map((clip, index) => ({
      clipId: `clip_${id}_${index}`, name: clip.name, duration: clip.duration, tracks: clip.tracks.length
    }));
  }

  function findClip(root, id, reference) {
    assertArg(typeof reference === 'string' && reference.length > 0, 'Clip must be a clip ID or name');
    const clips = root.animations || [];
    const prefix = `clip_${root.userData?.agentId || id}_`;
    let index = clips.findIndex((_, i) => reference === `${prefix}${i}`);
    if (index < 0) {
      const matches = clips.map((clip, i) => clip.name === reference ? i : -1).filter(i => i >= 0);
      assertArg(matches.length <= 1, `Clip name '${reference}' is ambiguous; use a clip ID`);
      index = matches[0] ?? -1;
    }
    if (index < 0) throw new AgentError('E_NOT_FOUND', `Clip '${reference}' not found on '${id}'`);
    return { clip: clips[index], index };
  }

  function attached(state) {
    let top = state.root;
    while (top.parent) top = top.parent;
    return state.scene ? top === state.scene : !!state.root.parent || !!state.root.isScene;
  }

  function release(state) {
    state.mixer.stopAllAction();
    state.mixer.uncacheRoot(state.root);
    state.mixer.removeEventListener('finished', state.finished);
    state.actions.clear();
    state.listeners.clear();
    state.transition = null;
    states.delete(state.root);
    ctx.events?.emit('anim:detach', { id: state.id });
    if (!states.size && unregister) {
      unregister();
      unregister = null;
    }
  }

  function tick(delta) {
    const dt = Number.isFinite(delta) && delta >= 0 ? delta : 0;
    for (const state of [...states.values()]) {
      if (states.get(state.root) !== state) continue;
      if (!attached(state)) {
        release(state);
        continue;
      }
      if (state.transition && state.mixer.timeScale !== 0) {
        const transition = state.transition;
        transition.elapsed += dt * Math.abs(state.mixer.timeScale);
        const alpha = Math.min(1, transition.elapsed / transition.duration);
        for (const item of transition.items) {
          item.action.setEffectiveWeight(item.from + (item.to - item.from) * alpha);
          if (alpha === 1 && item.remove) {
            item.action.stop();
            state.actions.delete(item.clip);
          }
        }
        if (alpha === 1) state.transition = null;
      }
      state.mixer.update(dt);
    }
  }

  function stateFor(root) {
    const existing = states.get(root);
    if (existing) return existing;
    if (typeof ctx.engine?.addRenderCallback !== 'function') {
      throw new AgentError('E_UNSUPPORTED', 'The engine has no animation render callback');
    }
    let top = root;
    while (top.parent) top = top.parent;
    const state = {
      root, id: ctx.ids.assign(root), mixer: new THREE.AnimationMixer(root), actions: new Map(),
      listeners: new Set(), transition: null, pausedScale: null,
      scene: top.isScene ? top : ctx.engine.scene || ctx.sceneManager?.scene || null
    };
    state.finished = event => {
      const clip = event.action.getClip();
      const index = (root.animations || []).indexOf(clip);
      const data = { id: state.id, clipId: index < 0 ? null : `clip_${state.id}_${index}`, name: clip.name, direction: event.direction };
      ctx.events?.emit('anim:end', data);
      for (const callback of [...state.listeners]) {
        try { callback(data); } catch (error) {
          ctx.log?.push({ level: 'error', source: 'anim', message: error.message || String(error) });
        }
      }
    };
    state.mixer.addEventListener('finished', state.finished);
    states.set(root, state);
    if (!unregister) {
      try {
        unregister = ctx.engine.addRenderCallback(tick);
      } catch (error) {
        release(state);
        throw error;
      }
    }
    return state;
  }

  function resume(state) {
    if (state.pausedScale !== null) {
      state.mixer.timeScale = state.pausedScale;
      state.pausedScale = null;
    }
  }

  function transitionTo(state, targets, duration) {
    const items = [];
    for (const [clip, action] of state.actions) {
      const to = targets.get(clip) ?? 0;
      const remove = !targets.has(clip);
      const from = action.getEffectiveWeight();
      action.stopFading();
      if (duration > 0) items.push({ clip, action, from, to, remove });
      else {
        action.setEffectiveWeight(to);
        if (remove) {
          action.stop();
          state.actions.delete(clip);
        }
      }
    }
    state.transition = duration > 0 ? { items, duration, elapsed: 0 } : null;
  }

  function finite(value, name, min = 0, max = Infinity) {
    assertArg(typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max,
      `${name} must be a finite number between ${min} and ${max}`);
  }

  function rig(root) {
    const nodes = new Set();
    const bones = [];
    const skeletons = [];
    root.traverse(object => {
      nodes.add(object);
      if (object.isBone) bones.push(object);
      if (object.skeleton?.bones && !skeletons.includes(object.skeleton)) skeletons.push(object.skeleton);
    });
    const skeleton = skeletons[0];
    if (skeletons.some(other => other.bones.length !== skeleton.bones.length || other.bones.some((bone, i) => bone !== skeleton.bones[i]))) {
      return { limitation: 'Multiple independent skeletons per root are not supported.' };
    }
    const ordered = skeleton ? skeleton.bones : bones;
    if (!ordered.length) return { limitation: 'Both roots must contain a skeleton or a named bone hierarchy.' };
    if (ordered.some(bone => !nodes.has(bone))) return { limitation: 'All skeleton bones must be descendants of the supplied root.' };
    const names = new Set();
    for (const bone of ordered) {
      if (!bone.name || names.has(bone.name) || /[\s.\[\]:/]/.test(bone.name)) {
        return { limitation: 'Bone names must be unique, non-empty and compatible with Three.js named track bindings.' };
      }
      names.add(bone.name);
    }
    return { bones: ordered, names, skeleton };
  }

  function cloneRig(root, info) {
    const copy = clone(root);
    const lookup = new Map();
    const pair = (original, duplicate) => {
      lookup.set(original, duplicate);
      original.children.forEach((child, i) => pair(child, duplicate.children[i]));
    };
    pair(root, copy);
    copy.updateMatrixWorld(true);
    const bones = info.bones.map(bone => lookup.get(bone));
    copy.skeleton = new THREE.Skeleton(bones, info.skeleton?.boneInverses.map(matrix => matrix.clone()));
    return copy;
  }

  return {
    clips(id) {
      return describe(node(id));
    },

    play(id, reference, { loop = true, speed = 1, weight = 1, fadeIn = 0 } = {}) {
      assertArg(typeof loop === 'boolean', 'loop must be a boolean');
      finite(speed, 'speed');
      assertArg(speed > 0, 'speed must be positive; use pause() to pause playback');
      finite(weight, 'weight', 0, 1);
      finite(fadeIn, 'fadeIn');
      const root = node(id);
      const { clip, index } = findClip(root, id, reference);
      const state = stateFor(root);
      resume(state);
      const action = state.mixer.clipAction(clip);
      action.reset().setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1);
      action.clampWhenFinished = !loop;
      action.setEffectiveTimeScale(speed).setEffectiveWeight(fadeIn > 0 ? 0 : weight).play();
      state.actions.set(clip, action);
      transitionTo(state, new Map([[clip, weight]]), fadeIn);
      const data = { id: state.id, clipId: `clip_${state.id}_${index}`, loop, speed, weight, fadeIn };
      ctx.events?.emit('anim:play', data);
      return data;
    },

    stop(id) {
      const root = node(id);
      const state = states.get(root);
      if (state) {
        state.mixer.stopAllAction();
        state.actions.clear();
        state.transition = null;
        resume(state);
      }
      ctx.events?.emit('anim:stop', { id });
      return { id, stopped: true };
    },

    pause(id) {
      const state = states.get(node(id));
      if (state && state.pausedScale === null) {
        state.pausedScale = state.mixer.timeScale;
        state.mixer.timeScale = 0;
      }
      ctx.events?.emit('anim:pause', { id });
      return { id, paused: !!state };
    },

    seek(id, t) {
      finite(t, 'time');
      const state = states.get(node(id));
      if (!state) throw new AgentError('E_NOT_FOUND', `No animation mixer exists for '${id}'`, 'Play a clip first.');
      state.mixer.time = t;
      for (const [clip, action] of state.actions) {
        const duration = clip.duration;
        action.time = action.loop === THREE.LoopOnce ? Math.min(t, duration) : duration > 0 ? t % duration : 0;
        action.enabled = true;
      }
      state.mixer.update(0);
      ctx.events?.emit('anim:seek', { id, time: t });
      return { id, time: t };
    },

    blend(id, entries, { duration = 0 } = {}) {
      finite(duration, 'duration');
      assertArg(Array.isArray(entries) && entries.length > 0, 'blend needs at least one clip');
      const root = node(id);
      const resolved = entries.map(entry => {
        assertArg(entry && typeof entry === 'object', 'Each blend entry must contain clipId and weight');
        finite(entry.weight, 'weight', 0, 1);
        return { ...findClip(root, id, entry.clipId), weight: entry.weight };
      });
      assertArg(new Set(resolved.map(entry => entry.clip)).size === resolved.length, 'Blend clips must be unique');
      const state = stateFor(root);
      resume(state);
      const targets = new Map();
      for (const { clip, weight } of resolved) {
        let action = state.actions.get(clip);
        if (!action) {
          action = state.mixer.clipAction(clip).reset().setLoop(THREE.LoopRepeat, Infinity);
          action.clampWhenFinished = false;
          action.setEffectiveWeight(0).play();
          state.actions.set(clip, action);
        }
        action.enabled = true;
        action.paused = false;
        targets.set(clip, weight);
      }
      transitionTo(state, targets, duration);
      const data = { id: state.id, clips: resolved.map(entry => ({ clipId: `clip_${state.id}_${entry.index}`, weight: entry.weight })), duration };
      ctx.events?.emit('anim:blend', data);
      return data;
    },

    mixer(id) {
      return stateFor(node(id)).mixer;
    },

    onEnd(id, callback) {
      assertArg(typeof callback === 'function', 'onEnd requires a callback');
      const state = stateFor(node(id));
      const listener = data => callback(data);
      state.listeners.add(listener);
      return () => state.listeners.delete(listener);
    },

    retarget(sourceId, targetId, mapping = {}) {
      const source = node(sourceId);
      const target = node(targetId);
      if (!(source.animations || []).length) throw new AgentError('E_NOT_FOUND', `No clips exist on '${sourceId}'`);
      assertArg(source !== target, 'Source and target must be different roots');
      assertArg(mapping && typeof mapping === 'object' && !Array.isArray(mapping), 'mapping must be a source-name to target-name object');
      const unsupported = message => ({
        sourceId, targetId, supported: false, retargeted: false, clips: [], limitations: [message], code: 'E_UNSUPPORTED'
      });
      const sourceRig = rig(source);
      const targetRig = rig(target);
      if (sourceRig.limitation || targetRig.limitation) return unsupported(sourceRig.limitation || targetRig.limitation);
      const pairs = Object.entries(mapping);
      for (const [from, to] of pairs) {
        assertArg(typeof to === 'string' && sourceRig.names.has(from) && targetRig.names.has(to), `Invalid bone mapping '${from}' -> '${to}'`);
      }
      assertArg(new Set(pairs.map(([, to]) => to)).size === pairs.length, 'Each target bone may only have one source bone');
      if (!pairs.length) {
        for (const name of sourceRig.names) if (targetRig.names.has(name)) pairs.push([name, name]);
      }
      if (!pairs.length) return unsupported('No matching named bones were found; provide a source-to-target mapping.');
      const names = Object.create(null);
      targetRig.bones.forEach((bone, i) => { names[bone.name] = `__agent_unmapped_${i}__`; });
      pairs.forEach(([from, to]) => { names[to] = from; });
      for (const clip of source.animations) {
        if (!Number.isFinite(clip.duration) || clip.duration < 1 / 30 || !clip.tracks.length) {
          return unsupported(`Clip '${clip.name}' must have tracks and at least one frame at 30 fps.`);
        }
        for (const track of clip.tracks) {
          let binding;
          try { binding = THREE.PropertyBinding.parseTrackName(track.name); } catch (_) {
            return unsupported(`Clip '${clip.name}' has an unsupported track binding.`);
          }
          const boneName = binding.objectName === 'bones' ? binding.objectIndex : binding.nodeName;
          if (!sourceRig.names.has(boneName) || !['position', 'quaternion'].includes(binding.propertyName) ||
              (binding.objectName && binding.objectName !== 'bones') || binding.propertyIndex !== undefined) {
            return unsupported(`Clip '${clip.name}' is not a named-bone position/quaternion animation; scale, morph, UUID and mesh tracks are not retargeted.`);
          }
        }
      }
      const hip = pairs.find(([from]) => /^(hip|hips|pelvis)$/i.test(from))?.[0] ||
        pairs.find(([from]) => !sourceRig.bones.find(bone => bone.name === from).parent?.isBone)?.[0] || pairs[0][0];
      const converted = [];
      try {
        for (const clip of source.animations) {
          const sourceCopy = cloneRig(source, sourceRig);
          const targetCopy = cloneRig(target, targetRig);
          const result = retargetClip(targetCopy, sourceCopy, clip, { names: { ...names }, hip, fps: 30 });
          if (!result.tracks.length) return unsupported(`Clip '${clip.name}' produced no retargeted tracks.`);
          result.tracks.forEach(track => {
            track.name = track.name.replace(/^\.bones\[([^\]]+)\]/, '$1');
          });
          converted.push(result);
        }
      } catch (error) {
        return unsupported(`SkeletonUtils r160 could not retarget this rig: ${error.message || String(error)}`);
      }
      const start = (target.animations || []).length;
      target.animations = [...(target.animations || []), ...converted];
      const id = ctx.ids.assign(target);
      const data = {
        sourceId, targetId: id, supported: true, retargeted: true, clips: describe(target, id).slice(start),
        limitations: ['Sampled at 30 fps using SkeletonUtils r160; the final sample precedes the original clip endpoint.',
          'Only mapped bone rotations and hip translation are transferred; scale, morphs, IK and constraints are not transferred.']
      };
      ctx.events?.emit('anim:retarget', data);
      return data;
    }
  };
}
