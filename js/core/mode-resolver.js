/**
 * @file mode-resolver.js
 * @description Resolves editable Mesh and Rig/Armature targets from any active
 * selection (including Groups, Characters, imported GLB/FBX/OBJ models, Prefabs,
 * and Bones) and coordinates switching across Object, Edit, Sculpt, Paint,
 * Weight Paint, Edit Bone, and Pose modes.
 */

export function isEditableMesh(obj) {
  return Boolean(
    obj &&
    obj.isMesh &&
    !obj.userData?.isHelper &&
    !obj.userData?.isSystemObject &&
    obj.geometry?.attributes?.position
  );
}

export function isDescendantOf(node, ancestor) {
  if (!node || !ancestor) return false;
  let cur = node;
  while (cur) {
    if (cur === ancestor) return true;
    cur = cur.parent;
  }
  return false;
}

function getActiveSelectionCandidate(target = null, sceneManager = null) {
  if (target) return target;
  const active = sceneManager?.getActiveObject?.();
  if (active) return active;
  const selected = sceneManager?.getSelectedObjects?.();
  if (Array.isArray(selected) && selected.length > 0) {
    return selected[selected.length - 1];
  }
  return null;
}

function findCharacterOrArmatureRoot(obj, sceneManager = null) {
  if (!obj) return null;
  const rootContainer = sceneManager?.rootContainer || null;
  let cur = obj;
  let topNonScene = obj;
  while (cur && cur.parent && !cur.parent.isScene && cur.parent !== rootContainer) {
    if (cur.userData?.isCharacter || cur.userData?.isArmature || cur.userData?.skeleton) {
      return cur;
    }
    cur = cur.parent;
    topNonScene = cur;
  }
  return cur || topNonScene;
}

function pickBestMeshInHierarchy(root) {
  if (!root) return null;
  if (isEditableMesh(root)) return root;

  const preferred = root.userData?._lastClickedMesh;
  if (isEditableMesh(preferred) && isDescendantOf(preferred, root) && preferred.visible !== false) {
    return preferred;
  }

  const visibleMeshes = [];
  const allMeshes = [];
  if (typeof root.traverse === 'function') {
    root.traverse((child) => {
      if (!isEditableMesh(child)) return;
      allMeshes.push(child);
      if (child.visible !== false) visibleMeshes.push(child);
    });
  }

  const pool = visibleMeshes.length > 0 ? visibleMeshes : allMeshes;
  if (pool.length === 0) return null;
  if (pool.length === 1) return pool[0];

  let best = pool[0];
  let bestScore = -1;
  for (const m of pool) {
    const vertCount = m.geometry?.attributes?.position?.count || 0;
    const score = vertCount + (m.isSkinnedMesh ? 1_000_000 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = m;
    }
  }
  return best;
}

/**
 * Resolves a valid THREE.Mesh from the current selection.
 * Supports direct Mesh/SkinnedMesh objects as well as Groups, imported models,
 * characters, prefabs, and Bones belonging to a skinned character.
 */
export function resolveEditableMesh(target = null, sceneManager = null) {
  const candidate = getActiveSelectionCandidate(target, sceneManager);
  if (!candidate) return null;
  if (isEditableMesh(candidate)) return candidate;

  if (candidate.isBone) {
    const root = findCharacterOrArmatureRoot(candidate, sceneManager);
    const mesh = pickBestMeshInHierarchy(root);
    if (mesh) return mesh;
  }

  return pickBestMeshInHierarchy(candidate);
}

/**
 * Resolves skeleton and skinned mesh information from the current selection
 * for Weight Paint, Edit Bone, and Pose modes.
 */
export function resolveRigTarget(target = null, sceneManager = null, rigSystem = null) {
  const candidate = getActiveSelectionCandidate(target, sceneManager);
  if (!candidate) {
    return { hasSkeleton: false, hasSkinnedMesh: false, target: null, skinnedMesh: null, skeleton: null };
  }

  const searchRoot = (candidate.isBone || candidate.isSkinnedMesh)
    ? (findCharacterOrArmatureRoot(candidate, sceneManager) || candidate)
    : candidate;

  let skeleton = null;
  let skinnedMesh = null;

  const inspect = (obj) => {
    if (!obj || obj.userData?.isHelper || obj.userData?.isSystemObject) return;
    if (!skinnedMesh && obj.isSkinnedMesh) skinnedMesh = obj;
    if (!skeleton) {
      if (obj.isSkeleton) skeleton = obj;
      else if (obj.skeleton) skeleton = obj.skeleton;
      else if (obj.userData?.skeleton) skeleton = obj.userData.skeleton;
    }
  };

  inspect(candidate);
  inspect(searchRoot);
  if (typeof searchRoot.traverse === 'function') {
    searchRoot.traverse(inspect);
  }

  // Prefer active skinned mesh when candidate itself is one
  if (candidate.isSkinnedMesh) skinnedMesh = candidate;
  if (!skeleton && skinnedMesh?.skeleton) skeleton = skinnedMesh.skeleton;
  if (!skeleton && rigSystem && (rigSystem.activeCharacter === searchRoot || rigSystem.activeCharacter === candidate)) {
    skeleton = rigSystem.activeSkeleton || null;
  }

  return {
    hasSkeleton: Boolean(skeleton),
    hasSkinnedMesh: Boolean(skinnedMesh),
    target: searchRoot,
    skinnedMesh,
    skeleton,
  };
}

/**
 * Keeps `#viewport-mode` options visibility synchronized with the active object
 * and current mode so rig modes (Weight Paint, Edit Bone, Pose Mode) appear
 * whenever a character/armature is selected.
 */
export function syncViewportModeOptions(active = null, sceneManager = null, rigSystem = null) {
  if (typeof document === 'undefined') return;
  const sel = document.getElementById('viewport-mode');
  if (!sel) return;

  const rigInfo = resolveRigTarget(active, sceneManager, rigSystem);
  const setOptHidden = (val, hidden) => {
    const opt = sel.querySelector(`option[value="${val}"]`);
    if (opt) opt.hidden = Boolean(hidden);
  };

  setOptHidden('weight-paint', !(rigInfo.hasSkinnedMesh || rigSystem?.isWeightPaintMode || sel.value === 'weight-paint'));
  setOptHidden('edit-bone', !(rigInfo.hasSkeleton || rigSystem?.isEditBoneMode || sel.value === 'edit-bone'));
  setOptHidden('pose', !(rigInfo.hasSkeleton || rigSystem?.isPoseMode || sel.value === 'pose'));
}

/**
 * Unified mode switcher for `#viewport-mode` and programmatic mode switches.
 */
export function switchViewportMode(mode, {
  engine = null,
  sceneManager = null,
  editMode = null,
  sculptMode = null,
  paintMode = null,
  rigSystem = null,
  notify = null,
} = {}) {
  const modeSelect = typeof document !== 'undefined' ? document.getElementById('viewport-mode') : null;
  const active = getActiveSelectionCandidate(null, sceneManager);
  const emitNotify = (msg, type = 'warning') => {
    if (typeof notify === 'function') notify(msg, type);
    else console.warn(msg);
  };
  const revertToObject = () => {
    if (modeSelect) modeSelect.value = 'object';
    syncViewportModeOptions(active, sceneManager, rigSystem);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('blender:mode-changed', { detail: { mode: 'object' } }));
    }
  };

  // Exit any other active mode first
  if (mode !== 'edit' && editMode?.isActive) editMode.exit();
  if (mode !== 'sculpt' && sculptMode?.isActive) sculptMode.exit();
  if (mode !== 'vertex-paint' && mode !== 'texture-paint' && paintMode?.isActive) paintMode.exit();
  if (mode !== 'weight-paint' && rigSystem?.isWeightPaintMode) rigSystem.disableWeightPaintMode();
  if (mode !== 'edit-bone' && rigSystem?.isEditBoneMode) rigSystem.exitEditBoneMode();
  if (mode !== 'pose' && mode !== 'weight-paint' && mode !== 'edit-bone' && rigSystem?.isPoseMode) {
    rigSystem.setPoseMode(false);
  }

  let ok = true;

  if (mode === 'object') {
    if (modeSelect) modeSelect.value = 'object';
    if (active) {
      engine?.updateActiveGizmo?.(active);
      engine?.updateSelectionHelper?.();
    }
  } else if (mode === 'edit') {
    const mesh = resolveEditableMesh(active, sceneManager);
    if (mesh && editMode?.enter(mesh)) {
      ok = true;
    } else {
      const rigInfo = resolveRigTarget(active, sceneManager, rigSystem);
      if (rigSystem && rigInfo.hasSkeleton && rigSystem.enterEditBoneMode(rigInfo.target)) {
        ok = true;
      } else {
        emitNotify('Please select a Mesh or Armature object in the scene before switching to Edit Mode.', 'warning');
        revertToObject();
        ok = false;
      }
    }
  } else if (mode === 'sculpt') {
    const mesh = resolveEditableMesh(active, sceneManager);
    if (mesh && sculptMode?.enter(mesh)) {
      ok = true;
    } else {
      emitNotify('Please select a Mesh object in the scene (e.g., Head Bust, Sphere, or Character) before switching to Sculpt Mode.', 'warning');
      revertToObject();
      ok = false;
    }
  } else if (mode === 'vertex-paint' || mode === 'texture-paint') {
    const mesh = resolveEditableMesh(active, sceneManager);
    if (mesh && paintMode?.enter(mesh, mode)) {
      ok = true;
    } else {
      emitNotify('Please select a Mesh object before switching to Paint Mode.', 'warning');
      revertToObject();
      ok = false;
    }
  } else if (mode === 'weight-paint') {
    const rigInfo = resolveRigTarget(active, sceneManager, rigSystem);
    if (rigSystem && rigInfo.hasSkinnedMesh && rigSystem.enableWeightPaintMode(rigInfo.target || rigInfo.skinnedMesh, rigSystem.activeBone)) {
      if (modeSelect) modeSelect.value = 'weight-paint';
      ok = true;
    } else {
      emitNotify('Please select a rigged/skinned Character mesh before switching to Weight Paint.', 'warning');
      revertToObject();
      ok = false;
    }
  } else if (mode === 'edit-bone') {
    const rigInfo = resolveRigTarget(active, sceneManager, rigSystem);
    if (rigSystem && rigInfo.hasSkeleton && rigSystem.enterEditBoneMode(rigInfo.target)) {
      if (modeSelect) modeSelect.value = 'edit-bone';
      ok = true;
    } else {
      emitNotify('Please select an Armature or rigged Character before switching to Edit Bone Mode.', 'warning');
      revertToObject();
      ok = false;
    }
  } else if (mode === 'pose') {
    const rigInfo = resolveRigTarget(active, sceneManager, rigSystem);
    if (rigSystem && rigInfo.hasSkeleton) {
      if (!rigSystem.skeletonHelper || rigSystem.activeSkeleton !== rigInfo.skeleton) {
        rigSystem.createSkeletonVisualizer(rigInfo.skeleton, rigInfo.target);
      }
      rigSystem.activeSkeleton = rigInfo.skeleton;
      rigSystem.setPoseMode(true, rigInfo.target);
      if (modeSelect) modeSelect.value = 'pose';
      ok = true;
    } else {
      emitNotify('Please select an Armature or rigged Character before switching to Pose Mode.', 'warning');
      revertToObject();
      ok = false;
    }
  }

  syncViewportModeOptions(active, sceneManager, rigSystem);
  return ok;
}
