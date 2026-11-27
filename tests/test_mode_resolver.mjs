import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  isEditableMesh,
  isDescendantOf,
  resolveEditableMesh,
  resolveRigTarget,
  syncViewportModeOptions,
  switchViewportMode,
} from '../js/core/mode-resolver.js';

function makeBoxMesh(name, w = 1) {
  const geom = new THREE.BoxGeometry(w, w, w);
  const mesh = new THREE.Mesh(geom, new THREE.MeshStandardMaterial());
  mesh.name = name;
  return mesh;
}

function makeSkinnedCharacter(name = 'Hero') {
  const group = new THREE.Group();
  group.name = name;
  group.userData.isCharacter = true;

  const rootBone = new THREE.Bone();
  rootBone.name = 'RootBone';
  const childBone = new THREE.Bone();
  childBone.name = 'SpineBone';
  childBone.position.set(0, 1, 0);
  rootBone.add(childBone);
  const skeleton = new THREE.Skeleton([rootBone, childBone]);

  const geom = new THREE.BoxGeometry(1, 2, 1);
  const posCount = geom.attributes.position.count;
  const skinIdx = new Uint16Array(posCount * 4);
  const skinW = new Float32Array(posCount * 4);
  for (let i = 0; i < posCount; i++) skinW[i * 4] = 1;
  geom.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIdx, 4));
  geom.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinW, 4));

  const skinned = new THREE.SkinnedMesh(geom, new THREE.MeshStandardMaterial());
  skinned.name = `${name}_Body`;
  skinned.add(rootBone);
  skinned.bind(skeleton);

  const propMesh = makeBoxMesh(`${name}_Helmet`, 0.3);
  group.add(skinned, propMesh);
  group.userData.skeleton = skeleton;
  return { group, skinned, propMesh, rootBone, childBone, skeleton };
}

function setupMockDOM() {
  const optionNames = [
    'object', 'edit', 'sculpt', 'vertex-paint', 'texture-paint',
    'weight-paint', 'edit-bone', 'pose'
  ];
  const options = new Map(optionNames.map((value) => [
    value,
    {
      value,
      hidden: value === 'weight-paint' || value === 'edit-bone' || value === 'pose'
    }
  ]));
  const modeSelect = {
    value: 'object',
    querySelector(selector) {
      const m = /option\[value="([^"]+)"\]/.exec(selector);
      return m ? (options.get(m[1]) || null) : null;
    }
  };
  const events = [];
  globalThis.document = {
    getElementById(id) {
      return id === 'viewport-mode' ? modeSelect : null;
    }
  };
  globalThis.CustomEvent = class CustomEvent {
    constructor(type, init = {}) {
      this.type = type;
      this.detail = init.detail;
    }
  };
  globalThis.window = {
    dispatchEvent(evt) {
      events.push(evt);
    }
  };
  return { modeSelect, options, events };
}

// 1. Direct meshes & helpers
{
  const cube = makeBoxMesh('Cube');
  assert.equal(isEditableMesh(cube), true);
  assert.equal(resolveEditableMesh(cube), cube);

  const helper = makeBoxMesh('GizmoHelper');
  helper.userData.isHelper = true;
  assert.equal(isEditableMesh(helper), false);
  assert.equal(resolveEditableMesh(helper), null);

  const light = new THREE.DirectionalLight(0xffffff, 1);
  assert.equal(resolveEditableMesh(light), null);
  assert.equal(resolveEditableMesh(null), null);
}

// 2. Group resolution, SkinnedMesh priority, _lastClickedMesh preference & hierarchy checks
{
  const root = new THREE.Group();
  root.name = 'ImportedGLB';
  const lowPoly = makeBoxMesh('SmallPart', 1);
  const sphere = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 16), new THREE.MeshStandardMaterial());
  sphere.name = 'MainBody';
  root.add(lowPoly, sphere);

  assert.equal(isDescendantOf(sphere, root), true);
  assert.equal(isDescendantOf(root, sphere), false);

  // Without _lastClickedMesh, picks the highest-vertex visible mesh (sphere)
  assert.equal(resolveEditableMesh(root), sphere);

  // Respects valid visible descendant _lastClickedMesh
  root.userData._lastClickedMesh = lowPoly;
  assert.equal(resolveEditableMesh(root), lowPoly);

  // Ignores _lastClickedMesh if hidden or outside root
  lowPoly.visible = false;
  assert.equal(resolveEditableMesh(root), sphere);

  const alien = makeBoxMesh('Alien');
  root.userData._lastClickedMesh = alien;
  assert.equal(resolveEditableMesh(root), sphere);
}

// 3. Character Group & Bone resolution + Armature-only resolution
{
  const { group, skinned, propMesh, childBone, skeleton } = makeSkinnedCharacter('Soldier');
  const rootContainer = new THREE.Group();
  rootContainer.add(group);
  const sceneManager = { rootContainer, getActiveObject: () => group };

  // Character group prefers SkinnedMesh over non-skinned sub-mesh
  assert.equal(resolveEditableMesh(group, sceneManager), skinned);

  // Clicking propMesh inside character overrides via _lastClickedMesh
  group.userData._lastClickedMesh = propMesh;
  assert.equal(resolveEditableMesh(group, sceneManager), propMesh);
  delete group.userData._lastClickedMesh;

  // Selecting a Bone resolves parent character's mesh and rig info
  assert.equal(resolveEditableMesh(childBone, sceneManager), skinned);
  const rigFromBone = resolveRigTarget(childBone, sceneManager);
  assert.equal(rigFromBone.hasSkeleton, true);
  assert.equal(rigFromBone.hasSkinnedMesh, true);
  assert.equal(rigFromBone.skeleton, skeleton);
  assert.equal(rigFromBone.target, group);

  // Armature without mesh
  const armGroup = new THREE.Group();
  armGroup.name = 'Humanoid_Armature';
  armGroup.userData.isArmature = true;
  const armBone = new THREE.Bone();
  armGroup.add(armBone);
  const armSkel = new THREE.Skeleton([armBone]);
  armGroup.userData.skeleton = armSkel;

  assert.equal(resolveEditableMesh(armGroup), null);
  const armRig = resolveRigTarget(armGroup);
  assert.equal(armRig.hasSkeleton, true);
  assert.equal(armRig.hasSkinnedMesh, false);
  assert.equal(armRig.skeleton, armSkel);
}

// 4. syncViewportModeOptions + switchViewportMode end-to-end state transitions
{
  const { modeSelect, options, events } = setupMockDOM();
  const { group, skinned } = makeSkinnedCharacter('Michelle');
  const armOnly = new THREE.Group();
  armOnly.userData.isArmature = true;
  const b0 = new THREE.Bone();
  armOnly.add(b0);
  armOnly.userData.skeleton = new THREE.Skeleton([b0]);
  const plain = makeBoxMesh('PlainCube');
  const light = new THREE.PointLight(0xffffff, 1);

  let activeObj = plain;
  const sceneManager = { getActiveObject: () => activeObj };

  const log = [];
  const notifications = [];
  const editMode = {
    isActive: false,
    target: null,
    enter(m) { this.isActive = true; this.target = m; log.push(['edit:enter', m.name]); return true; },
    exit() { this.isActive = false; log.push(['edit:exit', this.target?.name]); this.target = null; }
  };
  const sculptMode = {
    isActive: false,
    target: null,
    enter(m) { this.isActive = true; this.target = m; log.push(['sculpt:enter', m.name]); return true; },
    exit() { this.isActive = false; log.push(['sculpt:exit', this.target?.name]); this.target = null; }
  };
  const paintMode = {
    isActive: false,
    mode: null,
    enter(m, md) { this.isActive = true; this.mode = md; log.push([`${md}:enter`, m.name]); return true; },
    exit() { this.isActive = false; log.push([`${this.mode}:exit`]); this.mode = null; }
  };
  const rigSystem = {
    isWeightPaintMode: false,
    isEditBoneMode: false,
    isPoseMode: false,
    activeSkeleton: null,
    skeletonHelper: null,
    createSkeletonVisualizer(skel, target) { this.skeletonHelper = { skel, target }; },
    enableWeightPaintMode(t) { this.isWeightPaintMode = true; log.push(['weight:enter', t.name]); return true; },
    disableWeightPaintMode() { this.isWeightPaintMode = false; log.push(['weight:exit']); },
    enterEditBoneMode(t) { this.isEditBoneMode = true; log.push(['edit-bone:enter', t.name]); return true; },
    exitEditBoneMode() { this.isEditBoneMode = false; log.push(['edit-bone:exit']); },
    setPoseMode(on, t) { this.isPoseMode = Boolean(on); log.push([on ? 'pose:enter' : 'pose:exit', t?.name]); }
  };
  const engineCalls = [];
  const engine = {
    updateActiveGizmo(o) { engineCalls.push(['gizmo', o?.name]); },
    updateSelectionHelper() { engineCalls.push(['helper']); }
  };
  const ctx = {
    engine,
    sceneManager,
    editMode,
    sculptMode,
    paintMode,
    rigSystem,
    notify: (msg, type) => notifications.push({ msg, type })
  };

  // Plain cube hides rig options
  syncViewportModeOptions(plain, sceneManager, rigSystem);
  assert.equal(options.get('weight-paint').hidden, true);
  assert.equal(options.get('edit-bone').hidden, true);
  assert.equal(options.get('pose').hidden, true);

  // Light fails gracefully and reverts to object
  activeObj = light;
  modeSelect.value = 'edit';
  assert.equal(switchViewportMode('edit', ctx), false);
  assert.equal(modeSelect.value, 'object');
  assert.equal(notifications.length, 1);
  assert.equal(events[events.length - 1].detail.mode, 'object');

  // Character Group unhides all rig options and cycles through every mode
  activeObj = group;
  syncViewportModeOptions(group, sceneManager, rigSystem);
  assert.equal(options.get('weight-paint').hidden, false);
  assert.equal(options.get('edit-bone').hidden, false);
  assert.equal(options.get('pose').hidden, false);

  assert.equal(switchViewportMode('edit', ctx), true);
  assert.equal(editMode.isActive, true);
  assert.equal(editMode.target, skinned);

  assert.equal(switchViewportMode('sculpt', ctx), true);
  assert.equal(editMode.isActive, false);
  assert.equal(sculptMode.isActive, true);
  assert.equal(sculptMode.target, skinned);

  assert.equal(switchViewportMode('vertex-paint', ctx), true);
  assert.equal(sculptMode.isActive, false);
  assert.equal(paintMode.isActive, true);
  assert.equal(paintMode.mode, 'vertex-paint');

  assert.equal(switchViewportMode('texture-paint', ctx), true);
  assert.equal(paintMode.isActive, true);
  assert.equal(paintMode.mode, 'texture-paint');

  assert.equal(switchViewportMode('weight-paint', ctx), true);
  assert.equal(paintMode.isActive, false);
  assert.equal(rigSystem.isWeightPaintMode, true);
  assert.equal(modeSelect.value, 'weight-paint');

  assert.equal(switchViewportMode('edit-bone', ctx), true);
  assert.equal(rigSystem.isWeightPaintMode, false);
  assert.equal(rigSystem.isEditBoneMode, true);
  assert.equal(modeSelect.value, 'edit-bone');

  assert.equal(switchViewportMode('pose', ctx), true);
  assert.equal(rigSystem.isEditBoneMode, false);
  assert.equal(rigSystem.isPoseMode, true);
  assert.equal(modeSelect.value, 'pose');

  assert.equal(switchViewportMode('object', ctx), true);
  assert.equal(rigSystem.isPoseMode, false);
  assert.equal(modeSelect.value, 'object');
  assert.deepEqual(engineCalls, [['gizmo', 'Michelle'], ['helper']]);

  // Armature-only hides weight-paint, shows edit-bone & pose, and 'edit' falls back to edit-bone
  activeObj = armOnly;
  syncViewportModeOptions(armOnly, sceneManager, rigSystem);
  assert.equal(options.get('weight-paint').hidden, true);
  assert.equal(options.get('edit-bone').hidden, false);
  assert.equal(options.get('pose').hidden, false);
  assert.equal(switchViewportMode('edit', ctx), true);
  assert.equal(rigSystem.isEditBoneMode, true);
  assert.ok(log.length >= 10);
}

console.log('test_mode_resolver.mjs: ALL PASS');
