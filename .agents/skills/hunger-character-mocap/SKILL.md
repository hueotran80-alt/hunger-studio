---
name: hunger-character-mocap
description: Import, rig, skin, retarget mocap, pose, and export animated GLB characters cleanly inside Hunger 3D Studio without breaking skeleton bindings or animation tracks.
---

# Hunger Character, Rigging & Mocap

Use this skill whenever loading rigged characters, authoring skeletal rigs, applying poses or IK, running browser-native Video-to-3D Mocap retargeting, or exporting animated `.glb` characters in **Hunger 3D Studio**.

## 1. Built-In CC0 Characters & Supported Rig Standards
- **Shipped CC0-1.0 Commercial Rigs:** `/models/Bot_CC0.glb` (clips: `Walk`, `TPose`, etc.) and `/models/Mannequin_CC0.glb` (1.66 m native height, `Idle`, `TPose`).
- **Auto-Mapped Skeleton Standards:**
  - **Mixamo** (`mixamorig*`, 20/20 bones)
  - **VRM / VRoid** (`J_Bip_*`, 18/18 bones)
  - **Character Creator** (`CC_Base_*`, 18/18 bones)
  - **Hunger Procedural Humanoid** (`studio.createHumanoidArmature`, `studio.createRiggedMannequin`, `studio.createArticulatedActor`)

## 2. Core Character & Animation APIs
- **Load & Play Rigged Character (async — ALWAYS `await`):**
  ```js
  const actor = await studio.loadHumanWithAnimation({
    animation: 'Walk',     // 'Walk' | 'Run' | 'Idle' | 'TPose'
    showSkeleton: true,
    keepScene: true,       // omit or false to clear scene first; true to keep existing scene!
    x: 0, y: 0, z: 0,
  });
  ```
- **Switch Clips / Articulated Rig / Pose & IK:**
  - `studio.playCharacterAnimation(model, 'Idle')` (registers `AnimationMixer` cleanly on the engine render loop)
  - `studio.createArticulatedActor({ name, x, y, z, rotY, shirtColor, pantsColor, hasJacketLayer })` (returns `{ root, torsoPivot, neckPivot, headGroup, leftArm, rightArm, jacketGroup }`)
  - `await studio.createHumanoidArmature({ height: 1.8 })`, `await studio.createRiggedMannequin({ height: 1.8, skinned: true })`
  - `studio.autoSkinMesh(mesh, armature)`, `studio.setPose(target, poseKey)`, `studio.mirrorPose(target)`, `studio.setIKEnabled(true, target)`, `studio.applyMotionPreset(target, 'walk_cycle'|'combat_slash'|'wave_hand')`
  - `studio.keyframePose(target, 'all', { frame })`, `studio.bakeRig(options)`
- **Browser-Native Video-to-3D Mocap Pipeline:**
  - Runs 100% client-side via MediaPipe `PoseLandmarker` WASM + WebCodecs `VideoDecoder` (sequential decode + portrait `tkhd` rotation handling) -> `MocapFilters` (1-Euro smoothing, gap fill, bone-length clamp, root trajectory, **Foot-Lock IK** reducing foot sliding to `~0.000 m`) -> `MocapRetargeter` -> `TimelineEngine.attachClip()`.

## 3. Skeleton Integrity & Export Invariants
1. **NEVER Rename Bound Bones:** Renaming skeleton bones after `AnimationClip` binding breaks `THREE.PropertyBinding` track resolution during playback, timeline scrubbing, and glTF export.
2. **Height Normalization:** When mixing external `.glb` characters (e.g., cm vs m rigs), measure `new THREE.Box3().setFromObject(model)` and scale uniformly to target meter height (`~1.65 – 1.80 m`) so shadow frustums and camera framing remain tight.
3. **Clone Safety:** Duplicate skinned characters via `SkeletonUtils.clone` (handled automatically by `SceneManager.duplicateObject`) — raw `Object3D.clone()` binds the copy to the original skeleton!
4. **Animated GLB Export:** `exportGLTF` automatically collects attached clips, drops zero-keyframe/empty clips, and prunes orphaned tracks outside the export subtree.

## 4. Verification Gate
- Confirm skeleton bone count (`>= 18` for humanoids), valid `skinIndex` / `skinWeight` attributes, and measurable bone transform delta after advancing animation time (`>= 500 ms`).
- Re-import exported animated `.glb` via `GLTFLoader` (and headless Godot/Blender check when shipping to external game engines) and confirm duration, track count, and zero console errors.
