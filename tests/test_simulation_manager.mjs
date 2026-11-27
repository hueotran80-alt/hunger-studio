import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  SimulationManager,
  DEFAULT_REVOLUTE,
  PHYSICS_MOTOR_MODES
} from '../js/simulation/simulation-manager.js';
import { SceneManager } from '../js/core/scene-manager.js';
import { StudioExporter } from '../js/exporters/export-import.js';
import { TimelineEngine } from '../js/animation/timeline-engine.js';

let passed = 0;
let failed = 0;
const managers = new Set();
const test = async (name, fn) => {
  try {
    await fn();
    passed += 1;
    console.log(`ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}\n${error.stack}`);
  } finally {
    for (const sim of managers) sim.dispose();
    managers.clear();
  }
};

const makeManager = (options) => {
  const sim = new SimulationManager(options);
  managers.add(sim);
  return sim;
};
const makeJointManager = (options = {}) => {
  const sceneManager = new SceneManager(new THREE.Scene());
  return { sim: makeManager({ sceneManager, ...options }), root: sceneManager.rootContainer, sceneManager };
};
const makeCube = (y = 10) => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
  mesh.position.set(0, y, 0);
  mesh.updateMatrixWorld(true);
  return mesh;
};
const worldPosition = (object) => object.getWorldPosition(new THREE.Vector3());
const worldRotation = (object) => object.getWorldQuaternion(new THREE.Quaternion()).normalize();
const near = (actual, expected, tolerance = 0.02, label = 'position') => {
  const error = actual.distanceTo(expected);
  assert.ok(error < tolerance, `${label}: error=${error}, actual=${actual.toArray()}, expected=${expected.toArray()}`);
};
const sameRotation = (actual, expected, tolerance = 0.01) => {
  const angle = actual.clone().normalize().angleTo(expected.clone().normalize());
  assert.ok(angle < tolerance, `rotation drift=${angle} radians`);
};
const unit = (values, size) => {
  assert.equal(values.length, size);
  assert.ok(values.every(Number.isFinite), `non-finite values: ${values}`);
  assert.ok(Math.abs(Math.hypot(...values) - 1) < 1e-6, `not unit length: ${values}`);
};
// Joint anchors are rigid-body local metres, not scale-divided Object3D coordinates.
const anchorPosition = (object, values) => new THREE.Vector3().fromArray(values)
  .applyQuaternion(worldRotation(object)).add(worldPosition(object));
const assertJointPose = (owner, target, spec) => {
  near(anchorPosition(owner, spec.anchor), anchorPosition(target, spec.targetAnchor), 0.03, 'joint anchors');
  if (spec.type === 'fixed') {
    sameRotation(worldRotation(owner).multiply(new THREE.Quaternion().fromArray(spec.frame)),
      worldRotation(target).multiply(new THREE.Quaternion().fromArray(spec.targetFrame)));
  } else {
    near(new THREE.Vector3().fromArray(spec.axis).applyQuaternion(worldRotation(owner)),
      new THREE.Vector3().fromArray(spec.targetAxis).applyQuaternion(worldRotation(target)), 0.01, 'hinge axes');
  }
};

const wrapDegrees = (value) => THREE.MathUtils.radToDeg(
  Math.atan2(Math.sin(THREE.MathUtils.degToRad(value)), Math.cos(THREE.MathUtils.degToRad(value)))
);
const angleNear = (actual, expected, tolerance, label) => {
  assert.ok(Number.isFinite(actual), `${label}: non-finite angle ${actual}`);
  const error = Math.abs(wrapDegrees(actual - expected));
  assert.ok(error < tolerance, `${label}: angle=${actual}, expected=${expected}, error=${error}`);
};
const hingeWorldAxis = (owner, spec) =>
  new THREE.Vector3().fromArray(spec.axis).applyQuaternion(worldRotation(owner));
const hingeSpeed = (sim, owner, target, spec) =>
  new THREE.Vector3().copy(sim.bodies.get(target).body.angvel()).dot(hingeWorldAxis(owner, spec));
// Independent oracle: signed body-relative rotation projected onto the live world hinge axis.
const rawHingeAngle = (owner, target, spec) => {
  const q1 = worldRotation(owner), q2 = worldRotation(target);
  const relative = q2.clone().multiply(q1.clone().invert());
  const axis = hingeWorldAxis(owner, spec);
  return wrapDegrees(THREE.MathUtils.radToDeg(
    2 * Math.atan2(relative.x * axis.x + relative.y * axis.y + relative.z * axis.z, relative.w)
  ));
};
const makeRevoluteFixture = async ({
  axis = 'z',
  ownerRotation = [0, 0, 0],
  targetRotation = [0, 0, 0],
  timelineEngine = null
} = {}) => {
  const { sim, root, sceneManager } = makeJointManager(timelineEngine ? { timelineEngine } : {});
  await sim.init();
  sim.setGravity(0, 0, 0);
  const owner = makeCube(6); owner.name = 'MotorOwner';
  const target = makeCube(6); target.name = 'MotorTarget';
  target.position[axis === 'x' ? 'z' : 'x'] = 1;
  owner.rotation.set(...ownerRotation);
  target.rotation.set(...targetRotation);
  // Match createJoint's world-axis alignment; independent rotations would twist an axis-only revolute spec.
  const worldAxis = new THREE.Vector3(); worldAxis[axis] = 1;
  target.quaternion.setFromUnitVectors(worldAxis.clone().applyQuaternion(worldRotation(target)),
    worldAxis.clone().applyQuaternion(worldRotation(owner))).multiply(target.quaternion);
  sceneManager.addObject(owner, null, false, false);
  sceneManager.addObject(target, null, false, false);
  sim.setConfig(owner, { body: 'fixed', angularDamping: 0, linearDamping: 0 });
  sim.setConfig(target, { body: 'dynamic', angularDamping: 0, linearDamping: 0 });
  const spec = sim.createJoint(owner, target, { type: 'revolute', axis });
  assert.ok(spec, 'revolute fixture created');
  return { sim, root, sceneManager, owner, target, spec };
};
const geometrySnapshot = (object) => JSON.stringify(
  Object.entries(object.geometry.attributes).map(([name, attribute]) => [name, Array.from(attribute.array)])
    .concat([['index', object.geometry.index ? Array.from(object.geometry.index.array) : null]])
);

await test('dynamic cube falls under gravity', async () => {
  const sim = await makeManager().init();
  const cube = makeCube(10);
  sim.addObject(cube);
  sim.stepFrames(60);
  assert.ok(cube.position.y < 7, `y=${cube.position.y}`);
  assert.ok(cube.position.y > 0, `fell through origin: ${cube.position.y}`);
  sim.dispose();
});

await test('fixed and kinematic bodies do not fall', async () => {
  const sim = await makeManager().init();
  const fixed = makeCube(5);
  const kinematic = makeCube(8);
  sim.addObject(fixed, { ...sim.getConfig(fixed), body: 'fixed' });
  sim.addObject(kinematic, { ...sim.getConfig(kinematic), body: 'kinematic' });
  sim.stepFrames(60);
  assert.equal(fixed.position.y, 5);
  assert.equal(kinematic.position.y, 8);
  sim.dispose();
});

await test('ground stops a falling cube at the collider surface', async () => {
  const sim = await makeManager().init();
  sim.setGroundEnabled(true);
  const cube = makeCube(5);
  sim.addObject(cube);
  sim.stepFrames(180);
  assert.ok(cube.position.y > 0.35 && cube.position.y < 0.75, `resting y=${cube.position.y}`);
  sim.dispose();
});

await test('restitution makes the cube bounce', async () => {
  const sim = await makeManager().init();
  sim.setGroundEnabled(true);
  const cube = makeCube(4);
  sim.setConfig(cube, { restitution: 0.75 });
  let maxAfterBounce = 0;
  for (let i = 0; i < 180; i += 1) {
    sim.stepFrames(1);
    if (i > 50) maxAfterBounce = Math.max(maxAfterBounce, cube.position.y);
  }
  assert.ok(maxAfterBounce > 0.9, `bounce height ${maxAfterBounce}`);
  sim.dispose();
});

await test('reset restores the original transform and keeps bodies', async () => {
  const sim = await makeManager().init();
  const cube = makeCube(10);
  sim.addObject(cube);
  sim.play();
  sim.stepFrames(90);
  assert.ok(cube.position.y < 8);
  sim.reset();
  assert.ok(Math.abs(cube.position.y - 10) < 1e-6, `reset y=${cube.position.y}`);
  assert.equal(sim.bodyCount, 1);
  sim.dispose();
});

await test('simulation is deterministic across identical runs', async () => {
  const run = async () => {
    const sim = await makeManager().init();
    sim.setGroundEnabled(true);
    const cube = makeCube(8);
    sim.setConfig(cube, { friction: 0.2, restitution: 0.4 });
    sim.stepFrames(150);
    const result = [cube.position.x, cube.position.y, cube.position.z, cube.quaternion.w];
    sim.dispose();
    return result;
  };
  const a = await run();
  const b = await run();
  a.forEach((value, index) => assert.ok(Math.abs(value - b[index]) < 1e-9, `index ${index}: ${value} vs ${b[index]}`));
});

await test('config is clamped and stored in userData.physics', async () => {
  const sim = await makeManager().init();
  const cube = makeCube(1);
  const config = sim.setConfig(cube, { mass: -5, restitution: 4, friction: -2, body: 'nope', collider: 'nope' });
  assert.ok(config.mass > 0);
  assert.equal(config.restitution, 1);
  assert.equal(config.friction, 0);
  assert.equal(config.body, 'dynamic');
  assert.equal(config.collider, 'auto');
  assert.equal(cube.userData.physics.mass, config.mass);
  sim.dispose();
});

await test('bake writes keyframes and restores the initial pose', async () => {
  const keyframes = [];
  const timelineStub = {
    insertKeyframe(object, frame, properties) { keyframes.push({ object, frame, properties }); },
    seekToFrame(frame) { this.seeked = frame; }
  };
  const sim = makeManager({ timelineEngine: timelineStub });
  await sim.init();
  const cube = makeCube(10);
  sim.addObject(cube);
  const result = sim.bake({ fps: 30, frames: 30 });
  assert.deepEqual(result, { frames: 31, objects: 1 });
  assert.equal(keyframes.length, 31);
  assert.ok(keyframes.every((entry) => entry.object === cube));
  assert.ok(Math.abs(cube.position.y - 10) < 1e-6);
  assert.equal(timelineStub.seeked, 0);
  sim.dispose();
});

await test('revolute joint keeps the swinging cube on the hinge circle', async () => {
  const { sim, root } = makeJointManager();
  await sim.init();
  const pivot = makeCube(5); pivot.name = 'pivot';
  // Touching cubes must swing: the joint disables contacts only for this pair.
  const bob = makeCube(5); bob.name = 'bob'; bob.position.set(1, 5, 0);
  root.add(pivot, bob);
  sim.setConfig(pivot, { body: 'fixed' });
  sim.setConfig(bob, { body: 'dynamic' });
  const spec = sim.createJoint(pivot, bob, { type: 'revolute', axis: 'z' });
  assert.ok(spec, 'joint spec created');
  assert.equal(sim.jointCount, 1);
  const start = bob.position.clone();
  sim.stepFrames(60);
  assert.ok(bob.position.distanceTo(start) > 0.05, `bob did not swing: ${bob.position.toArray()}`);
  const anchor = new THREE.Vector3(0.5, 5, 0);
  const radius = bob.position.distanceTo(anchor);
  assert.ok(Math.abs(radius - 0.5) < 0.05, `constraint broken: radius=${radius}`);
  sim.dispose();
});

await test('fixed joint welds a dynamic cube to a fixed cube', async () => {
  const { sim, root } = makeJointManager();
  await sim.init();
  const anchor = makeCube(6); anchor.name = 'anchor';
  const welded = makeCube(6); welded.name = 'welded'; welded.position.set(1, 6, 0);
  root.add(anchor, welded);
  sim.setConfig(anchor, { body: 'fixed' });
  sim.createJoint(anchor, welded, { type: 'fixed' });
  sim.stepFrames(120);
  assert.ok(Math.abs(welded.position.y - 6) < 0.05, `welded cube fell: y=${welded.position.y}`);
  assert.ok(Math.abs(welded.position.x - 1) < 0.05, `welded cube drifted: x=${welded.position.x}`);
  sim.dispose();
});

await test('joint survives a world rebuild (ground toggle)', async () => {
  const { sim, root } = makeJointManager();
  await sim.init();
  const anchor = makeCube(6);
  const welded = makeCube(6); welded.position.set(1, 6, 0);
  root.add(anchor, welded);
  sim.setConfig(anchor, { body: 'fixed' });
  sim.createJoint(anchor, welded, { type: 'fixed' });
  sim.setGroundEnabled(true);
  assert.equal(sim.jointCount, 1, 'joint not relinked after rebuild');
  sim.stepFrames(120);
  assert.ok(Math.abs(welded.position.y - 6) < 0.05, `weld broke after rebuild: y=${welded.position.y}`);
  sim.dispose();
});

await test('removeJoint lets the cube fall again', async () => {
  const { sim, root } = makeJointManager();
  await sim.init();
  const anchor = makeCube(6);
  const welded = makeCube(6); welded.position.set(1, 6, 0);
  root.add(anchor, welded);
  sim.setConfig(anchor, { body: 'fixed' });
  sim.createJoint(anchor, welded, { type: 'fixed' });
  assert.ok(sim.removeJoint(anchor, sim.getJoints(anchor)[0]));
  assert.equal(sim.jointCount, 0);
  assert.equal(sim.getJoints(anchor).length, 0);
  sim.stepFrames(120);
  assert.ok(welded.position.y < 4, `cube did not fall after joint removal: y=${welded.position.y}`);
  sim.dispose();
});

await test('joint specs are JSON-safe and use midpoint anchors', async () => {
  const { sim, root } = makeJointManager();
  await sim.init();
  const a = makeCube(5); a.name = 'a';
  const b = makeCube(5); b.name = 'b'; b.position.set(2, 5, 0);
  root.add(a, b);
  sim.createJoint(a, b, { type: 'revolute', axis: 'y' });
  const specs = JSON.parse(JSON.stringify(a.userData.joints));
  assert.equal(specs.length, 1);
  assert.equal(specs[0].type, 'revolute');
  assert.equal(specs[0].targetUuid, b.uuid);
  assert.ok(Math.abs(specs[0].anchor[0] - 1) < 1e-6, `anchor=${specs[0].anchor}`);
  assert.ok(Math.abs(specs[0].targetAnchor[0] + 1) < 1e-6, `targetAnchor=${specs[0].targetAnchor}`);
  assert.deepEqual(specs[0].axis, [0, 1, 0]);
  sim.dispose();
});

await test('joint relinks when the target body comes back', async () => {
  const { sim, root } = makeJointManager();
  await sim.init();
  const anchor = makeCube(6);
  const welded = makeCube(6); welded.position.set(1, 6, 0);
  root.add(anchor, welded);
  sim.setConfig(anchor, { body: 'fixed' });
  sim.createJoint(anchor, welded, { type: 'fixed' });
  sim.removeObject(welded);
  assert.equal(sim.jointCount, 0);
  assert.equal(sim.getJoints(anchor).length, 1, 'spec must stay dormant for undo, not deleted');
  sim.addObject(welded);
  assert.equal(sim.jointCount, 1, 'joint not relinked when target returned');
  sim.stepFrames(60);
  assert.ok(Math.abs(welded.position.y - 6) < 0.05, `relinked joint does not hold: y=${welded.position.y}`);
  sim.dispose();
});

await test('jointed simulation is deterministic across runs', async () => {
  const run = async () => {
    const { sim, root } = makeJointManager();
    await sim.init();
    const pivot = makeCube(5);
    const bob = makeCube(5); bob.position.set(1, 5, 0);
    root.add(pivot, bob);
    sim.setConfig(pivot, { body: 'fixed' });
    sim.createJoint(pivot, bob, { type: 'revolute', axis: 'z' });
    sim.stepFrames(90);
    const result = [bob.position.x, bob.position.y, bob.quaternion.w];
    sim.dispose();
    return result;
  };
  const a = await run();
  const b = await run();
  a.forEach((value, index) => assert.ok(Math.abs(value - b[index]) < 1e-9, `index ${index}: ${value} vs ${b[index]}`));
});

await test('createJoint rejects invalid pairs and clamps options', async () => {
  const { sim, root } = makeJointManager();
  await sim.init();
  const cube = makeCube(5);
  root.add(cube);
  assert.equal(sim.createJoint(cube, cube), null, 'self-joint rejected');
  assert.equal(sim.createJoint(null, cube), null, 'null owner rejected');
  assert.ok(!cube.userData.joints, 'rejected call left a spec behind');
  const other = makeCube(5); other.position.set(3, 5, 0);
  root.add(other);
  const spec = sim.createJoint(cube, other, { type: 'spring', axis: 'w' });
  assert.equal(spec.type, 'revolute');
  assert.deepEqual(spec.axis, [0, 0, 1]);
  assert.ok(cube.userData.physics && other.userData.physics, 'valid pair auto-adds bodies');
  sim.dispose();
});

await test('fixed joint preserves different rotations under rotated and scaled parents', async () => {
  const { sim, root } = makeJointManager();
  const parents = [new THREE.Group(), new THREE.Group()];
  parents[0].position.set(-2, 4, 1); parents[0].rotation.set(0.3, -0.4, 0.2); parents[0].scale.setScalar(1.7);
  parents[1].position.set(2, 5, -1); parents[1].rotation.set(-0.2, 0.6, -0.3); parents[1].scale.setScalar(0.8);
  root.add(...parents);
  const owner = makeCube(1), target = makeCube(2);
  owner.rotation.set(0.4, 0.1, -0.5); target.rotation.set(-0.7, 0.3, 0.8);
  target.scale.set(0.8, 1.2, 1.1);
  parents[0].add(owner); parents[1].add(target);
  await sim.init();
  sim.setConfig(owner, { body: 'fixed' });
  const position = worldPosition(target), rotation = worldRotation(target), scale = target.scale.clone();
  const spec = sim.createJoint(owner, target, { type: 'fixed' });
  unit(spec.frame, 4); unit(spec.targetFrame, 4);
  const midpoint = worldPosition(owner).add(position).multiplyScalar(0.5);
  near(anchorPosition(owner, spec.anchor), midpoint, 1e-6);
  near(anchorPosition(target, spec.targetAnchor), midpoint, 1e-6);
  for (let i = 0; i < 12; i += 1) {
    sim.stepFrames(10);
    near(worldPosition(target), position);
    sameRotation(worldRotation(target), rotation);
    assertJointPose(owner, target, spec);
  }
  near(target.scale, scale, 1e-9, 'local scale');
});

for (const axis of ['x', 'y', 'z']) {
  await test(`rotated revolute bodies keep their local ${axis} axes aligned in world space`, async () => {
    const { sim, root } = makeJointManager();
    await sim.init();
    const owner = makeCube(6), target = makeCube(6);
    target.position[axis === 'x' ? 'z' : 'x'] = 1;
    owner.rotation.set(0.35, -0.6, 0.2); target.rotation.set(-0.4, 0.25, 0.9);
    root.add(owner, target);
    sim.setConfig(owner, { body: 'fixed' });
    const spec = sim.createJoint(owner, target, { type: 'revolute', axis });
    unit(spec.axis, 3); unit(spec.targetAxis, 3);
    const worldAxis = new THREE.Vector3(); worldAxis[axis] = 1;
    near(new THREE.Vector3().fromArray(spec.axis).applyQuaternion(worldRotation(owner)), worldAxis, 1e-6);
    near(new THREE.Vector3().fromArray(spec.targetAxis).applyQuaternion(worldRotation(target)), worldAxis, 1e-6);
    sim.bodies.get(target).body.setAngvel(worldAxis.clone().multiplyScalar(2), true);
    const start = worldPosition(target), center = anchorPosition(owner, spec.anchor);
    let travel = 0;
    for (let i = 0; i < 90; i += 1) {
      sim.stepFrames(1);
      assertJointPose(owner, target, spec);
      assert.ok(Math.abs(worldPosition(target).distanceTo(center) - 0.5) < 0.03, 'hinge radius drifted');
      travel = Math.max(travel, worldPosition(target).distanceTo(start));
    }
    assert.ok(travel > 0.1, `hinge locked: travel=${travel}`);
  });
}

await test('touching jointed cubes swing without pair contacts but still collide with ground', async () => {
  const { sim, root } = makeJointManager();
  await sim.init();
  sim.setGroundEnabled(true);
  const pivot = makeCube(1), bob = makeCube(1), falling = makeCube(4);
  bob.position.x = 1; falling.position.x = 4;
  root.add(pivot, bob, falling);
  sim.setConfig(pivot, { body: 'fixed' });
  sim.addObject(falling);
  const spec = sim.createJoint(pivot, bob, { type: 'revolute', axis: 'z' });
  assert.equal(sim.jointEntries[0].joint.contactsEnabled(), false);
  const start = bob.position.clone();
  let travel = 0;
  for (let i = 0; i < 240; i += 1) {
    sim.stepFrames(1);
    assertJointPose(pivot, bob, spec);
    const bottom = new THREE.Box3().setFromObject(bob).min.y;
    assert.ok(bottom > -0.03, `jointed cube penetrated ground: bottom=${bottom}`);
    travel = Math.max(travel, bob.position.distanceTo(start));
  }
  assert.ok(travel > 0.2, `touching cubes did not swing: travel=${travel}`);
  assert.ok(Math.abs(new THREE.Box3().setFromObject(bob).min.y) < 0.03, 'bob did not settle on ground');
  assert.ok(Math.abs(falling.position.y - 0.5) < 0.03, `unrelated ground collision lost: y=${falling.position.y}`);
});

for (const type of ['fixed', 'revolute']) {
  await test(`${type} world JSON roundtrip relinks reverse body order and reproduces trajectory`, async () => {
    const source = makeJointManager();
    await source.sim.init();
    const owner = makeCube(6), target = makeCube(6);
    target.position.x = 1;
    owner.rotation.set(0.3, -0.2, 0.4); target.rotation.set(-0.4, 0.6, -0.1);
    source.root.add(owner, target);
    source.sim.setConfig(owner, { body: 'fixed' });
    const spec = source.sim.createJoint(owner, target, { type, axis: 'z' });
    const parsed = new THREE.ObjectLoader().parse(JSON.parse(JSON.stringify(source.sceneManager.scene.toJSON())));
    const imported = parsed.getObjectByProperty('uuid', source.root.uuid);
    imported.children.reverse();
    const restored = makeJointManager();
    // Existing-root traversal must discover descendants and defer missing targets.
    restored.sceneManager.addObject(imported, null, false, false);
    await restored.sim.init();
    const copyOwner = imported.getObjectByProperty('uuid', owner.uuid);
    const copyTarget = imported.getObjectByProperty('uuid', target.uuid);
    assert.notEqual(copyOwner, owner);
    assert.equal([...restored.sim.bodies.keys()][0], copyTarget, 'target must load before owner');
    assert.equal(restored.sim.bodyCount, 2);
    assert.equal(restored.sim.jointCount, 1);
    assert.deepEqual(restored.sim.getJoints(copyOwner), [spec]);
    assert.equal(restored.sim.jointEntries[0].joint.contactsEnabled(), false);
    for (let i = 0; i < 12; i += 1) {
      source.sim.stepFrames(10); restored.sim.stepFrames(10);
      near(worldPosition(copyTarget), worldPosition(target), 1e-5, 'roundtrip trajectory');
      sameRotation(worldRotation(copyTarget), worldRotation(target), 1e-5);
      assertJointPose(copyOwner, copyTarget, restored.sim.getJoints(copyOwner)[0]);
    }
  });
}

await test('SceneManager delete/undo/redo traverses nested groups and revives dormant joints', async () => {
  const { sim, sceneManager } = makeJointManager();
  await sim.init();
  const anchor = makeCube(6), owner = makeCube(6), target = makeCube(6);
  owner.position.x = 1; target.position.x = 2;
  const group = new THREE.Group(), nested = new THREE.Group();
  nested.add(owner, target); group.add(nested);
  sceneManager.addObject(anchor, null, false, false);
  sceneManager.addObject(group, null, false, false);
  sim.setConfig(anchor, { body: 'fixed' });
  const external = sim.createJoint(anchor, owner, { type: 'fixed' });
  const internal = sim.createJoint(owner, target, { type: 'fixed' });
  sceneManager.clearHistory();
  assert.equal(sceneManager.removeObject(group), true);
  assert.equal(sceneManager.undoStack.length, 1);
  const checkRemoved = () => {
    assert.equal(group.parent, null);
    assert.equal(sim.bodyCount, 1);
    assert.equal(sim.jointCount, 0);
    assert.deepEqual(sim.getJoints(anchor), [external]);
    assert.deepEqual(sim.getJoints(owner), [internal]);
    assert.ok(owner.userData.physics && target.userData.physics, 'deleted subtree lost body configs');
  };
  checkRemoved();
  for (let cycle = 0; cycle < 2; cycle += 1) {
    sceneManager.undo();
    assert.equal(group.parent, sceneManager.rootContainer);
    assert.equal(sim.bodyCount, 3);
    assert.equal(sim.jointCount, 2);
    sim.stepFrames(60);
    near(worldPosition(target), new THREE.Vector3(2, 6, 0));
    assertJointPose(anchor, owner, external); assertJointPose(owner, target, internal);
    sim.reset();
    sceneManager.redo();
    checkRemoved();
  }
});

for (const existing of ['none', 'owner', 'both', 'dormant config']) {
  await test(`createJoint undo/redo restores auto-added bodies (${existing})`, async () => {
    const { sim, sceneManager } = makeJointManager();
    await sim.init();
    const owner = makeCube(6), target = makeCube(6); target.position.x = 1;
    sceneManager.addObject(owner, null, false, false);
    sceneManager.addObject(target, null, false, false);
    if (existing === 'owner' || existing === 'both') sim.setConfig(owner, { body: 'fixed', mass: 3 });
    if (existing === 'both') sim.setConfig(target, { mass: 2, friction: 0.7 });
    if (existing === 'dormant config') owner.userData.physics = { ...sim.getConfig(owner), body: 'fixed', mass: 4 };
    const before = [owner, target].map((object) => object.userData.physics && { ...object.userData.physics });
    const beforeCount = sim.bodyCount;
    const spec = sim.createJoint(owner, target, { type: 'fixed' });
    assert.equal(sceneManager.undoStack.length, 1, 'creation must be one undo step');
    assert.equal(sim.bodyCount, 2);
    assert.equal(sim.jointCount, 1);
    for (let cycle = 0; cycle < 2; cycle += 1) {
      sceneManager.undo();
      assert.equal(sim.jointCount, 0);
      assert.equal(sim.bodyCount, beforeCount);
      assert.deepEqual(sim.getJoints(owner), []);
      [owner, target].forEach((object, i) => assert.deepEqual(object.userData.physics, before[i]));
      assert.equal(sceneManager.undoStack.length, 0, 'undo recorded an extra command');
      sceneManager.redo();
      assert.equal(sceneManager.undoStack.length, 1);
      assert.equal(sim.bodyCount, 2);
      assert.equal(sim.jointCount, 1);
      assert.deepEqual(sim.getJoints(owner), [spec]);
      sim.stepFrames(30);
      assertJointPose(owner, target, spec);
      near(worldPosition(target).sub(worldPosition(owner)), new THREE.Vector3(1, 0, 0));
      sim.reset();
    }
  });
}

await test('removeJoint undo/redo restores the constraint without removing auto-added bodies', async () => {
  const { sim, root, sceneManager } = makeJointManager();
  await sim.init();
  const owner = makeCube(6), target = makeCube(6); target.position.x = 1;
  root.add(owner, target);
  const spec = sim.createJoint(owner, target, { type: 'fixed' });
  sim.setConfig(owner, { body: 'fixed' });
  const configs = [owner, target].map((object) => ({ ...object.userData.physics }));
  sceneManager.clearHistory();
  assert.equal(sim.removeJoint(owner, spec), true);
  assert.equal(sim.removeJoint(owner, spec), false, 'second removal must not add history');
  for (let cycle = 0; cycle < 2; cycle += 1) {
    assert.equal(sim.jointCount, 0);
    assert.equal(sim.bodyCount, 2);
    assert.equal(sceneManager.undoStack.length, 1);
    sim.stepFrames(45);
    assert.ok(target.position.y < 4, `removed weld still holds: y=${target.position.y}`);
    sim.reset();
    sceneManager.undo();
    assert.deepEqual(sim.getJoints(owner), [spec]);
    assert.equal(sim.jointCount, 1);
    [owner, target].forEach((object, i) => assert.deepEqual(object.userData.physics, configs[i]));
    sim.stepFrames(45);
    near(target.position, new THREE.Vector3(1, 6, 0));
    assertJointPose(owner, target, spec);
    sim.reset();
    sceneManager.redo();
  }
});

await test('step/pause/play/reset keeps the first pose and cancels animation callbacks', async () => {
  const saved = ['requestAnimationFrame', 'cancelAnimationFrame'].map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  const pending = new Map(); let id = 0;
  globalThis.requestAnimationFrame = (fn) => { pending.set(++id, fn); return id; };
  globalThis.cancelAnimationFrame = (handle) => pending.delete(handle);
  const tick = (time) => {
    assert.equal(pending.size, 1);
    const [handle, fn] = pending.entries().next().value;
    pending.delete(handle); fn(time);
  };
  const sim = makeManager();
  try {
    await sim.init();
    const cube = makeCube(10); cube.rotation.set(0.2, -0.3, 0.4); cube.scale.setScalar(1.2);
    const rotation = cube.quaternion.clone(), scale = cube.scale.clone();
    sim.addObject(cube);
    sim.stepFrames(30);
    const afterStep = cube.position.clone();
    assert.ok(afterStep.y < 9, `manual step did not advance: y=${afterStep.y}`);
    for (const time of [0, 1000]) {
      assert.equal(sim.play(), true);
      assert.equal(sim.play(), false, 'double play must not schedule two loops');
      tick(time); tick(time + 100);
      sim.pause();
      assert.equal(sim.isPlaying, false);
      assert.equal(pending.size, 0, 'pause leaked a callback');
    }
    assert.ok(cube.position.y < afterStep.y - 0.5, 'play did not resume motion');
    sim.reset();
    near(cube.position, new THREE.Vector3(0, 10, 0), 1e-6);
    sameRotation(cube.quaternion, rotation, 1e-6); near(cube.scale, scale, 1e-9);
    sim.stepFrames(30);
    near(cube.position, afterStep, 1e-6, 'reset trajectory');
    sim.reset();
    cube.position.y = 12; sim.addObject(cube);
    sim.play(); sim.stepFrames(10); sim.reset();
    near(cube.position, new THREE.Vector3(0, 12, 0), 1e-6, 'fresh snapshot after reset');
    assert.equal(pending.size, 0);
  } finally {
    sim.dispose();
    ['requestAnimationFrame', 'cancelAnimationFrame'].forEach((key, i) => {
      if (saved[i]) Object.defineProperty(globalThis, key, saved[i]);
      else delete globalThis[key];
    });
  }
});

await test('joint bake records a moving hinge trajectory and restores pose and constraints', async () => {
  const keys = [];
  const timeline = {
    insertKeyframe(object, frame, properties) {
      keys.push({ object, frame, properties: [...properties], position: object.position.clone(), quaternion: object.quaternion.clone() });
    },
    seekToFrame(frame) { this.seeked = frame; }
  };
  const { sim, root } = makeJointManager({ timelineEngine: timeline });
  await sim.init();
  const owner = makeCube(5), target = makeCube(5); target.position.x = 1;
  root.add(owner, target);
  sim.setConfig(owner, { body: 'fixed' });
  const spec = sim.createJoint(owner, target, { type: 'revolute', axis: 'z' });
  assert.deepEqual(sim.bake({ fps: 30, frames: 60 }), { frames: 61, objects: 2 });
  assert.equal(keys.length, 122);
  assert.ok(keys.every((key) => key.properties.join(',') === 'position,rotation'));
  const trajectory = keys.filter((key) => key.object === target);
  assert.deepEqual(trajectory.map((key) => key.frame), Array.from({ length: 61 }, (_, i) => i));
  const center = new THREE.Vector3(0.5, 5, 0);
  for (const key of trajectory) {
    near(new THREE.Vector3().fromArray(spec.targetAnchor).applyQuaternion(key.quaternion).add(key.position), center, 0.03);
    assert.ok(Math.abs(key.position.distanceTo(center) - 0.5) < 0.03);
  }
  assert.ok(trajectory.some((key) => key.position.distanceTo(trajectory[0].position) > 0.2), 'bake recorded a static bob');
  for (const key of keys.filter((entry) => entry.object === owner)) near(key.position, new THREE.Vector3(0, 5, 0), 1e-6);
  near(target.position, new THREE.Vector3(1, 5, 0), 1e-6);
  sameRotation(target.quaternion, new THREE.Quaternion(), 1e-6);
  assert.equal(timeline.seeked, 0);
  assert.equal(sim.jointCount, 1);
  assert.deepEqual(sim.getJoints(owner), [spec]);
  assert.equal(sim.jointEntries[0].joint.contactsEnabled(), false);
  sim.stepFrames(120);
  near(target.position, trajectory.at(-1).position, 1e-5, 'post-bake trajectory');
  sameRotation(target.quaternion, trajectory.at(-1).quaternion, 1e-5);
  assertJointPose(owner, target, spec);
  sim.reset();
  near(target.position, new THREE.Vector3(1, 5, 0), 1e-6);
});

await test('malformed imported specs are skipped without crashes or non-finite transforms', async () => {
  const { sim, root } = makeJointManager();
  const owner = makeCube(6), target = makeCube(6), bad = makeCube(8), other = makeCube(8), nonArray = makeCube(9);
  target.position.x = 1; bad.position.x = 5; other.position.x = 8; nonArray.position.x = 11;
  root.add(owner, target, bad, other, nonArray);
  for (const object of root.children) object.userData.physics = sim.getConfig(object);
  owner.userData.physics.body = 'fixed';
  const valid = { type: 'fixed', targetUuid: target.uuid, anchor: [0.5, 0, 0], targetAnchor: [-0.5, 0, 0], frame: [0, 0, 0, 1], targetFrame: [0, 0, 0, 1] };
  owner.userData.joints = [valid];
  const base = { ...valid, targetUuid: other.uuid };
  const hinge = { type: 'revolute', targetUuid: other.uuid, anchor: [1.5, 0, 0], targetAnchor: [-1.5, 0, 0], axis: [0, 0, 1], targetAxis: [0, 0, 1] };
  bad.userData.joints = [null, {}, 'joint', { ...base, type: 'spring' }, { ...base, targetUuid: 42 },
    { ...base, targetUuid: 'missing-body' }, { ...base, targetUuid: bad.uuid },
    { ...base, anchor: [0, 0] }, { ...base, targetAnchor: [0, NaN, 0] }, { ...base, anchor: [0, Infinity, 0] },
    { ...base, frame: null }, { ...base, frame: [0, 0, 0] }, { ...base, frame: [0, 0, 0, 0] },
    { ...base, targetFrame: [0, 0, 0, 2] }, { ...base, targetFrame: [0, 0, NaN, 1] },
    { ...hinge, axis: [0, 0, 0] }, { ...hinge, axis: [0, 0, 2] }, { ...hinge, targetAxis: [1, 0] },
    { ...hinge, targetAxis: [0, Infinity, 0] }, { ...hinge, targetAxis: undefined }];
  nonArray.userData.joints = { invalid: true };
  const malformed = structuredClone(bad.userData.joints);
  await sim.init();
  assert.equal(sim.bodyCount, 5);
  assert.equal(sim.jointCount, 1, 'malformed specs created live joints');
  assert.deepEqual(bad.userData.joints, malformed, 'import validation should not mutate stored specs');
  for (let i = 0; i < 12; i += 1) {
    sim.stepFrames(10);
    for (const { object, body } of sim.bodies.values()) {
      assert.ok([...object.position.toArray(), ...object.quaternion.toArray(), ...Object.values(body.linvel())].every(Number.isFinite), 'NaN in simulated body');
      unit(object.quaternion.toArray(), 4);
    }
    assertJointPose(owner, target, valid);
  }
  assert.ok(bad.position.y < 0, 'malformed joint constrained its owner');
});

await test('duplicate and invalid pairs leave bodies, specs, playback and history untouched', async () => {
  const { sim, root, sceneManager } = makeJointManager();
  await sim.init();
  const owner = makeCube(6), target = makeCube(6), fresh = makeCube(6);
  target.position.x = 1; fresh.position.x = 4;
  const helper = makeCube(6); helper.userData.isHelper = true;
  const cameraPart = makeCube(6); cameraPart.userData.isCameraPart = true;
  const group = new THREE.Group(); group.add(makeCube(6));
  const skinned = new THREE.SkinnedMesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
  const objects = [owner, target, fresh, helper, cameraPart, group, skinned];
  root.add(...objects);
  sim.createJoint(owner, target, { type: 'fixed' });
  sim.stepFrames(1); sim.play();
  const entries = [...sim.bodies.entries()], joint = sim.jointEntries[0].joint;
  const data = objects.map((object) => structuredClone(object.userData));
  const initial = sim._initial, history = sceneManager.undoStack.slice();
  const pairs = [[owner, target], [target, owner], [fresh, fresh], [null, fresh], [fresh, null]];
  for (const invalid of [helper, cameraPart, group, skinned]) pairs.push([fresh, invalid], [invalid, fresh]);
  for (const [a, b] of pairs) {
    assert.equal(sim.createJoint(a, b, { type: 'revolute', axis: 'x' }), null, 'invalid pair accepted');
    assert.equal(sim.bodyCount, entries.length);
    for (const [object, entry] of entries) assert.equal(sim.bodies.get(object), entry, 'rejection rebuilt a body');
    assert.equal(sim.jointEntries[0].joint, joint);
    assert.equal(sim.jointCount, 1);
    objects.forEach((object, i) => assert.deepEqual(object.userData, data[i]));
    assert.deepEqual(sceneManager.undoStack, history);
    assert.equal(sim.isPlaying, true, 'rejected pair paused simulation');
    assert.equal(sim._initial, initial, 'rejected pair discarded reset snapshot');
  }
});

for (const type of ['fixed', 'revolute']) {
  await test(`changing body configuration preserves a ${type} joint`, async () => {
    const { sim, root } = makeJointManager();
    await sim.init();
    const owner = makeCube(6), target = makeCube(6); target.position.x = 1;
    root.add(owner, target);
    sim.setConfig(owner, { body: 'fixed' });
    const spec = sim.createJoint(owner, target, { type, axis: 'z' });
    for (const partial of [{ mass: 3 }, { collider: 'sphere' }, { friction: 0.9, angularDamping: 0.2 }, { body: 'fixed' }, { body: 'dynamic' }]) {
      sim.setConfig(target, partial);
      assert.equal(sim.jointCount, 1);
      assert.deepEqual(sim.getJoints(owner), [spec]);
      assert.equal(sim.jointEntries[0].joint.contactsEnabled(), false);
      sim.stepFrames(30);
      assertJointPose(owner, target, spec);
      if (type === 'fixed') near(target.position, new THREE.Vector3(1, 6, 0));
      sim.reset();
    }
    sim.setConfig(owner, { friction: 0.3 });
    assert.equal(sim.jointCount, 1);
    sim.stepFrames(60);
    assertJointPose(owner, target, spec);
  });
}

await test('adding or updating unrelated bodies keeps the live joint handle and velocities', async () => {
  const { sim, root, sceneManager } = makeJointManager();
  await sim.init();
  const owner = makeCube(6), target = makeCube(6); target.position.x = 1;
  root.add(owner, target);
  sim.setConfig(owner, { body: 'fixed' });
  const spec = sim.createJoint(owner, target, { type: 'revolute', axis: 'z' });
  sim.stepFrames(30);
  const joint = sim.jointEntries[0].joint, body = sim.bodies.get(target).body;
  const velocity = { ...body.linvel() }, angular = { ...body.angvel() }, position = target.position.clone();
  const unrelated = makeCube(8); unrelated.position.x = 10;
  unrelated.userData.physics = sim.getConfig(unrelated);
  sceneManager.addObject(unrelated, null, false, false);
  sim.setConfig(unrelated, { mass: 4 });
  assert.equal(sim.bodyCount, 3);
  assert.equal(sim.jointEntries[0].joint, joint, 'unrelated add recreated live constraint');
  assert.equal(sim.jointEntries[0].joint.handle, joint.handle);
  assert.equal(sim.bodies.get(target).body, body);
  assert.deepEqual({ ...body.linvel() }, velocity);
  assert.deepEqual({ ...body.angvel() }, angular);
  near(target.position, position, 1e-9);
  sim.stepFrames(30);
  assert.ok(target.position.distanceTo(position) > 0.1, 'relink froze existing motion');
  assertJointPose(owner, target, spec);
});

await test('dispose removes only its SceneManager callbacks and cannot resurrect a world', async () => {
  const { sim, sceneManager } = makeJointManager();
  const events = ['objectAdded', 'objectRemoved', 'sceneCleared'];
  let calls = 0;
  const sentinel = () => { calls += 1; };
  for (const event of events) sceneManager.on(event, sentinel);
  await sim.init(); await sim.init();
  for (const event of events) assert.equal(sceneManager._listeners.get(event).size, 2, `duplicate ${event} listener`);
  const cube = makeCube(6); cube.userData.physics = sim.getConfig(cube);
  sceneManager.addObject(cube, null, false, false);
  assert.equal(sim.bodyCount, 1);
  sim.dispose();
  for (const event of events) {
    assert.deepEqual([...sceneManager._listeners.get(event)], [sentinel], `leaked ${event} callback`);
    sceneManager.emit(event, { object: cube });
  }
  assert.equal(calls, 4);
  assert.equal(sim.world, null);
  assert.equal(sim.ready, false);
  assert.equal(sim.bodyCount, 0);
  assert.equal(sim.jointCount, 0);
});

await test('revolute motor schema defaults, normalization and immutable getter', async () => {
  assert.deepEqual(DEFAULT_REVOLUTE, {
    limitsEnabled: false, lower: -180, upper: 180, motorMode: 'off',
    targetVelocity: 0, targetAngle: 0, stiffness: 20, damping: 2, maxTorque: 100
  });
  assert.ok(Object.isFrozen(DEFAULT_REVOLUTE));
  assert.deepEqual(PHYSICS_MOTOR_MODES, ['off', 'velocity', 'position', 'servo']);
  const { sim, owner, target, spec, sceneManager } = await makeRevoluteFixture();
  assert.deepEqual(Object.keys(spec).sort(), ['anchor', 'axis', 'targetAnchor', 'targetAxis', 'targetUuid', 'type']);
  const config = sim.getJointConfig(owner, spec);
  assert.deepEqual(config, DEFAULT_REVOLUTE);
  assert.notEqual(config, DEFAULT_REVOLUTE);
  config.motorMode = 'servo'; config.lower = 12;
  assert.deepEqual(sim.getJointConfig(owner, spec), DEFAULT_REVOLUTE);
  assert.equal(spec.motorMode, undefined);
  assert.equal(sim.getJointConfig(target, spec), null, 'target-side ownership is not the config owner');
  assert.equal(sim.getJointConfig(owner, { type: 'fixed' }), null);
  sceneManager.clearHistory();
  const next = sim.setJointConfig(owner, spec, {
    lower: 200, upper: -200, targetVelocity: 9999, targetAngle: -999,
    stiffness: -5, damping: 1e9, maxTorque: -1, motorMode: 'bogus', limitsEnabled: 'yes'
  });
  assert.equal(next.lower, 180);
  assert.equal(next.upper, 180, 'upper must never normalize below lower');
  assert.equal(next.targetVelocity, 3600);
  assert.equal(next.targetAngle, -180);
  assert.equal(next.stiffness, 0);
  assert.equal(next.damping, 10000);
  assert.equal(next.maxTorque, 0);
  assert.equal(next.motorMode, 'off', 'invalid partial mode keeps the previous mode');
  assert.equal(next.limitsEnabled, false);
  assert.equal(sceneManager.undoStack.length, 1);
  sim.setJointConfig(owner, spec, { lower: 50, upper: 20 });
  assert.equal(spec.lower, 50);
  assert.equal(spec.upper, 50);
  assert.throws(() => sim.setJointConfig(owner, spec, null), /joint/i);
  assert.throws(() => sim.setJointConfig(owner, spec, []), /joint/i);
  assert.equal(sim.setJointConfig(owner, { ...spec }, {}), null, 'foreign spec rejected');
});

await test('legacy revolute specs stay free/passive and unchanged through relink, reads and JSON', async () => {
  const { sim, owner, target, spec, sceneManager } = await makeRevoluteFixture();
  const before = structuredClone(spec);
  const position = target.position.clone(), quaternion = target.quaternion.clone();
  const geometry = geometrySnapshot(target);
  assert.equal(sim.getJointAngle(owner, spec), 0);
  assert.deepEqual(sim.getJointConfig(owner, spec), DEFAULT_REVOLUTE);
  assert.deepEqual(spec, before, 'reads normalized the stored legacy spec');
  assert.ok(target.position.equals(position) && target.quaternion.equals(quaternion));
  assert.equal(geometrySnapshot(target), geometry);
  sim.bodies.get(target).body.setAngvel(new THREE.Vector3(0, 0, 2), true);
  sim.stepFrames(60);
  assert.ok(Math.abs(sim.getJointAngle(owner, spec)) > 30, 'legacy hinge did not move passively');
  assert.deepEqual(spec, before);
  const joint = sim.jointEntries[0].joint;
  sim._relinkJoints();
  assert.equal(sim.jointEntries[0].joint, joint);
  assert.deepEqual(spec, before);
  sim.setGroundEnabled(true);
  assert.equal(sim.jointCount, 1);
  assert.deepEqual(spec, before);
  const json = JSON.stringify(sceneManager.scene.toJSON());
  assert.ok(!json.includes('angleReference'), 'runtime reference leaked into scene JSON');
  const parsed = new THREE.ObjectLoader().parse(JSON.parse(json));
  assert.deepEqual(parsed.getObjectByProperty('uuid', owner.uuid).userData.joints, [before]);
});

await test('malformed and out-of-range imported motor configs are skipped without source mutation', async () => {
  const { sim, owner, target, spec } = await makeRevoluteFixture();
  const base = structuredClone(spec);
  const patches = [
    { lower: -181 }, { upper: 181 }, { lower: 50, upper: 20 }, { targetAngle: 181 },
    { targetAngle: -181 }, { targetVelocity: 3601 }, { targetVelocity: -3601 },
    { stiffness: -1 }, { stiffness: 10001 }, { damping: -1 }, { damping: 10001 },
    { maxTorque: -1 }, { maxTorque: 10001 },
    { motorMode: 'bogus' }, { motorMode: null }, { limitsEnabled: 'yes' }, { limitsEnabled: 1 },
    { targetVelocity: NaN }, { damping: Infinity }, { lower: NaN }, { maxTorque: '100' }
  ];
  const failures = [];
  for (const patch of patches) {
    const candidate = { ...base, ...patch };
    owner.userData.joints = [candidate];
    const snapshot = structuredClone(candidate);
    sim._relinkJoints();
    const label = Object.entries(patch).map(([key, value]) => `${key}=${String(value)}`).join(',');
    if (sim.jointCount !== 0) failures.push(`${label}: created ${sim.jointCount} live joints`);
    try { assert.deepEqual(candidate, snapshot); } catch (_) { failures.push(`${label}: source spec mutated`); }
    sim.stepFrames(1);
    for (const { object, body } of sim.bodies.values()) {
      if (![...object.position.toArray(), ...object.quaternion.toArray(), ...Object.values(body.linvel())].every(Number.isFinite)) {
        failures.push(`${label}: non-finite body state`);
      }
    }
  }
  owner.userData.joints = [base];
  sim._relinkJoints();
  assert.equal(sim.jointCount, 1, 'valid legacy hinge must still relink');
  assert.deepEqual(owner.userData.joints, [base]);
  assert.deepEqual(failures, [], `invalid imported configs were accepted:\n${failures.join('\n')}`);
});

await test('velocity motor approximates speed, respects maxTorque and off mode with gravity off', async () => {
  const { sim, owner, target, spec } = await makeRevoluteFixture();
  sim.setJointConfig(owner, spec, { motorMode: 'velocity', targetVelocity: 120, maxTorque: 1000, damping: 0 }, false);
  sim.stepFrames(60);
  angleNear(sim.getJointAngle(owner, spec), 120, 3, 'velocity 120 deg/s');
  assert.ok(Math.abs(hingeSpeed(sim, owner, target, spec) - THREE.MathUtils.degToRad(120)) < 0.05, 'native angular velocity did not reach target');
  assert.ok(target.position.distanceTo(new THREE.Vector3(1, 6, 0)) > 0.1, 'velocity motor produced no real motion');
  sim.reset();
  sim.setJointConfig(owner, spec, { targetVelocity: -90 }, false);
  sim.stepFrames(60);
  angleNear(sim.getJointAngle(owner, spec), -90, 3, 'velocity -90 deg/s');
  sim.reset();
  sim.setJointConfig(owner, spec, { targetVelocity: 120, maxTorque: 0 }, false);
  sim.stepFrames(60);
  angleNear(sim.getJointAngle(owner, spec), 0, 1e-3, 'maxTorque=0 must not drive');
  assert.ok(Math.abs(hingeSpeed(sim, owner, target, spec)) < 1e-6);
  sim.reset();
  sim.setJointConfig(owner, spec, { motorMode: 'off', maxTorque: 1000 }, false);
  sim.stepFrames(60);
  angleNear(sim.getJointAngle(owner, spec), 0, 1e-3, 'motor off must not drive');
});

await test('position and servo motors settle toward requested angles and servo combines velocity', async () => {
  const { sim, owner, target, spec } = await makeRevoluteFixture();
  sim.setJointConfig(owner, spec, {
    motorMode: 'position', targetAngle: 45, targetVelocity: 999,
    stiffness: 200, damping: 30, maxTorque: 1000
  }, false);
  sim.stepFrames(180);
  angleNear(sim.getJointAngle(owner, spec), 45, 0.5, 'position ignores targetVelocity');
  assert.ok(Math.abs(hingeSpeed(sim, owner, target, spec)) < 0.02, 'position motor did not settle');
  sim.reset();
  sim.setJointConfig(owner, spec, { targetAngle: -60 }, false);
  sim.stepFrames(180);
  angleNear(sim.getJointAngle(owner, spec), -60, 0.5, 'negative position target');
  sim.reset();
  sim.setJointConfig(owner, spec, { motorMode: 'servo', targetAngle: 35, targetVelocity: 0 }, false);
  sim.stepFrames(180);
  angleNear(sim.getJointAngle(owner, spec), 35, 0.5, 'servo position target');
  sim.reset();
  sim.setJointConfig(owner, spec, { targetVelocity: 60 }, false);
  sim.stepFrames(240);
  const servoAngle = sim.getJointAngle(owner, spec);
  assert.ok(servoAngle > 40, `servo did not combine velocity feed-forward: ${servoAngle}`);
  angleNear(servoAngle, 44, 1, 'servo spring/damping equilibrium');
  sim.reset();
  sim.setJointConfig(owner, spec, { motorMode: 'position', targetAngle: 45, maxTorque: 0 }, false);
  sim.stepFrames(120);
  angleNear(sim.getJointAngle(owner, spec), 0, 1e-3, 'position maxTorque=0 must not drive');
});

await test('angular limits stop both sides, pull in outside starts and clamp position targets', async () => {
  const { sim, owner, target, spec } = await makeRevoluteFixture();
  sim.setJointConfig(owner, spec, {
    limitsEnabled: true, lower: -30, upper: 40,
    motorMode: 'velocity', targetVelocity: 180, maxTorque: 1000, damping: 5
  }, false);
  sim.stepFrames(240);
  const upperAngle = sim.getJointAngle(owner, spec);
  assert.ok(upperAngle > 38 && upperAngle < 40.5, `upper stop missed: ${upperAngle}`);
  const joint = sim.jointEntries[0].joint;
  // Rapier stores limits as f32, so compare with single-precision tolerance.
  assert.ok(Math.abs(joint.limitsMin() - THREE.MathUtils.degToRad(-30)) < 1e-6);
  assert.ok(Math.abs(joint.limitsMax() - THREE.MathUtils.degToRad(40)) < 1e-6);
  sim.reset();
  sim.setJointConfig(owner, spec, { targetVelocity: -180 }, false);
  sim.stepFrames(240);
  const lowerAngle = sim.getJointAngle(owner, spec);
  assert.ok(lowerAngle < -28 && lowerAngle > -30.5, `lower stop missed: ${lowerAngle}`);
  sim.reset();
  sim.setJointConfig(owner, spec, { limitsEnabled: false, motorMode: 'off' }, false);
  const unlimited = sim.jointEntries[0].joint;
  assert.ok(unlimited.limitsMin() < -1e300 && unlimited.limitsMax() > 1e300, 'disabled limits are not native infinite range');
  sim.bodies.get(target).body.setAngvel(new THREE.Vector3(0, 0, 2), true);
  sim.stepFrames(90);
  assert.ok(Math.abs(sim.getJointAngle(owner, spec)) > 60, 'disabled limits blocked passive motion');
  sim.reset();
  const outside = await makeRevoluteFixture();
  outside.target.rotation.z = THREE.MathUtils.degToRad(80);
  outside.target.position.copy(anchorPosition(outside.owner, outside.spec.anchor))
    .sub(new THREE.Vector3(-0.5, 0, 0).applyQuaternion(worldRotation(outside.target)));
  outside.target.updateMatrixWorld(true);
  outside.sim.addObject(outside.target);
  outside.sim.setJointConfig(outside.owner, outside.spec, { limitsEnabled: true, lower: -30, upper: 40, motorMode: 'off' }, false);
  outside.sim.stepFrames(180);
  angleNear(outside.sim.getJointAngle(outside.owner, outside.spec), 40, 1, 'outside start pulled to upper stop');
  assertJointPose(outside.owner, outside.target, outside.spec);
  outside.sim.dispose();
  sim.setJointConfig(owner, spec, {
    limitsEnabled: true, lower: -20, upper: 25, motorMode: 'position', targetAngle: 100,
    stiffness: 200, damping: 30, maxTorque: 1000
  }, false);
  sim.stepFrames(240);
  angleNear(sim.getJointAngle(owner, spec), 25, 0.5, 'position target clamped to upper limit');
  sim.reset();
  sim.setJointConfig(owner, spec, { targetAngle: -100 }, false);
  sim.stepFrames(240);
  angleNear(sim.getJointAngle(owner, spec), -20, 0.5, 'position target clamped to lower limit');
});

await test('setJointConfig no-ops and invalid edits add no history; undo restores a legacy spec', async () => {
  const { sim, owner, spec, sceneManager } = await makeRevoluteFixture();
  const legacy = structuredClone(spec);
  sceneManager.clearHistory();
  const joint = sim.jointEntries[0].joint;
  assert.deepEqual(sim.setJointConfig(owner, spec, {}), DEFAULT_REVOLUTE);
  assert.deepEqual(sim.setJointConfig(owner, spec, { motorMode: 'off', targetVelocity: 0 }), DEFAULT_REVOLUTE);
  assert.equal(sceneManager.undoStack.length, 0, 'unchanged edit recorded history');
  assert.equal(sim.jointEntries[0].joint, joint);
  assert.throws(() => sim.setJointConfig(owner, spec, null), /joint/i);
  assert.throws(() => sim.setJointConfig(owner, spec, 42), /joint/i);
  assert.equal(sceneManager.undoStack.length, 0);
  assert.deepEqual(spec, legacy);
  sim.setJointConfig(owner, spec, { motorMode: 'velocity', targetVelocity: 90, maxTorque: 1000, damping: 0 });
  assert.equal(sceneManager.undoStack.length, 1);
  assert.equal(sceneManager.undoStack[0].description, 'Update joint motor / limits');
  sceneManager.undo();
  assert.deepEqual(spec, legacy, 'undo of the first motor edit must restore the exact legacy spec without added fields');
  assert.deepEqual(sim.getJointConfig(owner, spec), DEFAULT_REVOLUTE);
  sim.reset();
  sim.stepFrames(60);
  angleNear(sim.getJointAngle(owner, spec), 0, 1e-3, 'undo restored a passive legacy hinge');
  sceneManager.redo();
  assert.equal(spec.motorMode, 'velocity');
  assert.equal(spec.targetVelocity, 90);
  sim.reset();
  sim.stepFrames(60);
  angleNear(sim.getJointAngle(owner, spec), 90, 3, 'redo restored native velocity drive');
  sim.setJointConfig(owner, spec, { targetVelocity: 120 }, false);
  assert.equal(sceneManager.undoStack.length, 1, 'recordHistory=false still recorded');
  sim.reset();
  sim.stepFrames(60);
  angleNear(sim.getJointAngle(owner, spec), 120, 3, 'unrecorded edit still drives natively');
});

await test('repeated motor/limit undo redo restores native constraint behavior', async () => {
  const { sim, owner, spec, sceneManager } = await makeRevoluteFixture();
  sim.setJointConfig(owner, spec, { motorMode: 'velocity', targetVelocity: 90, maxTorque: 1000, damping: 0 }, false);
  sceneManager.clearHistory();
  sim.setJointConfig(owner, spec, { motorMode: 'position', targetAngle: 30, stiffness: 200, damping: 30 });
  sim.setJointConfig(owner, spec, { limitsEnabled: true, lower: -10, upper: 20 });
  assert.equal(sceneManager.undoStack.length, 2, 'each real edit must be one command');
  sim.reset(); sim.stepFrames(180);
  angleNear(sim.getJointAngle(owner, spec), 20, 0.5, 'limited position before undo');
  sceneManager.undo();
  assert.equal(spec.limitsEnabled, false);
  sim.reset(); sim.stepFrames(180);
  angleNear(sim.getJointAngle(owner, spec), 30, 0.5, 'undo limits restored unclamped position drive');
  sceneManager.undo();
  assert.equal(spec.motorMode, 'velocity');
  sim.reset(); sim.stepFrames(60);
  angleNear(sim.getJointAngle(owner, spec), 90, 3, 'undo position restored velocity drive');
  sceneManager.redo();
  assert.equal(spec.motorMode, 'position');
  sim.reset(); sim.stepFrames(180);
  angleNear(sim.getJointAngle(owner, spec), 30, 0.5, 'redo position drive');
  sceneManager.redo();
  assert.equal(spec.limitsEnabled, true);
  sim.reset(); sim.stepFrames(180);
  angleNear(sim.getJointAngle(owner, spec), 20, 0.5, 'redo limits clamp again');
});

await test('live motor update while playing pauses safely and preserves joint handle and velocities', async () => {
  const { sim, owner, target, spec, sceneManager } = await makeRevoluteFixture();
  sim.setJointConfig(owner, spec, { motorMode: 'velocity', targetVelocity: 90, maxTorque: 1000, damping: 0 }, false);
  sim.stepFrames(30);
  assert.equal(sim.play(), true);
  const entry = sim.jointEntries[0], joint = entry.joint, body = sim.bodies.get(target).body;
  const reference = entry.angleReference;
  const linear = { ...body.linvel() }, angular = { ...body.angvel() }, position = target.position.clone();
  sim.setJointConfig(owner, spec, { damping: 1, maxTorque: 500 });
  assert.equal(sim.isPlaying, false, 'config update did not pause playback');
  assert.equal(sim.jointEntries[0].joint, joint, 'config update recreated the native joint');
  assert.equal(sim.jointEntries[0].joint.handle, joint.handle);
  assert.equal(sim.jointEntries[0].angleReference, reference);
  assert.equal(sim.bodies.get(target).body, body);
  assert.deepEqual({ ...body.linvel() }, linear);
  assert.deepEqual({ ...body.angvel() }, angular);
  near(target.position, position, 1e-9);
  assert.equal(spec.damping, 1);
  const unrelated = makeCube(9); unrelated.position.x = 10;
  unrelated.userData.physics = sim.getConfig(unrelated);
  sceneManager.addObject(unrelated, null, false, false);
  assert.equal(sim.jointEntries[0].joint, joint, 'unrelated add recreated the motor joint');
  assert.deepEqual({ ...body.angvel() }, angular);
  sim.setConfig(unrelated, { mass: 4 });
  assert.equal(sim.jointEntries[0].joint, joint, 'unrelated edit recreated the motor joint');
  assert.deepEqual(sim.getJointConfig(owner, spec), { ...DEFAULT_REVOLUTE,
    motorMode: 'velocity', targetVelocity: 90, stiffness: 20, damping: 1, maxTorque: 500 });
  sim.stepFrames(30);
  assert.ok(target.position.distanceTo(position) > 0.05, 'preserved velocity did not continue moving');
  assertJointPose(owner, target, spec);
});

await test('ground rebuild, reset and real timeline bake retain motor/limits and restore source state', async () => {
  const timeline = new TimelineEngine({ fps: 30 });
  const { sim, owner, target, spec, sceneManager } = await makeRevoluteFixture({ timelineEngine: timeline });
  sim.setJointConfig(owner, spec, {
    motorMode: 'position', targetAngle: 40, stiffness: 200, damping: 30, maxTorque: 1000,
    limitsEnabled: true, lower: -50, upper: 50
  }, false);
  const config = sim.getJointConfig(owner, spec);
  const specBefore = structuredClone(spec);
  const ownerPosition = owner.position.clone(), targetPosition = target.position.clone();
  const targetRotation = target.quaternion.clone(), geometry = geometrySnapshot(target);
  assert.deepEqual(sim.bake({ fps: 30, frames: 30 }), { frames: 31, objects: 2 });
  const keys = timeline.getKeyframes(target);
  assert.equal(keys.length, 31);
  assert.ok(Math.abs(keys.at(-1).rotation.z - THREE.MathUtils.degToRad(40)) < 0.02, 'bake did not record driven angle');
  assert.ok(keys.some((key) => Math.abs(key.rotation.z) > 0.1), 'bake recorded a static hinge');
  assert.ok(target.position.equals(targetPosition) && target.quaternion.equals(targetRotation));
  assert.ok(owner.position.equals(ownerPosition));
  assert.equal(geometrySnapshot(target), geometry, 'bake mutated source geometry');
  assert.deepEqual(spec, specBefore, 'bake mutated the joint spec');
  assert.deepEqual(sim.getJointConfig(owner, spec), config);
  assert.equal(sim.jointCount, 1);
  assert.ok(!JSON.stringify(sceneManager.scene.toJSON()).includes('angleReference'));
  sim.reset();
  sim.stepFrames(60);
  near(target.position, new THREE.Vector3(keys.at(-1).position.x, keys.at(-1).position.y, keys.at(-1).position.z), 1e-4, 'post-bake deterministic replay');
  angleNear(sim.getJointAngle(owner, spec), THREE.MathUtils.radToDeg(keys.at(-1).rotation.z), 0.01, 'post-bake angle');
  const firstBake = JSON.stringify(keys);
  sim.reset();
  sim.bake({ fps: 30, frames: 30 });
  assert.equal(JSON.stringify(timeline.getKeyframes(target)), firstBake, 'repeated bake was not deterministic');
  sim.setGroundEnabled(true);
  assert.equal(sim.jointCount, 1);
  assert.deepEqual(sim.getJointConfig(owner, spec), config, 'ground rebuild lost motor/limits');
  sim.reset();
  sim.stepFrames(60);
  angleNear(sim.getJointAngle(owner, spec), 40, 0.5, 'ground rebuild retained native drive');
});

await test('duplicate remaps UUIDs and deep-copies motor/limit config independently', async () => {
  const { sim, owner, target, spec, sceneManager } = await makeRevoluteFixture();
  sim.setJointConfig(owner, spec, {
    motorMode: 'position', targetAngle: 30, stiffness: 200, damping: 30, maxTorque: 1000,
    limitsEnabled: true, lower: -40, upper: 40
  }, false);
  const [copyOwner, copyTarget] = sceneManager.duplicateObjects([owner, target], { x: 0, y: 0, z: 4 });
  const copySpec = copyOwner.userData.joints[0];
  assert.equal(copySpec.targetUuid, copyTarget.uuid);
  assert.notEqual(copySpec.targetUuid, target.uuid);
  assert.notEqual(copySpec, spec);
  assert.deepEqual(copySpec, { ...spec, targetUuid: copyTarget.uuid });
  assert.equal(sim.jointCount, 2);
  assert.equal(sim.bodyCount, 4);
  sim.setJointConfig(copyOwner, copySpec, { targetAngle: -20 }, false);
  assert.equal(spec.targetAngle, 30, 'clone config edit mutated the original');
  assert.equal(sim.getJointConfig(owner, spec).targetAngle, 30);
  assert.equal(sim.getJointConfig(copyOwner, copySpec).targetAngle, -20);
  assert.deepEqual(sim.getJointConfig(owner, spec), { ...sim.getJointConfig(copyOwner, copySpec), targetAngle: 30 });
  sim.stepFrames(240);
  angleNear(sim.getJointAngle(owner, spec), 30, 0.5, 'original motor after duplicate');
  angleNear(sim.getJointAngle(copyOwner, copySpec), -20, 0.5, 'clone motor independent');
  const single = sceneManager.duplicateObject(owner);
  assert.deepEqual(single.userData.joints, [], 'single-endpoint duplicate kept a joint to the original');
});

await test('real exporter project JSON roundtrip reverses body order and reproduces driven motion', async () => {
  const source = await makeRevoluteFixture();
  source.sim.setJointConfig(source.owner, source.spec, {
    motorMode: 'velocity', targetVelocity: 90, maxTorque: 1000, damping: 0,
    limitsEnabled: true, lower: -60, upper: 60
  }, false);
  const exporter = new StudioExporter({
    scene: source.sceneManager.scene, camera: new THREE.PerspectiveCamera(), sceneManager: source.sceneManager
  });
  const json = exporter.exportProjectJSON({ download: false });
  assert.ok(json.includes('"motorMode":"velocity"'));
  assert.ok(!json.includes('angleReference'));
  const data = JSON.parse(json);
  data.sceneGraph.object.children.reverse();
  const restored = makeJointManager();
  await restored.sim.init();
  restored.sim.setGravity(0, 0, 0);
  const importer = new StudioExporter({
    scene: restored.sceneManager.scene, camera: new THREE.PerspectiveCamera(), sceneManager: restored.sceneManager
  });
  await importer.importProjectJSON(JSON.stringify(data), { clearExisting: true });
  const copyOwner = restored.root.getObjectByProperty('uuid', source.owner.uuid);
  const copyTarget = restored.root.getObjectByProperty('uuid', source.target.uuid);
  assert.ok(copyOwner && copyTarget);
  assert.equal([...restored.sim.bodies.keys()][0], copyTarget, 'target must load before owner');
  assert.equal(restored.sim.jointCount, 1);
  const copySpec = restored.sim.getJoints(copyOwner)[0];
  assert.deepEqual(restored.sim.getJointConfig(copyOwner, copySpec), source.sim.getJointConfig(source.owner, source.spec));
  for (let i = 0; i < 12; i += 1) {
    source.sim.stepFrames(10); restored.sim.stepFrames(10);
    near(worldPosition(copyTarget), worldPosition(source.target), 1e-5, 'exported motor trajectory');
    sameRotation(worldRotation(copyTarget), worldRotation(source.target), 1e-5);
    angleNear(restored.sim.getJointAngle(copyOwner, copySpec), source.sim.getJointAngle(source.owner, source.spec), 1e-4, 'exported live angle');
    assertJointPose(copyOwner, copyTarget, copySpec);
  }
});

await test('joint angle readout is creation-relative for rotated bodies on x/y/z axes', async () => {
  const results = [];
  for (const axis of ['x', 'y', 'z']) {
    const { sim, owner, target, spec } = await makeRevoluteFixture({
      axis, ownerRotation: [0.35, -0.6, 0.2], targetRotation: [-0.4, 0.25, 0.9]
    });
    const creationRaw = rawHingeAngle(owner, target, spec);
    const creationAngle = sim.getJointAngle(owner, spec);
    sim.setJointConfig(owner, spec, { motorMode: 'velocity', targetVelocity: 90, maxTorque: 1000, damping: 0 }, false);
    sim.stepFrames(30);
    const expected = wrapDegrees(rawHingeAngle(owner, target, spec) - creationRaw);
    results.push({ axis, creationAngle, expected, actual: sim.getJointAngle(owner, spec) });
    sim.dispose();
  }
  assert.ok(results.every((r) => Math.abs(r.creationAngle) < 1e-6
    && Math.abs(wrapDegrees(r.actual - r.expected)) < 0.5
    && Math.abs(r.expected - 45) < 3),
  `creation-relative angle readout failed: ${JSON.stringify(results)}`);
});

await test('angle reads and bake leave source transforms, geometry, specs and runtime reference untouched', async () => {
  const timeline = new TimelineEngine({ fps: 30 });
  const { sim, owner, target, spec, sceneManager } = await makeRevoluteFixture({ timelineEngine: timeline });
  sim.setJointConfig(owner, spec, { motorMode: 'position', targetAngle: 25, stiffness: 200, damping: 30, maxTorque: 1000 }, false);
  const userData = owner.userData, specBefore = structuredClone(spec);
  const position = target.position.clone(), quaternion = target.quaternion.clone(), geometry = geometrySnapshot(target);
  for (let i = 0; i < 3; i += 1) {
    sim.getJointAngle(owner, spec); sim.getJointConfig(owner, spec);
    assert.ok(target.position.equals(position) && target.quaternion.equals(quaternion));
    assert.equal(geometrySnapshot(target), geometry);
    assert.deepEqual(spec, specBefore);
    assert.equal(owner.userData, userData);
  }
  sim.stepFrames(30);
  const moved = target.position.clone(), movedRotation = target.quaternion.clone();
  sim.bake({ fps: 30, frames: 10 });
  // bake() restores the source pose and then seeks the real timeline to frame 0;
  // TimelineEngine stores keyframes at 5-decimal precision, so compare within that quantum.
  near(target.position, moved, 1e-4, 'bake restored the pose it started from');
  sameRotation(target.quaternion, movedRotation, 1e-4);
  assert.deepEqual(spec, specBefore);
  assert.equal(geometrySnapshot(target), geometry);
  assert.ok(Number.isFinite(sim.jointEntries[0].angleReference));
  const json = JSON.stringify(sceneManager.scene.toJSON());
  assert.ok(!json.includes('angleReference'), 'runtime-only reference serialized');
  const exporter = new StudioExporter({ scene: sceneManager.scene, camera: new THREE.PerspectiveCamera(), sceneManager });
  exporter.exportProjectJSON({ download: false });
  assert.equal(owner.userData, userData, 'export did not restore userData identity');
  assert.deepEqual(spec, specBefore);
  sim.reset();
  // bake() cleared the pre-step snapshot and seeked the timeline to the pose it
  // started from, so reset rebuilds from that post-bake source pose.
  near(target.position, moved, 1e-4, 'reset after bake keeps the restored source pose');
  sameRotation(target.quaternion, movedRotation, 1e-4);
});

await test('adversarial physics inputs: NaN gravity, bad stepFrames, degenerate convex colliders & NaN bake', async () => {
  const sim = await makeManager().init();
  const cube = makeCube(5);
  const zeroScale = makeCube(5); zeroScale.scale.set(0, 0, 0); zeroScale.position.x = 2;
  const emptyMesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial()); emptyMesh.position.set(-2, 5, 0);
  const convex = new THREE.Mesh(new THREE.IcosahedronGeometry(0.6, 1), new THREE.MeshStandardMaterial()); convex.position.set(4, 5, 0);
  const zeroConvex = makeCube(5); zeroConvex.scale.set(0, 0, 0); zeroConvex.position.set(6, 5, 0);
  const collinearGeom = new THREE.BufferGeometry();
  collinearGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3]), 3));
  const collinearConvex = new THREE.Mesh(collinearGeom, new THREE.MeshStandardMaterial());
  collinearConvex.position.set(8, 5, 0);

  sim.addObject(cube);
  sim.addObject(zeroScale);
  sim.addObject(emptyMesh);
  sim.setConfig(convex, { collider: 'convex' });
  sim.setConfig(zeroConvex, { collider: 'convex' });
  sim.setConfig(collinearConvex, { collider: 'convex' });

  sim.stepFrames(0);
  sim.stepFrames(-5);
  sim.stepFrames(NaN);
  assert.equal(cube.position.y, 5);

  sim.setGravity(NaN, Infinity, -Infinity);
  assert.deepEqual(sim.gravity, { x: 0, y: -9.81, z: 0 }, 'non-finite gravity must preserve previous finite gravity');
  sim.stepFrames(20);
  assert.ok(cube.position.toArray().every(Number.isFinite));
  assert.ok(zeroScale.position.toArray().every(Number.isFinite));
  assert.ok(cube.position.y < 4.5, 'cube should fall under preserved gravity');
  assert.ok(convex.position.y < 4.5, 'convex collider should fall under preserved gravity');
  assert.ok(zeroConvex.position.y < 4.5, 'zero-scale convex fallback should fall cleanly');
  assert.ok(collinearConvex.position.y < 4.5, 'collinear convex fallback should fall cleanly');
  assert.equal(sim.bake({ fps: 30, frames: 10 }), null, 'bake without timelineEngine returns null');

  const keyframed = [];
  const fakeTimeline = {
    insertKeyframe(obj, frame) { keyframed.push([obj, frame]); },
    seekToFrame() {}
  };
  const simWithTimeline = await makeManager({ timelineEngine: fakeTimeline }).init();
  const body = makeCube(5);
  simWithTimeline.addObject(body);
  const baked = simWithTimeline.bake({ fps: NaN, frames: Infinity });
  assert.ok(baked && Number.isFinite(baked.frames) && baked.frames === 61, 'bake with NaN/Infinity must fall back to finite defaults');
  assert.ok(keyframed.length >= 61, 'bake with NaN/Infinity must record finite keyframes');
});

console.log(`\n${passed + failed} SIMULATION TESTS: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
