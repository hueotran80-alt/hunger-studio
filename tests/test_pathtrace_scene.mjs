/**
 * Deterministic Three r160 snapshot contract; no renderer or browser required.
 * Run: node --import ./tests/three-resolve-hooks.mjs tests/test_pathtrace_scene.mjs
 */
import assert from 'node:assert/strict';
import * as THREE from 'three';
import * as tracing from '../js/render/pathtrace-scene.js';
import { PathTracingSceneGenerator } from '../vendor/three-gpu-pathtracer/index.module.js';

const failures = [];
let total = 0;
let passed = 0;
let snapshots = [];

function test(name, fn) {
  total++;
  try {
    try {
      fn();
    } finally {
      for (const result of snapshots) result.dispose?.();
      snapshots = [];
    }
    passed++;
    console.log(`ok   ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`FAIL ${name}\n     ${error.stack || error.message}`);
  }
}

function snapshot(options) {
  const result = tracing.buildTracingScene(options);
  snapshots.push(result);
  return result;
}

function close(actual, expected, message, tolerance = 1e-6) {
  assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance,
    `${message}: ${actual} != ${expected} (tolerance ${tolerance})`);
}

function arrayClose(actual, expected, message, tolerance = 1e-6) {
  assert.equal(actual.length, expected.length, `${message}: length`);
  for (let i = 0; i < expected.length; i++) close(actual[i], expected[i], `${message}[${i}]`, tolerance);
}

function matrixClose(actual, expected, message) {
  arrayClose(actual.elements, expected.elements, message);
}

function meshes(scene) {
  const result = [];
  scene.traverse((node) => { if (node.isMesh) result.push(node); });
  return result;
}

function lights(scene) {
  const result = [];
  scene.traverse((node) => { if (node.isLight) result.push(node); });
  return result;
}

function onlyMesh(result) {
  const found = meshes(result.scene);
  assert.equal(found.length, 1, 'expected exactly one snapshot mesh');
  return found[0];
}

function geometry(triangles = 1, indexed = true) {
  const g = new THREE.BufferGeometry();
  const positions = new Float32Array(indexed ? 9 : triangles * 9);
  for (let offset = 0; offset < positions.length; offset += 9) {
    positions.set([0, 0, 0, 1, 0, 0, 0, 1, 0], offset);
  }
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  if (indexed) {
    const indices = new Uint32Array(triangles * 3);
    for (let i = 0; i < indices.length; i++) indices[i] = i % 3;
    g.setIndex(new THREE.BufferAttribute(indices, 1));
  }
  g.computeVertexNormals();
  return g;
}

function mesh(material = new THREE.MeshStandardMaterial(), g = geometry()) {
  return new THREE.Mesh(g, material);
}

function sceneWith(...objects) {
  const scene = new THREE.Scene();
  scene.add(...objects);
  return scene;
}

function skinGeometry(g = geometry(), indices = [0, 0, 0, 0], weights = [1, 0, 0, 0]) {
  const count = g.attributes.position.count;
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(
    Array.from({ length: count }, () => indices).flat(), 4));
  g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(
    Array.from({ length: count }, () => weights).flat(), 4));
  return g;
}

function boundSkin(g = skinGeometry(), material = new THREE.MeshStandardMaterial(), bones = [new THREE.Bone()]) {
  const object = new THREE.SkinnedMesh(g, material);
  object.add(...bones);
  object.bind(new THREE.Skeleton(bones));
  return { object, bone: bones[0], skeleton: object.skeleton };
}

function setTangents(g, direction = [1, 0, 0], handedness = [1, -1, 1]) {
  g.setAttribute('tangent', new THREE.Float32BufferAttribute(
    Array.from({ length: g.attributes.position.count }, (_, i) =>
      [...direction, handedness[i % handedness.length]]).flat(), 4));
  return g;
}

function assertStaticSkin(copy, source) {
  assert.equal(copy.type, 'Mesh');
  assert.ok(copy.isMesh && !copy.isSkinnedMesh && !copy.isInstancedMesh);
  assert.equal(copy.skeleton, undefined, 'snapshot must not retain the source skeleton');
  assert.equal(copy.children.length, 0, 'snapshot must not clone the bone hierarchy');
  assert.deepEqual(copy.animations, [], 'snapshot must not retain animation clips');
  assert.notEqual(copy.geometry, source.geometry, 'baked geometry must be owned');
  assert.equal(copy.geometry.getAttribute('skinIndex'), undefined);
  assert.equal(copy.geometry.getAttribute('skinWeight'), undefined);
  assert.deepEqual(copy.geometry.morphAttributes, {});
  assert.ok(!copy.morphTargetInfluences?.length, 'morphs must not be reapplied');
  assert.equal(copy.matrixAutoUpdate, false);
}

function attributeVector(g, name, index) {
  const attribute = g.getAttribute(name);
  return Array.from(attribute.array.slice(index * attribute.itemSize, (index + 1) * attribute.itemSize));
}

function assertWorldVertices(copy, expected, message) {
  copy.updateWorldMatrix(true, false);
  for (let i = 0; i < expected.length; i++) {
    const vertex = new THREE.Vector3().fromBufferAttribute(copy.geometry.attributes.position, i);
    arrayClose(vertex.applyMatrix4(copy.matrixWorld).toArray(), expected[i], `${message} vertex ${i}`);
  }
}

function hdrEnvironment() {
  const texture = new THREE.DataTexture(
    new Uint16Array([0x3c00, 0x3800, 0x3400, 0x3c00, 0x3800, 0x3c00, 0x3400, 0x3c00]),
    2, 1, THREE.RGBAFormat, THREE.HalfFloatType
  );
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.colorSpace = THREE.LinearSRGBColorSpace;
  return texture;
}

function disposalCounts(resources) {
  const counts = new Map();
  for (const resource of new Set(resources)) {
    counts.set(resource, 0);
    resource.addEventListener('dispose', () => counts.set(resource, counts.get(resource) + 1));
  }
  return counts;
}

function assertUndisposed(counts) {
  for (const [resource, count] of counts) {
    assert.equal(count, 0, `source ${resource.type || resource.constructor.name} was disposed`);
  }
}

const exclusionFlags = [
  'isSystemObject', 'isHelper', 'isLightHelper', 'isCameraPart', 'isCameraObject'
];

test('scene background Color is cloned independently while non-Color background becomes null', () => {
  const srcColor = new THREE.Scene();
  srcColor.background = new THREE.Color(0x112233);
  const resColor = snapshot({ scene: srcColor });
  assert.ok(resColor.scene.background?.isColor);
  assert.notEqual(resColor.scene.background, srcColor.background);
  assert.equal(resColor.scene.background.getHex(), 0x112233);
  resColor.scene.background.setHex(0xffffff);
  assert.equal(srcColor.background.getHex(), 0x112233);

  const srcTex = new THREE.Scene();
  srcTex.background = new THREE.Texture();
  const resTex = snapshot({ scene: srcTex });
  assert.equal(resTex.scene.background, null);
});

test('empty scene returns all counters and two fallback directional lights', () => {
  const source = new THREE.Scene();
  const result = snapshot({ scene: source });
  assert.ok(result.scene.isScene);
  assert.notEqual(result.scene, source);
  assert.equal(typeof result.dispose, 'function');
  for (const key of ['meshCount', 'bakedSkinned', 'skippedSkinned', 'skippedMaterial', 'triangleCount']) {
    assert.equal(result[key], 0, key);
  }
  assert.equal(result.environmentSkipped, false);
  assert.equal(result.scene.environment, null);
  assert.equal(result.lightCount, 2);
  assert.equal(lights(result.scene).length, 2);
  assert.ok(lights(result.scene).every((light) => light.isDirectionalLight));
  assert.equal(source.children.length, 0, 'fallback lights must not be added to the source');
});

test('rootContainer scopes meshes without reparenting source objects', () => {
  const root = new THREE.Group();
  const included = mesh();
  const outside = mesh();
  root.add(included);
  const source = sceneWith(root, outside);
  const result = snapshot({ scene: source, rootContainer: root });
  assert.equal(result.meshCount, 1);
  assert.equal(result.triangleCount, 1);
  assert.equal(included.parent, root);
  assert.equal(outside.parent, source);
  assert.deepEqual(source.children, [root, outside]);
});

test('invisible meshes and descendants of invisible groups do not enter counters', () => {
  const visible = mesh();
  const hidden = mesh();
  hidden.visible = false;
  const group = new THREE.Group();
  group.visible = false;
  group.add(mesh(), new THREE.SkinnedMesh(geometry(), new THREE.MeshStandardMaterial()),
    mesh(new THREE.MeshBasicMaterial()));
  const result = snapshot({ scene: sceneWith(visible, hidden, group) });
  assert.equal(result.meshCount, 1);
  assert.equal(result.triangleCount, 1);
  assert.equal(result.skippedSkinned, 0);
  assert.equal(result.skippedMaterial, 0);
});

test('an invisible rootContainer is not exempt from visibility filtering', () => {
  const root = new THREE.Group();
  root.visible = false;
  root.add(mesh());
  const result = snapshot({ scene: sceneWith(root), rootContainer: root });
  assert.equal(result.meshCount, 0);
  assert.equal(result.triangleCount, 0);
});

test('invisible ancestors above rootContainer still suppress its meshes', () => {
  const outer = new THREE.Group();
  outer.visible = false;
  const root = new THREE.Group();
  root.add(mesh());
  outer.add(root);
  const result = snapshot({ scene: sceneWith(outer), rootContainer: root });
  assert.equal(result.meshCount, 0);
});

for (const flag of exclusionFlags) {
  test(`${flag}: excludes a marked mesh and descendants of a marked ancestor`, () => {
    const marked = mesh();
    marked.userData[flag] = true;
    const group = new THREE.Group();
    group.userData[flag] = true;
    group.add(mesh());
    const result = snapshot({ scene: sceneWith(mesh(), marked, group) });
    assert.equal(result.meshCount, 1);
    assert.equal(result.triangleCount, 1);
    assert.equal(result.skippedMaterial, 0);
  });
}

for (const [name, makeAncestor] of [
  ['Bone', () => new THREE.Bone()],
  ['TransformControls', () => Object.assign(new THREE.Group(), { isTransformControls: true })],
  ['Camera', () => new THREE.PerspectiveCamera()]
]) {
  test(`${name} ancestors exclude attached PBR meshes`, () => {
    const ancestor = makeAncestor();
    ancestor.add(mesh());
    const result = snapshot({ scene: sceneWith(mesh(), ancestor) });
    assert.equal(result.meshCount, 1);
    assert.equal(result.triangleCount, 1);
  });
}

test('rootContainer itself is exempt from system/helper/camera flags, not its children', () => {
  const root = new THREE.Group();
  for (const flag of exclusionFlags) root.userData[flag] = true;
  const rejected = new THREE.Group();
  rejected.userData.isHelper = true;
  rejected.add(mesh());
  root.add(mesh(), rejected);
  const result = snapshot({ scene: sceneWith(root), rootContainer: root });
  assert.equal(result.meshCount, 1);
});

test('system ancestors above rootContainer are not covered by its exemption', () => {
  const outer = new THREE.Group();
  outer.userData.isSystemObject = true;
  const root = new THREE.Group();
  root.add(mesh());
  outer.add(root);
  const result = snapshot({ scene: sceneWith(outer), rootContainer: root });
  assert.equal(result.meshCount, 0);
});

test('full world matrix preserves hierarchy-induced shear with matrixAutoUpdate disabled', () => {
  const outer = new THREE.Group();
  outer.position.set(7, -2, 5);
  outer.rotation.set(0.2, 0.3, -0.1);
  outer.scale.set(2, 3, 0.5);
  const root = new THREE.Group();
  root.rotation.set(0.4, -0.6, 0.2);
  const object = mesh();
  object.position.set(1, 2, -3);
  object.rotation.set(-0.2, 0.5, 0.7);
  root.add(object);
  outer.add(root);
  const source = sceneWith(outer);
  source.updateMatrixWorld(true);
  const expected = object.matrixWorld.clone();
  const p = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  expected.decompose(p, q, s);
  const lossy = new THREE.Matrix4().compose(p, q, s);
  assert.ok(expected.elements.some((value, i) => Math.abs(value - lossy.elements[i]) > 1e-3),
    'fixture must actually contain shear');
  const copy = onlyMesh(snapshot({ scene: source, rootContainer: root }));
  assert.equal(copy.matrixAutoUpdate, false);
  assert.notEqual(copy.matrix, object.matrixWorld);
  matrixClose(copy.matrix, expected, 'local snapshot matrix');
  copy.updateWorldMatrix(true, true);
  matrixClose(copy.matrixWorld, expected, 'snapshot world matrix');
});

test('manual matrices, reflections and stale source world transforms are preserved', () => {
  const root = new THREE.Group();
  root.position.set(4, 5, 6);
  const object = mesh();
  object.matrixAutoUpdate = false;
  object.matrix.set(-2, 0.4, 0, 3, 0, 1, 0.2, -1, 0, 0, 0.5, 2, 0, 0, 0, 1);
  root.add(object);
  const result = snapshot({ scene: sceneWith(root), rootContainer: root });
  const expected = new THREE.Matrix4().makeTranslation(4, 5, 6).multiply(object.matrix);
  const copy = onlyMesh(result);
  matrixClose(copy.matrix, expected, 'fresh world transform');
  object.matrix.makeTranslation(100, 100, 100);
  root.position.set(-40, -50, -60);
  root.updateWorldMatrix(true, true);
  result.scene.updateMatrixWorld(true);
  matrixClose(copy.matrixWorld, expected, 'snapshot remains independent of source transforms');
});

test('geometry attributes, index, groups and drawRange are cloned without source mutation', () => {
  const g = geometry(2);
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1], 2));
  g.addGroup(0, 3, 0);
  g.addGroup(3, 3, 1);
  g.setDrawRange(0, 6);
  const object = mesh(new THREE.MeshStandardMaterial(), g);
  const copy = onlyMesh(snapshot({ scene: sceneWith(object) }));
  assert.notEqual(copy.geometry, g);
  for (const name of ['position', 'normal', 'uv']) {
    assert.notEqual(copy.geometry.attributes[name], g.attributes[name], name);
    assert.notEqual(copy.geometry.attributes[name].array, g.attributes[name].array, `${name} data`);
    arrayClose(copy.geometry.attributes[name].array, g.attributes[name].array, name);
  }
  assert.notEqual(copy.geometry.index, g.index);
  assert.notEqual(copy.geometry.index.array, g.index.array);
  assert.deepEqual(Array.from(copy.geometry.index.array), Array.from(g.index.array));
  assert.deepEqual(copy.geometry.groups, g.groups);
  assert.deepEqual(copy.geometry.drawRange, g.drawRange);
  copy.geometry.attributes.position.setX(0, 99);
  copy.geometry.index.setX(0, 2);
  copy.geometry.groups[0].start = 3;
  assert.equal(g.attributes.position.getX(0), 0);
  assert.equal(g.index.getX(0), 0);
  assert.equal(g.groups[0].start, 0);
});

test('MeshStandardMaterial is a detached PBR clone with equivalent properties', () => {
  const material = new THREE.MeshStandardMaterial({
    color: 0x123456, emissive: 0x234567, emissiveIntensity: 0.7,
    roughness: 0.31, metalness: 0.82, opacity: 0.6, transparent: true,
    side: THREE.DoubleSide, alphaTest: 0.15
  });
  const copy = onlyMesh(snapshot({ scene: sceneWith(mesh(material)) })).material;
  assert.ok(copy.isMeshStandardMaterial);
  assert.notEqual(copy, material);
  assert.notEqual(copy.color, material.color);
  assert.notEqual(copy.emissive, material.emissive);
  arrayClose(copy.color.toArray(), material.color.toArray(), 'color');
  arrayClose(copy.emissive.toArray(), material.emissive.toArray(), 'emissive');
  for (const key of ['roughness', 'metalness', 'emissiveIntensity', 'opacity', 'transparent', 'side', 'alphaTest']) {
    assert.equal(copy[key], material[key], key);
  }
  copy.color.setHex(0xffffff);
  copy.roughness = 0.99;
  assert.equal(material.color.getHex(), 0x123456);
  assert.equal(material.roughness, 0.31);
});

test('MeshPhysicalMaterial keeps transmission, IOR, clearcoat and other physical properties', () => {
  const material = new THREE.MeshPhysicalMaterial({
    color: 0xabcdef, roughness: 0.2, metalness: 0.4, transmission: 0.65,
    thickness: 0.8, ior: 1.42, clearcoat: 0.7, clearcoatRoughness: 0.25,
    sheen: 0.3, sheenRoughness: 0.6, attenuationColor: 0x456789, attenuationDistance: 3
  });
  const copy = onlyMesh(snapshot({ scene: sceneWith(mesh(material)) })).material;
  assert.ok(copy.isMeshPhysicalMaterial);
  assert.notEqual(copy, material);
  for (const key of ['transmission', 'thickness', 'ior', 'clearcoat', 'clearcoatRoughness',
    'sheen', 'sheenRoughness', 'attenuationDistance']) assert.equal(copy[key], material[key], key);
  assert.notEqual(copy.attenuationColor, material.attenuationColor);
  arrayClose(copy.attenuationColor.toArray(), material.attenuationColor.toArray(), 'attenuationColor');
});

test('all standard and physical texture slots contain clones, while images may be shared', () => {
  const material = new THREE.MeshPhysicalMaterial();
  const slots = ['map', 'alphaMap', 'aoMap', 'bumpMap', 'normalMap', 'displacementMap',
    'roughnessMap', 'metalnessMap', 'emissiveMap', 'envMap', 'lightMap',
    'clearcoatMap', 'clearcoatNormalMap', 'clearcoatRoughnessMap', 'transmissionMap',
    'thicknessMap', 'sheenColorMap', 'sheenRoughnessMap', 'specularColorMap',
    'specularIntensityMap', 'iridescenceMap', 'iridescenceThicknessMap', 'anisotropyMap'];
  for (const slot of slots) {
    const texture = new THREE.DataTexture(new Uint8Array([64, 128, 192, 255]), 1, 1);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.MirroredRepeatWrapping;
    texture.offset.set(0.1, 0.2);
    texture.repeat.set(2, 3);
    texture.rotation = 0.4;
    texture.channel = 0;
    texture.colorSpace = THREE.SRGBColorSpace;
    material[slot] = texture;
  }
  const copy = onlyMesh(snapshot({ scene: sceneWith(mesh(material)) })).material;
  for (const slot of slots) {
    const original = material[slot];
    const cloned = copy[slot];
    assert.ok(cloned?.isTexture, slot);
    assert.notEqual(cloned, original, slot);
    for (const key of ['wrapS', 'wrapT', 'rotation', 'channel', 'colorSpace']) {
      assert.equal(cloned[key], original[key], `${slot}.${key}`);
    }
    arrayClose(cloned.offset.toArray(), original.offset.toArray(), `${slot}.offset`);
    arrayClose(cloned.repeat.toArray(), original.repeat.toArray(), `${slot}.repeat`);
    assert.deepEqual(Array.from(cloned.image.data), Array.from(original.image.data), `${slot}.image`);
    cloned.offset.x = 9;
    assert.equal(original.offset.x, 0.1, `${slot}: source texture transform changed`);
  }
});

test('PBR material arrays preserve every entry, order and geometry material groups', () => {
  const materials = [new THREE.MeshStandardMaterial({ color: 0xff0000 }),
    new THREE.MeshPhysicalMaterial({ color: 0x0000ff, transmission: 0.5 })];
  const g = geometry(2);
  g.addGroup(0, 3, 0);
  g.addGroup(3, 3, 1);
  const result = snapshot({ scene: sceneWith(mesh(materials, g)) });
  const copy = onlyMesh(result);
  assert.equal(result.meshCount, 1);
  assert.equal(result.triangleCount, 2);
  assert.ok(Array.isArray(copy.material));
  assert.notEqual(copy.material, materials);
  assert.equal(copy.material.length, 2);
  assert.ok(copy.material[0].isMeshStandardMaterial);
  assert.ok(copy.material[1].isMeshPhysicalMaterial);
  for (let i = 0; i < materials.length; i++) {
    assert.notEqual(copy.material[i], materials[i]);
    assert.equal(copy.material[i].color.getHex(), materials[i].color.getHex());
  }
  assert.deepEqual(copy.geometry.groups, g.groups);
});

test('MatCap display material recovers scalar __originalMaterial without altering display', () => {
  const original = new THREE.MeshPhysicalMaterial({ roughness: 0.21, transmission: 0.4 });
  const display = new THREE.MeshMatcapMaterial();
  const object = mesh(display);
  object.userData.__originalMaterial = original;
  const result = snapshot({ scene: sceneWith(object) });
  const copy = onlyMesh(result);
  assert.ok(copy.material.isMeshPhysicalMaterial);
  assert.notEqual(copy.material, original);
  assert.equal(copy.material.roughness, 0.21);
  assert.equal(copy.material.transmission, 0.4);
  assert.equal(result.skippedMaterial, 0);
  assert.equal(object.material, display);
  assert.equal(object.userData.__originalMaterial, original);
});

test('MatCap display material recovers array __originalMaterial with textures and groups', () => {
  const texture = new THREE.Texture({ width: 1, height: 1 });
  const original = [new THREE.MeshStandardMaterial({ map: texture }),
    new THREE.MeshPhysicalMaterial({ transmission: 0.7 })];
  const display = [new THREE.MeshMatcapMaterial(), new THREE.MeshMatcapMaterial()];
  const g = geometry(2);
  g.addGroup(0, 3, 0);
  g.addGroup(3, 3, 1);
  const object = mesh(display, g);
  object.userData.__originalMaterial = original;
  const result = snapshot({ scene: sceneWith(object) });
  const copy = onlyMesh(result);
  assert.ok(Array.isArray(copy.material));
  assert.equal(copy.material.length, 2);
  assert.notEqual(copy.material[0], original[0]);
  assert.notEqual(copy.material[0].map, texture);
  assert.equal(copy.material[1].transmission, 0.7);
  assert.deepEqual(copy.geometry.groups, g.groups);
  assert.equal(result.skippedMaterial, 0);
  assert.equal(object.material, display);
  assert.equal(object.userData.__originalMaterial, original);
});

test('unsupported scalar materials are skipped once each and do not consume triangles', () => {
  const unsupported = [new THREE.MeshBasicMaterial(), new THREE.MeshPhongMaterial(),
    new THREE.MeshMatcapMaterial(), new THREE.ShaderMaterial()];
  const result = snapshot({ scene: sceneWith(mesh(), ...unsupported.map((m) => mesh(m, geometry(3)))) });
  assert.equal(result.meshCount, 1);
  assert.equal(result.skippedMaterial, unsupported.length);
  assert.equal(result.triangleCount, 1);
});

test('mixed unsupported or empty material arrays are skipped as whole meshes', () => {
  const mixed = [new THREE.MeshStandardMaterial(), new THREE.MeshBasicMaterial()];
  const result = snapshot({ scene: sceneWith(mesh(mixed, geometry(2)), mesh([]), mesh()) });
  assert.equal(result.meshCount, 1);
  assert.equal(result.skippedMaterial, 2);
  assert.equal(result.triangleCount, 1);
});

test('unsupported skin material is counted before incomplete rig checks, with source rig intact', () => {
  const { object: incomplete, bone, skeleton } = boundSkin(geometry());
  const { object: unsupportedValid } = boundSkin(skinGeometry(), new THREE.MeshBasicMaterial());
  const { object: unsupportedIncomplete } = boundSkin(geometry(), new THREE.MeshBasicMaterial());
  const result = snapshot({ scene: sceneWith(incomplete, unsupportedValid, unsupportedIncomplete, mesh()) });
  assert.equal(result.skippedSkinned, 1);
  assert.equal(result.skippedMaterial, 2);
  assert.equal(result.bakedSkinned, 0);
  assert.equal(result.meshCount, 1);
  assert.equal(result.triangleCount, 1);
  assert.equal(incomplete.skeleton, skeleton);
  assert.equal(bone.parent, incomplete);
});

for (const Material of [THREE.MeshStandardMaterial, THREE.MeshPhysicalMaterial]) {
  test(`${Material.name}: current bone rotation and translation bake into an ordinary owned Mesh`, () => {
    const { object, bone } = boundSkin(setTangents(skinGeometry()), new Material());
    bone.rotation.x = Math.PI / 2;
    bone.position.set(2, 3, 4);
    const result = snapshot({ scene: sceneWith(object) });
    const copy = onlyMesh(result);
    assertStaticSkin(copy, object);
    assert.equal(result.bakedSkinned, 1);
    assert.equal(result.skippedSkinned, 0);
    assert.equal(result.skippedMaterial, 0);
    assert.equal(result.meshCount, 1);
    assert.equal(result.triangleCount, 1);
    arrayClose(copy.geometry.attributes.position.array, [2, 3, 4, 3, 3, 4, 2, 3, 5], 'posed positions');
    for (let i = 0; i < 3; i++) {
      arrayClose(attributeVector(copy.geometry, 'normal', i), [0, -1, 0], 'posed normal');
      arrayClose(attributeVector(copy.geometry, 'tangent', i), [1, 0, 0, i === 1 ? -1 : 1], 'posed tangent');
    }
    assert.ok(copy.material instanceof Material);
    assert.notEqual(copy.material, object.material);
    arrayClose(object.geometry.attributes.position.array, [0, 0, 0, 1, 0, 0, 0, 1, 0], 'source base pose');
  });
}

test('attached skin uses fresh world inverse, preserves stale source bind inverse and full affine world matrix', () => {
  const parent = new THREE.Group();
  const bone = new THREE.Bone();
  bone.position.x = 1;
  const object = new THREE.SkinnedMesh(skinGeometry(), new THREE.MeshStandardMaterial());
  object.position.set(1, 2, 0);
  object.add(bone);
  parent.add(object);
  parent.updateMatrixWorld(true);
  object.bind(new THREE.Skeleton([bone]));
  const bind = object.bindMatrix.clone();
  const inverse = object.bindMatrixInverse;
  inverse.makeTranslation(90, -80, 70);
  const staleInverse = inverse.clone();
  parent.matrixAutoUpdate = false;
  parent.matrix.set(2, 0.5, 0, 10, 0, 3, 0, -3, 0, 0, 4, 5, 0, 0, 0, 1);
  object.rotation.z = Math.PI / 2;
  bone.rotation.z = Math.PI / 2;
  const result = snapshot({ scene: sceneWith(parent), rootContainer: object });
  const copy = onlyMesh(result);
  // Rotation about the bone's bind pivot (1, 0, 0): (x, y) -> (1-y, x-1).
  arrayClose(copy.geometry.attributes.position.array, [1, -1, 0, 1, 0, 0, 0, -1, 0], 'attached local pose');
  const expectedWorld = new THREE.Matrix4().set(
    0.5, -2, 0, 13, 3, 0, 0, 3, 0, 0, 4, 5, 0, 0, 0, 1);
  matrixClose(copy.matrix, expectedWorld, 'full sheared world matrix');
  matrixClose(copy.matrixWorld, expectedWorld, 'full snapshot world matrix');
  assertWorldVertices(copy, [[15.5, 6, 5], [13.5, 6, 5], [15, 3, 5]], 'attached world pose');
  assert.equal(object.bindMatrixInverse, inverse);
  matrixClose(object.bindMatrixInverse, staleInverse, 'source stale inverse is not repaired in place');
  matrixClose(object.bindMatrix, bind, 'source bind matrix');
  assert.equal(result.bakedSkinned, 1);
  assertStaticSkin(copy, object);
});

test('detached skin refreshes external bone ancestors and uses bind inverse rather than mesh world inverse', () => {
  const external = new THREE.Group();
  external.position.x = 10;
  const anchor = new THREE.Bone();
  anchor.position.x = 2;
  const driver = new THREE.Bone();
  driver.position.y = 1;
  anchor.add(driver);
  external.add(anchor);
  external.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton([driver]);
  const object = new THREE.SkinnedMesh(setTangents(skinGeometry()), new THREE.MeshPhysicalMaterial());
  object.bindMode = THREE.DetachedBindMode;
  const bind = new THREE.Matrix4().makeRotationZ(Math.PI / 2).setPosition(5, 0, 0);
  object.bind(skeleton, bind);
  object.bindMatrixInverse.makeTranslation(90, 80, 70);
  const staleInverse = object.bindMatrixInverse.clone();
  const inverseAtRest = skeleton.boneInverses[0].clone();
  const boneMatrices = Array.from(skeleton.boneMatrices);
  object.position.set(3, 4, 5);
  object.scale.set(2, 3, 4);
  external.position.set(20, -2, 1);
  anchor.rotation.z = Math.PI / 2;
  driver.rotation.x = Math.PI / 2;
  const result = snapshot({ scene: sceneWith(object) });
  const copy = onlyMesh(result);
  // Bind maps (x,y,z) -> (5-y,x,z); the posed external hierarchy yields
  // (21+z,-9-y,x), then inverse bind maps this to (-9-y,-16-z,x).
  arrayClose(copy.geometry.attributes.position.array, [-9, -16, 0, -9, -16, 1, -10, -16, 0], 'detached local pose');
  assertWorldVertices(copy, [[-15, -44, 5], [-15, -44, 9], [-17, -44, 5]], 'detached world pose');
  for (let i = 0; i < 3; i++) {
    arrayClose(attributeVector(copy.geometry, 'normal', i), [0, -1, 0], 'detached normal through bind rotation');
    arrayClose(attributeVector(copy.geometry, 'tangent', i), [0, 0, 1, i === 1 ? -1 : 1], 'detached tangent through bind rotation');
  }
  matrixClose(driver.matrixWorld, new THREE.Matrix4().set(
    0, 0, 1, 21, 1, 0, 0, -2, 0, 1, 0, 1, 0, 0, 0, 1), 'refreshed external hierarchy');
  matrixClose(object.bindMatrix, bind, 'source detached bind');
  matrixClose(object.bindMatrixInverse, staleInverse, 'source detached inverse');
  matrixClose(skeleton.boneInverses[0], inverseAtRest, 'source bone inverse');
  assert.deepEqual(Array.from(skeleton.boneMatrices), boneMatrices, 'no skeleton.update side effects');
  assert.equal(driver.parent, anchor);
  assert.equal(anchor.parent, external);
  assert.equal(external.parent, null, 'external hierarchy must not be reparented into the scene');
  assert.equal(result.bakedSkinned, 1);
  assertStaticSkin(copy, object);
});

for (const reverse of [false, true]) {
  test(`two skins sharing geometry own different skeleton poses (${reverse ? 'reversed' : 'forward'} traversal)`, () => {
    const g = setTangents(skinGeometry());
    const a = boundSkin(g);
    const b = boundSkin(g, a.object.material);
    a.object.name = 'skin-a';
    b.object.name = 'skin-b';
    a.bone.position.set(2, 3, 4);
    b.bone.position.set(-2, 1, 0);
    b.bone.rotation.x = Math.PI / 2;
    const result = snapshot({ scene: sceneWith(...(reverse ? [b.object, a.object] : [a.object, b.object])) });
    const copies = meshes(result.scene);
    const ca = copies.find((node) => node.name === 'skin-a');
    const cb = copies.find((node) => node.name === 'skin-b');
    assert.equal(result.bakedSkinned, 2);
    assert.equal(result.meshCount, 2);
    assert.equal(result.triangleCount, 2);
    assert.notEqual(ca.geometry, cb.geometry, 'skins must never use a source-geometry cache');
    assert.notEqual(ca.geometry.attributes.position.array, cb.geometry.attributes.position.array);
    arrayClose(ca.geometry.attributes.position.array, [2, 3, 4, 3, 3, 4, 2, 4, 4], 'skin A');
    arrayClose(cb.geometry.attributes.position.array, [-2, 1, 0, -1, 1, 0, -2, 1, 1], 'skin B');
    arrayClose(attributeVector(ca.geometry, 'normal', 0), [0, 0, 1], 'skin A normal');
    arrayClose(attributeVector(cb.geometry, 'normal', 0), [0, -1, 0], 'skin B normal');
    assertStaticSkin(ca, a.object);
    assertStaticSkin(cb, b.object);
    ca.geometry.attributes.position.setX(0, 99);
    close(cb.geometry.attributes.position.getX(0), -2, 'copy B isolated from copy A');
    close(g.attributes.position.getX(0), 0, 'source isolated from copy A');
    assert.ok(g.attributes.skinIndex && g.attributes.skinWeight);
  });

  test(`ordinary Mesh and skin sharing geometry stay independent (${reverse ? 'skin first' : 'ordinary first'})`, () => {
    const g = skinGeometry();
    const { object, bone } = boundSkin(g);
    const ordinary = mesh(object.material, g);
    ordinary.name = 'ordinary';
    object.name = 'skin';
    bone.rotation.x = Math.PI / 2;
    bone.position.z = 2;
    const result = snapshot({ scene: sceneWith(...(reverse ? [object, ordinary] : [ordinary, object])) });
    const copies = meshes(result.scene);
    const plain = copies.find((node) => node.name === 'ordinary');
    const posed = copies.find((node) => node.name === 'skin');
    assert.equal(result.bakedSkinned, 1);
    assert.equal(result.meshCount, 2);
    assert.equal(result.triangleCount, 2);
    assert.notEqual(plain.geometry, posed.geometry);
    arrayClose(plain.geometry.attributes.position.array, [0, 0, 0, 1, 0, 0, 0, 1, 0], 'ordinary base vertices');
    arrayClose(posed.geometry.attributes.position.array, [0, 0, 2, 1, 0, 2, 0, 0, 3], 'skin posed vertices');
    arrayClose(attributeVector(plain.geometry, 'normal', 0), [0, 0, 1], 'ordinary base normal');
    arrayClose(attributeVector(posed.geometry, 'normal', 0), [0, -1, 0], 'skin posed normal');
    assertStaticSkin(posed, object);
    assert.equal(ordinary.geometry, object.geometry);
    assert.equal(object.geometry, g);
  });
}

for (const relative of [false, true]) {
  test(`skin applies ${relative ? 'relative' : 'absolute'} morph positions and normals before bone deformation`, () => {
    const g = setTangents(skinGeometry());
    g.morphTargetsRelative = relative;
    const basePositions = Array.from(g.attributes.position.array);
    const positionDeltas = [[1, 0, 0, 0, 2, 0, 0, 0, 3], [-2, 1, 0, 1, 0, 2, 0, -1, 1]];
    g.morphAttributes.position = positionDeltas.map((delta) => new THREE.Float32BufferAttribute(
      relative ? delta : delta.map((value, i) => value + basePositions[i]), 3));
    const normalTargets = relative ? [[1, 0, -1], [0, 1, -1]] : [[1, 0, 0], [0, 1, 0]];
    g.morphAttributes.normal = normalTargets.map((normal) => new THREE.Float32BufferAttribute(
      Array.from({ length: 3 }, () => normal).flat(), 3));
    const { object, bone } = boundSkin(g);
    object.morphTargetInfluences[0] = 0.25;
    object.morphTargetInfluences[1] = 0.5;
    bone.rotation.x = Math.PI / 2;
    bone.position.set(2, 3, 4);
    const morphData = [...g.morphAttributes.position, ...g.morphAttributes.normal].map((a) => Array.from(a.array));
    const result = snapshot({ scene: sceneWith(object) });
    const copy = onlyMesh(result);
    arrayClose(copy.geometry.attributes.position.array, [1.25, 3, 4.5, 3.5, 2, 4.5, 2, 1.75, 4.5], 'morph then skin');
    const normal = [1 / Math.sqrt(6), -1 / Math.sqrt(6), 2 / Math.sqrt(6)];
    for (let i = 0; i < 3; i++) {
      arrayClose(attributeVector(copy.geometry, 'normal', i), normal, 'morphed then skinned normal');
      arrayClose(attributeVector(copy.geometry, 'tangent', i), [1, 0, 0, i === 1 ? -1 : 1], 'unmorphed skinned tangent');
      arrayClose(copy.getVertexPosition(i, new THREE.Vector3()).toArray(),
        attributeVector(copy.geometry, 'position', i), 'snapshot does not apply morph/skin twice');
    }
    assert.equal(result.bakedSkinned, 1);
    assertStaticSkin(copy, object);
    assert.deepEqual(Array.from(g.attributes.position.array), basePositions);
    assert.deepEqual([...g.morphAttributes.position, ...g.morphAttributes.normal].map((a) => Array.from(a.array)), morphData);
    assert.deepEqual(object.morphTargetInfluences, [0.25, 0.5]);
    assert.equal(g.morphTargetsRelative, relative);
  });

  test(`skin supports ${relative ? 'relative' : 'absolute'} normal-only morphs without recomputing authored normals`, () => {
    const g = skinGeometry();
    g.morphTargetsRelative = relative;
    g.morphAttributes.normal = [new THREE.Float32BufferAttribute(
      Array.from({ length: 3 }, () => relative ? [0, 1, -1] : [0, 1, 0]).flat(), 3)];
    const { object, bone } = boundSkin(g);
    object.morphTargetInfluences[0] = 0.5;
    bone.rotation.x = Math.PI / 2;
    const copy = onlyMesh(snapshot({ scene: sceneWith(object) }));
    arrayClose(copy.geometry.attributes.position.array, [0, 0, 0, 1, 0, 0, 0, 0, 1], 'normal-only morph leaves positions alone');
    for (let i = 0; i < 3; i++) {
      arrayClose(attributeVector(copy.geometry, 'normal', i), [0, -1 / Math.sqrt(2), 1 / Math.sqrt(2)], 'normal-only morph');
    }
    assertStaticSkin(copy, object);
    assert.deepEqual(object.morphTargetInfluences, [0.5]);
  });
}

test('skin preserves authored smooth normals and transforms normal/tangent directions like the shader, not inverse transpose', () => {
  const g = skinGeometry();
  g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 0.6, 0.8, 0.6, 0, 0.8, 0.6, 0.8, 0], 3));
  setTangents(g, [Math.SQRT1_2, Math.SQRT1_2, 0], [1, -1, -1]);
  const { object, bone } = boundSkin(g);
  bone.rotation.z = Math.PI / 2;
  bone.scale.set(2, 3, 0.5);
  bone.position.set(7, 8, 9);
  const copy = onlyMesh(snapshot({ scene: sceneWith(object) }));
  const normals = [[-9 / Math.sqrt(85), 0, 2 / Math.sqrt(85)],
    [0, 3 / Math.sqrt(10), 1 / Math.sqrt(10)], [-2 / Math.sqrt(5), 1 / Math.sqrt(5), 0]];
  for (let i = 0; i < 3; i++) {
    arrayClose(attributeVector(copy.geometry, 'normal', i), normals[i], 'authored smooth shader normal');
    arrayClose(attributeVector(copy.geometry, 'tangent', i),
      [-3 / Math.sqrt(13), 2 / Math.sqrt(13), 0, i === 0 ? 1 : -1], 'normalized tangent and original handedness');
  }
  arrayClose(copy.geometry.attributes.position.array, [7, 8, 9, 7, 10, 9, 4, 8, 9], 'scaled pose');
  arrayClose(g.attributes.normal.array, [0, 0.6, 0.8, 0.6, 0, 0.8, 0.6, 0.8, 0], 'source authored normals');
});

for (const fixture of [
  { weights: [1, 0, 0, 0], positions: [2, 0, 0, 3, 0, 0, 2, 1, 0], normal: [0, 0, 1], tangent: [1, 0, 0] },
  { weights: [0.25, 0.75, 0, 0], positions: [0.5, 3, 0, 0.75, 3.75, 0, -0.25, 3.25, 0],
    normal: [0, 0, 1], tangent: [1 / Math.sqrt(10), 3 / Math.sqrt(10), 0] },
  { weights: [0.25, 0.25, 0.5, 0], positions: [0.5, 1, 3, 1.25, 1.25, 3, 0.25, 1.25, 3.5],
    normal: [0, -Math.SQRT1_2, Math.SQRT1_2], tangent: [3 / Math.sqrt(10), 1 / Math.sqrt(10), 0] },
  { weights: [0.125, 0.25, 0.375, 0.25], positions: [-0.75, 1.5, 2.25, -0.25, 1.75, 2, -1, 1.875, 2.625],
    normal: [2 / Math.sqrt(22), -3 / Math.sqrt(22), 3 / Math.sqrt(22)],
    tangent: [2 / Math.sqrt(6), 1 / Math.sqrt(6), -1 / Math.sqrt(6)] }
]) {
  test(`${fixture.weights.filter((weight) => weight !== 0).length} weighted bone slots match independent shader position and direction values`, () => {
    const bones = Array.from({ length: 4 }, () => new THREE.Bone());
    const g = setTangents(skinGeometry(geometry(), [0, 1, 2, 3], fixture.weights));
    const { object } = boundSkin(g, new THREE.MeshStandardMaterial(), bones);
    bones[0].position.set(2, 0, 0);
    bones[1].position.set(0, 4, 0);
    bones[1].rotation.z = Math.PI / 2;
    bones[2].position.set(0, 0, 6);
    bones[2].rotation.x = Math.PI / 2;
    bones[3].position.set(-4, 2, 0);
    bones[3].rotation.y = Math.PI / 2;
    const result = snapshot({ scene: sceneWith(object) });
    const copy = onlyMesh(result);
    arrayClose(copy.geometry.attributes.position.array, fixture.positions, 'weighted positions');
    for (let i = 0; i < 3; i++) {
      arrayClose(attributeVector(copy.geometry, 'normal', i), fixture.normal, 'weighted normalized normal');
      arrayClose(attributeVector(copy.geometry, 'tangent', i), [...fixture.tangent, i === 1 ? -1 : 1], 'weighted normalized tangent');
    }
    assert.equal(result.bakedSkinned, 1, 'count source mesh, not bone slots or triangles');
    assert.equal(result.triangleCount, 1);
    assertStaticSkin(copy, object);
  });
}

test('skin reads each vertex skin indices and weights, including non-first active slots', () => {
  const g = skinGeometry(geometry(), [0, 1, 0, 0]);
  g.attributes.skinIndex.setXYZW(1, 1, 0, 0, 0);
  g.attributes.skinWeight.setXYZW(1, 0.75, 0.25, 0, 0);
  g.attributes.skinWeight.setXYZW(2, 0, 1, 0, 0);
  g.setAttribute('normal', new THREE.Float32BufferAttribute([1, 0, 0, 1, 0, 0, 1, 0, 0], 3));
  setTangents(g, [0, 1, 0]);
  const bones = [new THREE.Bone(), new THREE.Bone()];
  const { object } = boundSkin(g, new THREE.MeshStandardMaterial(), bones);
  bones[0].position.x = 2;
  bones[1].position.y = 4;
  bones[1].rotation.z = Math.PI / 2;
  const copy = onlyMesh(snapshot({ scene: sceneWith(object) }));
  arrayClose(copy.geometry.attributes.position.array, [2, 0, 0, 0.75, 3.75, 0, -1, 4, 0], 'per-vertex pose');
  const normals = [[1, 0, 0], [1 / Math.sqrt(10), 3 / Math.sqrt(10), 0], [0, 1, 0]];
  const tangents = [[0, 1, 0, 1], [-3 / Math.sqrt(10), 1 / Math.sqrt(10), 0, -1], [-1, 0, 0, 1]];
  for (let i = 0; i < 3; i++) {
    arrayClose(attributeVector(copy.geometry, 'normal', i), normals[i], 'per-vertex normal');
    arrayClose(attributeVector(copy.geometry, 'tangent', i), tangents[i], 'per-vertex tangent');
  }
});

test('zero-influence skin morphs are cleared while authored base normals survive bone deformation', () => {
  const g = skinGeometry();
  g.morphTargetsRelative = true;
  g.morphAttributes.position = [new THREE.Float32BufferAttribute([0, 0, 9, 0, 0, 9, 0, 0, 9], 3)];
  g.morphAttributes.normal = [new THREE.Float32BufferAttribute([5, 5, 5, 5, 5, 5, 5, 5, 5], 3)];
  g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 0.6, 0.8, 0, 0.6, 0.8, 0, 0.6, 0.8], 3));
  const { object, bone } = boundSkin(g);
  bone.rotation.x = Math.PI / 2;
  const copy = onlyMesh(snapshot({ scene: sceneWith(object) }));
  arrayClose(copy.geometry.attributes.position.array, [0, 0, 0, 1, 0, 0, 0, 0, 1], 'zero-influence posed vertices');
  for (let i = 0; i < 3; i++) {
    arrayClose(attributeVector(copy.geometry, 'normal', i), [0, -0.8, 0.6], 'zero-influence authored normal');
  }
  assertStaticSkin(copy, object);
  assert.deepEqual(object.morphTargetInfluences, [0]);
  assert.ok(g.morphAttributes.position && g.morphAttributes.normal);
});

for (const missing of ['skeleton', 'skinIndex', 'skinWeight']) {
  test(`PBR skin missing ${missing} is skipped once without vertex baking or triangle consumption`, () => {
    const { object, bone, skeleton } = boundSkin(skinGeometry(geometry(5)), new THREE.MeshPhysicalMaterial());
    if (missing === 'skeleton') object.skeleton = undefined;
    else object.geometry.deleteAttribute(missing);
    object.getVertexPosition = () => assert.fail('incomplete rig must not bake vertices');
    const result = snapshot({ scene: sceneWith(object), maxTriangles: 1 });
    assert.equal(result.skippedSkinned, 1);
    assert.equal(result.skippedMaterial, 0);
    assert.equal(result.bakedSkinned, 0);
    assert.equal(result.meshCount, 0);
    assert.equal(result.triangleCount, 0);
    assert.equal(object.skeleton, missing === 'skeleton' ? undefined : skeleton);
    assert.equal(bone.parent, object);
  });
}

test('valid skin recovers original PBR material behind MatCap before baking', () => {
  const display = new THREE.MeshMatcapMaterial();
  const original = new THREE.MeshPhysicalMaterial({ transmission: 0.6, roughness: 0.2 });
  const { object, bone } = boundSkin(skinGeometry(), display);
  object.userData.__originalMaterial = original;
  bone.position.x = 2;
  const result = snapshot({ scene: sceneWith(object) });
  const copy = onlyMesh(result);
  assert.equal(result.bakedSkinned, 1);
  assert.equal(result.skippedMaterial, 0);
  assert.equal(result.skippedSkinned, 0);
  assert.ok(copy.material.isMeshPhysicalMaterial);
  assert.notEqual(copy.material, original);
  assert.equal(copy.material.transmission, 0.6);
  close(copy.geometry.attributes.position.getX(0), 2, 'recovered PBR pose');
  assert.equal(object.material, display);
  assert.equal(object.userData.__originalMaterial, original);
});

test('circular source mesh/helper metadata is never JSON-cloned', () => {
  const root = new THREE.Group();
  const object = mesh(new THREE.MeshMatcapMaterial());
  object.userData.__originalMaterial = new THREE.MeshStandardMaterial();
  object.userData.helper = root;
  root.userData.owner = object;
  root.add(object);
  const result = snapshot({ scene: sceneWith(root), rootContainer: root });
  assert.equal(result.meshCount, 1);
  assert.equal(object.userData.helper, root);
  assert.equal(root.userData.owner, object);
});

test('InstancedMesh expands active instances into ordinary meshes with world * instance matrices', () => {
  const parent = new THREE.Group();
  parent.position.set(5, -3, 2);
  parent.rotation.set(0.1, 0.2, 0.3);
  parent.scale.set(2, 1, 0.5);
  const object = new THREE.InstancedMesh(geometry(2), new THREE.MeshStandardMaterial(), 3);
  object.position.set(-1, 4, 2);
  object.rotation.y = 0.6;
  const instanceMatrices = [new THREE.Matrix4().makeTranslation(1, 2, 3),
    new THREE.Matrix4().makeRotationZ(0.5).setPosition(-4, 1, 2),
    new THREE.Matrix4().makeTranslation(99, 99, 99)];
  instanceMatrices.forEach((matrix, i) => object.setMatrixAt(i, matrix));
  object.count = 2;
  parent.add(object);
  const source = sceneWith(parent);
  source.updateMatrixWorld(true);
  const expected = instanceMatrices.slice(0, 2).map((matrix) => object.matrixWorld.clone().multiply(matrix));
  const before = Array.from(object.instanceMatrix.array);
  const result = snapshot({ scene: source });
  const copies = meshes(result.scene);
  assert.equal(result.meshCount, 2);
  assert.equal(copies.length, 2);
  assert.equal(result.triangleCount, 4);
  for (const matrix of expected) {
    const copy = copies.find((candidate) => candidate.matrix.elements.every(
      (value, i) => Math.abs(value - matrix.elements[i]) <= 1e-6));
    assert.ok(copy, 'missing instance world transform');
    assert.ok(!copy.isInstancedMesh, 'snapshot instances must be ordinary meshes');
    assert.equal(copy.matrixAutoUpdate, false);
    assert.notEqual(copy.geometry, object.geometry);
    assert.notEqual(copy.material, object.material);
    matrixClose(copy.matrixWorld, matrix, 'instance world matrix');
  }
  assert.deepEqual(Array.from(object.instanceMatrix.array), before);
  assert.equal(object.count, 2);
});

test('InstancedMesh preserves PBR material arrays for every expanded instance', () => {
  const materials = [new THREE.MeshStandardMaterial(), new THREE.MeshPhysicalMaterial()];
  const object = new THREE.InstancedMesh(geometry(2), materials, 2);
  object.geometry.addGroup(0, 3, 0);
  object.geometry.addGroup(3, 3, 1);
  const result = snapshot({ scene: sceneWith(object) });
  assert.equal(result.meshCount, 2);
  assert.equal(result.triangleCount, 4);
  for (const copy of meshes(result.scene)) {
    assert.ok(Array.isArray(copy.material));
    assert.equal(copy.material.length, 2);
    assert.notEqual(copy.material[0], materials[0]);
    assert.notEqual(copy.material[1], materials[1]);
    assert.deepEqual(copy.geometry.groups, object.geometry.groups);
  }
});

test('zero-count and invisible InstancedMesh do not produce meshes or triangles', () => {
  const empty = new THREE.InstancedMesh(geometry(), new THREE.MeshStandardMaterial(), 2);
  empty.count = 0;
  const hidden = new THREE.InstancedMesh(geometry(), new THREE.MeshStandardMaterial(), 3);
  hidden.visible = false;
  const result = snapshot({ scene: sceneWith(empty, hidden) });
  assert.equal(result.meshCount, 0);
  assert.equal(result.triangleCount, 0);
});

for (const relative of [false, true]) {
  test(`${relative ? 'relative' : 'absolute'} morph targets bake the current weighted vertex positions`, () => {
    const g = geometry();
    g.morphTargetsRelative = relative;
    const base = Array.from(g.attributes.position.array);
    const deltas = [[1, 0, 0, 0, 2, 0, 0, 0, 3], [-2, 1, 0, 1, 0, 2, 0, -1, 1]];
    g.morphAttributes.position = deltas.map((delta) => new THREE.Float32BufferAttribute(
      relative ? delta : delta.map((value, i) => value + base[i]), 3));
    const object = mesh(new THREE.MeshStandardMaterial(), g);
    object.morphTargetInfluences[0] = 0.25;
    object.morphTargetInfluences[1] = 0.5;
    object.position.set(3, 4, 5);
    const originalTargets = g.morphAttributes.position.map((attribute) => Array.from(attribute.array));
    const result = snapshot({ scene: sceneWith(object) });
    const copy = onlyMesh(result);
    const expected = base.map((value, i) => value + 0.25 * deltas[0][i] + 0.5 * deltas[1][i]);
    arrayClose(copy.geometry.attributes.position.array, expected, 'baked local positions');
    for (let i = 0; i < g.attributes.position.count; i++) {
      const sourcePosition = object.getVertexPosition(i, new THREE.Vector3());
      const copiedPosition = copy.getVertexPosition(i, new THREE.Vector3());
      arrayClose(copiedPosition.toArray(), sourcePosition.toArray(), 'morph must not be applied twice');
    }
    matrixClose(copy.matrix, object.matrixWorld, 'morph world matrix');
    assert.equal(result.triangleCount, 1);
    assert.deepEqual(Array.from(g.attributes.position.array), base);
    assert.deepEqual(g.morphAttributes.position.map((attribute) => Array.from(attribute.array)), originalTargets);
    assert.deepEqual(object.morphTargetInfluences, [0.25, 0.5]);
  });
}

test('meshes sharing morph geometry get their own current pose rather than a cached first pose', () => {
  const g = geometry();
  g.morphTargetsRelative = true;
  g.morphAttributes.position = [new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2, 0, 0, 2], 3)];
  const a = mesh(new THREE.MeshStandardMaterial(), g);
  const b = mesh(a.material, g);
  a.name = 'pose-a';
  b.name = 'pose-b';
  a.morphTargetInfluences[0] = 0.25;
  b.morphTargetInfluences[0] = 0.75;
  const result = snapshot({ scene: sceneWith(a, b) });
  const copies = meshes(result.scene);
  assert.equal(result.meshCount, 2);
  close(copies.find((node) => node.name === 'pose-a').geometry.attributes.position.getZ(0), 0.5, 'pose A');
  close(copies.find((node) => node.name === 'pose-b').geometry.attributes.position.getZ(0), 1.5, 'pose B');
  assert.equal(g.attributes.position.getZ(0), 0);
});

test('zero morph influence leaves the current base positions unchanged', () => {
  const g = geometry();
  g.morphTargetsRelative = true;
  g.morphAttributes.position = [new THREE.Float32BufferAttribute([0, 0, 4, 0, 0, 4, 0, 0, 4], 3)];
  const object = mesh(new THREE.MeshStandardMaterial(), g);
  const copy = onlyMesh(snapshot({ scene: sceneWith(object) }));
  arrayClose(copy.geometry.attributes.position.array, g.attributes.position.array, 'zero morph pose');
  arrayClose(copy.getVertexPosition(0, new THREE.Vector3()).toArray(), [0, 0, 0], 'zero morph vertex');
});

for (const [name, makeLight, properties] of [
  ['Point', () => new THREE.PointLight(0x123456, 4, 12, 1.5), ['distance', 'decay']],
  ['Spot', () => new THREE.SpotLight(0x234567, 5, 18, 0.7, 0.3, 1.8),
    ['distance', 'decay', 'angle', 'penumbra']],
  ['Directional', () => new THREE.DirectionalLight(0x345678, 2.5), []],
  ['RectArea', () => new THREE.RectAreaLight(0x456789, 6, 7, 3), ['width', 'height']]
]) {
  test(`${name} light copies properties and parented world pose without fallback`, () => {
    const parent = new THREE.Group();
    parent.position.set(8, -2, 5);
    parent.rotation.set(0.2, -0.4, 0.6);
    parent.scale.setScalar(1.5);
    const original = makeLight();
    original.position.set(1, 3, -2);
    original.rotation.set(-0.3, 0.5, 0.1);
    parent.add(original);
    const source = sceneWith(parent);
    source.updateMatrixWorld(true);
    const expected = original.matrixWorld.clone();
    const result = snapshot({ scene: source });
    const copiedLights = lights(result.scene);
    assert.equal(result.lightCount, 1);
    assert.equal(copiedLights.length, 1);
    const copy = copiedLights[0];
    assert.equal(copy.type, original.type);
    assert.notEqual(copy, original);
    assert.notEqual(copy.color, original.color);
    arrayClose(copy.color.toArray(), original.color.toArray(), 'light color');
    assert.equal(copy.intensity, original.intensity);
    for (const property of properties) assert.equal(copy[property], original[property], property);
    result.scene.updateMatrixWorld(true);
    matrixClose(copy.matrixWorld, expected, 'light world pose');
    copy.color.setHex(0xffffff);
    copy.intensity = 99;
    assert.notEqual(original.color.getHex(), 0xffffff);
    assert.notEqual(original.intensity, 99);
    assert.equal(original.parent, parent);
  });
}

for (const makeLight of [() => new THREE.SpotLight(), () => new THREE.DirectionalLight()]) {
  const name = makeLight().type;
  test(`${name} target snapshots a separately parented world position`, () => {
    const original = makeLight();
    original.position.set(1, 2, 3);
    const targetParent = new THREE.Group();
    targetParent.position.set(10, 4, -6);
    targetParent.rotation.set(0.2, 0.4, -0.3);
    original.target.position.set(2, -1, 5);
    targetParent.add(original.target);
    const source = sceneWith(original, targetParent);
    source.updateMatrixWorld(true);
    const expected = original.target.getWorldPosition(new THREE.Vector3());
    const result = snapshot({ scene: source });
    const copy = lights(result.scene)[0];
    assert.notEqual(copy.target, original.target);
    arrayClose(copy.target.getWorldPosition(new THREE.Vector3()).toArray(), expected.toArray(), 'target world position');
    targetParent.position.set(-100, -100, -100);
    source.updateMatrixWorld(true);
    result.scene.updateMatrixWorld(true);
    arrayClose(copy.target.getWorldPosition(new THREE.Vector3()).toArray(), expected.toArray(), 'target remains detached');
    assert.equal(original.target.parent, targetParent);
  });
}

test('lightsGroup already in source traversal is deduplicated by light identity', () => {
  const group = new THREE.Group();
  group.add(new THREE.PointLight(), new THREE.SpotLight());
  const source = sceneWith(group, new THREE.DirectionalLight());
  const result = snapshot({ scene: source, lightsGroup: group });
  assert.equal(result.lightCount, 3);
  assert.equal(lights(result.scene).length, 3);
});

test('separate lightsGroup copies world-space lights but not its meshes', () => {
  const root = new THREE.Group();
  root.add(mesh());
  const parent = new THREE.Group();
  parent.position.set(7, 8, 9);
  const group = new THREE.Group();
  group.position.set(1, 2, 3);
  const original = new THREE.PointLight();
  original.position.set(2, 3, 4);
  group.add(original, mesh());
  parent.add(group);
  const source = sceneWith(root, parent);
  const result = snapshot({ scene: source, rootContainer: root, lightsGroup: group });
  assert.equal(result.meshCount, 1);
  assert.equal(result.lightCount, 1);
  arrayClose(lights(result.scene)[0].getWorldPosition(new THREE.Vector3()).toArray(), [10, 13, 16], 'external light pose');
});

test('visible supported lights survive a system-marked lightsGroup root', () => {
  const group = new THREE.Group();
  group.userData.isSystemObject = true;
  group.add(new THREE.RectAreaLight());
  const root = new THREE.Group();
  root.add(mesh());
  const result = snapshot({ scene: sceneWith(root, group), rootContainer: root, lightsGroup: group });
  assert.equal(result.lightCount, 1);
  assert.ok(lights(result.scene)[0].isRectAreaLight);
});

test('hidden lights, hidden light ancestors and helper lights are excluded in both traversals', () => {
  const group = new THREE.Group();
  const visible = new THREE.PointLight();
  const hidden = new THREE.SpotLight();
  hidden.visible = false;
  const hiddenAncestor = new THREE.Group();
  hiddenAncestor.visible = false;
  hiddenAncestor.add(new THREE.DirectionalLight());
  const helperAncestor = new THREE.Group();
  helperAncestor.userData.isLightHelper = true;
  helperAncestor.add(new THREE.RectAreaLight());
  const helper = new THREE.PointLight();
  helper.userData.isHelper = true;
  group.add(visible, hidden, hiddenAncestor, helperAncestor, helper);
  const result = snapshot({ scene: sceneWith(group), lightsGroup: group });
  assert.equal(result.lightCount, 1);
  assert.equal(lights(result.scene).length, 1);
  assert.ok(lights(result.scene)[0].isPointLight);
});

test('an invisible separate lightsGroup and its outside invisible ancestors do not leak lights', () => {
  for (const hideRoot of [true, false]) {
    const outer = new THREE.Group();
    const group = new THREE.Group();
    group.add(new THREE.PointLight());
    if (hideRoot) group.visible = false;
    else outer.visible = false;
    outer.add(group);
    const root = new THREE.Group();
    const result = snapshot({ scene: sceneWith(root, outer), rootContainer: root, lightsGroup: group });
    assert.equal(result.lightCount, 2, 'must use only fallback lights');
    assert.ok(lights(result.scene).every((light) => light.isDirectionalLight));
  }
});

test('Ambient and Hemisphere lights are unsupported and trigger two directional fallbacks', () => {
  const result = snapshot({ scene: sceneWith(new THREE.AmbientLight(), new THREE.HemisphereLight()) });
  assert.equal(result.lightCount, 2);
  assert.equal(lights(result.scene).length, 2);
  assert.ok(lights(result.scene).every((light) => light.isDirectionalLight));
});

test('unsupported lights do not inflate a supported light count or cause fallback', () => {
  const result = snapshot({ scene: sceneWith(new THREE.AmbientLight(), new THREE.PointLight()) });
  assert.equal(result.lightCount, 1);
  assert.equal(lights(result.scene).length, 1);
  assert.ok(lights(result.scene)[0].isPointLight);
});

test('RGBA HalfFloat DataTexture environment is accepted as an owned clone', () => {
  const source = new THREE.Scene();
  const environment = hdrEnvironment();
  source.environment = environment;
  const counts = disposalCounts([environment]);
  const result = snapshot({ scene: source });
  const copy = result.scene.environment;
  assert.equal(result.environmentSkipped, false);
  assert.ok(copy?.isDataTexture);
  assert.notEqual(copy, environment);
  assert.equal(copy.type, THREE.HalfFloatType);
  assert.equal(copy.format, THREE.RGBAFormat);
  assert.equal(copy.mapping, environment.mapping);
  assert.equal(copy.minFilter, environment.minFilter);
  assert.equal(copy.magFilter, environment.magFilter);
  assert.equal(copy.colorSpace, environment.colorSpace);
  assert.deepEqual(Array.from(copy.image.data), Array.from(environment.image.data));
  copy.mapping = THREE.UVMapping;
  assert.equal(environment.mapping, THREE.EquirectangularReflectionMapping);
  result.dispose();
  assertUndisposed(counts);
  assert.equal(source.environment, environment);
});

test('RGBA Float DataTexture environment is accepted as an owned clone', () => {
  const source = new THREE.Scene();
  const environment = new THREE.DataTexture(new Float32Array([1, 0.5, 0.25, 1, 0.2, 0.4, 0.6, 1]), 2, 1, THREE.RGBAFormat, THREE.FloatType);
  environment.mapping = THREE.EquirectangularReflectionMapping;
  source.environment = environment;
  const counts = disposalCounts([environment]);
  const result = snapshot({ scene: source });
  const copy = result.scene.environment;
  assert.equal(result.environmentSkipped, false);
  assert.ok(copy?.isDataTexture);
  assert.notEqual(copy, environment);
  assert.equal(copy.type, THREE.FloatType);
  assert.equal(copy.format, THREE.RGBAFormat);
  result.dispose();
  assertUndisposed(counts);
  assert.equal(source.environment, environment);
});

test('InstancedMesh instance colors are baked into per-instance material colors', () => {
  const source = new THREE.Scene();
  const geom = geometry(1);
  const material = new THREE.MeshStandardMaterial({ color: 0xffffff });
  const instanced = new THREE.InstancedMesh(geom, material, 2);
  const m = new THREE.Matrix4();
  instanced.setMatrixAt(0, m.makeTranslation(0, 0, 0));
  instanced.setMatrixAt(1, m.makeTranslation(2, 0, 0));
  instanced.setColorAt(0, new THREE.Color(1, 0, 0));
  instanced.setColorAt(1, new THREE.Color(0, 0, 1));
  instanced.instanceMatrix.needsUpdate = true;
  if (instanced.instanceColor) instanced.instanceColor.needsUpdate = true;
  source.add(instanced);
  const result = snapshot({ scene: source });
  assert.equal(result.bakedInstanceColors, 2);
  const found = meshes(result.scene);
  assert.equal(found.length, 2);
  const colors = found.map((mesh) => mesh.material.color.getHex());
  assert.notEqual(colors[0], colors[1], 'instance colors must differ per instance');
  assert.equal(colors[0], 0xff0000);
  assert.equal(colors[1], 0x0000ff);
  // source material/instanceColor untouched
  assert.equal(material.color.getHex(), 0xffffff);
  result.dispose();
});

for (const [name, makeEnvironment] of [
  ['RGBA unsigned-byte DataTexture', () => new THREE.DataTexture(new Uint8Array(4), 1, 1)],
  ['Red HalfFloat DataTexture', () => new THREE.DataTexture(new Uint16Array(1), 1, 1, THREE.RedFormat, THREE.HalfFloatType)],
  ['ordinary texture with typed image data', () => {
    const texture = new THREE.Texture({ data: new Uint16Array(4), width: 1, height: 1 });
    texture.type = THREE.HalfFloatType;
    texture.format = THREE.RGBAFormat;
    return texture;
  }],
  ['cube environment', () => new THREE.CubeTexture()],
  ['PMREM render-target texture', () => {
    const texture = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType }).texture;
    texture.mapping = THREE.CubeUVReflectionMapping;
    return texture;
  }]
]) {
  test(`${name} is ignored with environmentSkipped=true and no source disposal`, () => {
    const environment = makeEnvironment();
    const source = new THREE.Scene();
    source.environment = environment;
    const counts = disposalCounts([environment]);
    const result = snapshot({ scene: source });
    assert.equal(result.scene.environment, null);
    assert.equal(result.environmentSkipped, true);
    result.dispose();
    assertUndisposed(counts);
    assert.equal(source.environment, environment);
  });
}

test('a missing environment reports environmentSkipped=false', () => {
  const result = snapshot({ scene: new THREE.Scene() });
  assert.equal(result.scene.environment, null);
  assert.equal(result.environmentSkipped, false);
});

test('triangleCount combines indexed and non-indexed geometry', () => {
  const result = snapshot({ scene: sceneWith(mesh(undefined, geometry(2)), mesh(undefined, geometry(3, false))) });
  assert.equal(result.meshCount, 2);
  assert.equal(result.triangleCount, 5);
});

test('an exact custom triangle budget succeeds; one additional triangle throws triangles', () => {
  const source = sceneWith(mesh(undefined, geometry(2)), mesh(undefined, geometry(3, false)));
  assert.equal(snapshot({ scene: source, maxTriangles: 5 }).triangleCount, 5);
  assert.throws(() => tracing.buildTracingScene({ scene: source, maxTriangles: 4 }), /triangles/);
});

test('default 200000-triangle budget accepts the boundary and rejects 200001', () => {
  const boundary = mesh(undefined, geometry(200000));
  const source = sceneWith(boundary);
  assert.equal(snapshot({ scene: source }).triangleCount, 200000);
  source.add(mesh());
  assert.throws(() => tracing.buildTracingScene({ scene: source }), /triangles/);
});

test('the triangle budget counts every expanded instance', () => {
  const object = new THREE.InstancedMesh(geometry(2), new THREE.MeshStandardMaterial(), 3);
  const source = sceneWith(object);
  assert.equal(snapshot({ scene: source, maxTriangles: 6 }).triangleCount, 6);
  assert.throws(() => tracing.buildTracingScene({ scene: source, maxTriangles: 5 }), /triangles/);
});

test('hidden, unsupported and incomplete skinned meshes do not consume the triangle budget', () => {
  const hidden = mesh(undefined, geometry(10));
  hidden.visible = false;
  const unsupported = mesh(new THREE.MeshBasicMaterial(), geometry(10));
  const { object: incomplete } = boundSkin(skinGeometry(geometry(10)));
  incomplete.geometry.deleteAttribute('skinWeight');
  const result = snapshot({ scene: sceneWith(mesh(), hidden, unsupported, incomplete), maxTriangles: 1 });
  assert.equal(result.triangleCount, 1);
  assert.equal(result.skippedMaterial, 1);
  assert.equal(result.skippedSkinned, 1);
  assert.equal(result.bakedSkinned, 0);
});

for (const indexed of [true, false]) {
  test(`valid ${indexed ? 'indexed' : 'nonindexed'} skins share the triangle budget with ordinary meshes`, () => {
    const { object, bone } = boundSkin(skinGeometry(geometry(3, indexed)));
    bone.position.z = 2;
    const source = sceneWith(mesh(undefined, geometry(2)), object);
    const result = snapshot({ scene: source, maxTriangles: 5 });
    assert.equal(result.meshCount, 2);
    assert.equal(result.bakedSkinned, 1);
    assert.equal(result.triangleCount, 5);
    assert.equal(result.skippedSkinned, 0);
    assert.throws(() => tracing.buildTracingScene({ scene: source, maxTriangles: 4 }), /triangles/);
  });
}

test('default triangle cap includes valid skins at 200000 and rejects 200001 before vertex baking', () => {
  const { object } = boundSkin(skinGeometry(geometry(200000)));
  const source = sceneWith(object);
  const result = snapshot({ scene: source });
  assert.equal(result.triangleCount, 200000);
  assert.equal(result.bakedSkinned, 1);
  assert.equal(result.meshCount, 1);
  object.geometry = skinGeometry(geometry(200001));
  let bakedVertices = 0;
  object.getVertexPosition = () => { bakedVertices++; throw new Error('vertex baking ran before budget check'); };
  assert.throws(() => tracing.buildTracingScene({ scene: source }), /triangles/);
  assert.equal(bakedVertices, 0);
});

test('custom skin budget rejects before getVertexPosition or direct position reads and never disposes sources', () => {
  const texture = new THREE.Texture();
  const material = new THREE.MeshStandardMaterial({ map: texture });
  const g = skinGeometry(geometry(3));
  const { object, skeleton } = boundSkin(g, material);
  const source = sceneWith(object);
  source.environment = hdrEnvironment();
  const counts = disposalCounts([g, material, texture, source.environment]);
  const positions = Array.from(g.attributes.position.array);
  const bind = object.bindMatrix.clone();
  const inverse = object.bindMatrixInverse.clone();
  const boneMatrices = Array.from(skeleton.boneMatrices);
  let bakedVertices = 0;
  let positionReads = 0;
  object.getVertexPosition = () => { bakedVertices++; throw new Error('premature getVertexPosition'); };
  for (const method of ['getX', 'getY', 'getZ']) {
    g.attributes.position[method] = () => { positionReads++; throw new Error('premature position attribute read'); };
  }
  assert.throws(() => tracing.buildTracingScene({ scene: source, maxTriangles: 2 }), /triangles/);
  assert.equal(bakedVertices, 0, 'budget must precede getVertexPosition');
  assert.equal(positionReads, 0, 'budget must also precede direct vertex baking');
  assertUndisposed(counts);
  assert.deepEqual(Array.from(g.attributes.position.array), positions);
  matrixClose(object.bindMatrix, bind, 'budget failure source bind');
  matrixClose(object.bindMatrixInverse, inverse, 'budget failure source inverse');
  assert.deepEqual(Array.from(skeleton.boneMatrices), boneMatrices);
  assert.equal(object.geometry, g);
  assert.equal(object.material, material);
});

test('skin snapshot isolation preserves rigs, bind matrices, morphs, tracks and mixer time, and disposes only owned resources', () => {
  const texture = new THREE.DataTexture(new Uint8Array([255, 128, 64, 255]), 1, 1);
  const material = new THREE.MeshStandardMaterial({ map: texture, normalMap: texture });
  const g = setTangents(skinGeometry());
  g.morphTargetsRelative = true;
  g.morphAttributes.position = [new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2, 0, 0, 2], 3)];
  g.morphAttributes.normal = [new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0], 3)];
  g.addGroup(0, 3, 0);
  g.setDrawRange(0, 3);
  g.computeBoundingBox();
  g.computeBoundingSphere();
  const { object, bone, skeleton } = boundSkin(g, material);
  bone.name = 'snapshot-driver';
  const tracks = [
    new THREE.NumberKeyframeTrack('.morphTargetInfluences[0]', [0, 1], [0, 0.5]),
    new THREE.VectorKeyframeTrack('snapshot-driver.position', [0, 1], [2, 3, 4, 6, 7, 8])
  ];
  const clip = new THREE.AnimationClip('source-motion', 1, tracks);
  const animations = [clip];
  object.animations = animations;
  const mixer = new THREE.AnimationMixer(object);
  const action = mixer.clipAction(clip).play();
  mixer.update(0.5);
  bone.rotation.z = Math.PI / 2;
  skeleton.computeBoneTexture();
  skeleton.boneMatrices.fill(17); // Deliberately stale GPU palette must not be used or refreshed.
  const source = sceneWith(object);
  object.userData.owner = source;
  source.userData.rig = object;
  const attributes = Object.entries(g.attributes).map(([name, attribute]) =>
    ({ name, attribute, array: attribute.array, data: Array.from(attribute.array), version: attribute.version }));
  const morphAttributes = g.morphAttributes;
  const morphs = [...morphAttributes.position, ...morphAttributes.normal].map((attribute) =>
    ({ attribute, array: attribute.array, data: Array.from(attribute.array) }));
  const index = g.index;
  const indexData = Array.from(index.array);
  const groups = g.groups.map((group) => ({ ...group }));
  const drawRange = { ...g.drawRange };
  const boundingBox = g.boundingBox.clone();
  const boundingSphere = g.boundingSphere.clone();
  const bind = object.bindMatrix;
  const bindData = bind.clone();
  const inverse = object.bindMatrixInverse;
  const inverseData = inverse.clone();
  const boneInverses = skeleton.boneInverses;
  const boneInverse = boneInverses[0];
  const boneInverseData = boneInverse.clone();
  const boneMatrices = skeleton.boneMatrices;
  const boneMatrixData = Array.from(boneMatrices);
  const boneTextureVersion = skeleton.boneTexture.version;
  const influences = object.morphTargetInfluences;
  const influenceData = [...influences];
  const trackData = tracks.map((track) => ({ times: track.times, values: track.values,
    timeData: Array.from(track.times), valueData: Array.from(track.values) }));
  const bonePosition = bone.position.clone();
  const boneQuaternion = bone.quaternion.clone();
  const boneScale = bone.scale.clone();
  const sourceCounts = disposalCounts([g, material, texture, skeleton.boneTexture]);
  for (const [target, names] of [[skeleton, ['update', 'pose', 'calculateInverses']],
    [object, ['pose', 'normalizeSkinWeights']], [mixer, ['update', 'setTime', 'stopAllAction']]]) {
    for (const name of names) target[name] = () => assert.fail(`snapshot must not call ${name}`);
  }
  const first = snapshot({ scene: source });
  const second = snapshot({ scene: source });
  const a = onlyMesh(first);
  const b = onlyMesh(second);
  const expected = [4, 5, 6.5, 4, 6, 6.5, 3, 5, 6.5];
  for (const copy of [a, b]) {
    assertStaticSkin(copy, object);
    arrayClose(copy.geometry.attributes.position.array, expected, 'current mixer pose captured without advancing');
    arrayClose(attributeVector(copy.geometry, 'normal', 0), [0, 0, 1], 'source normal captured');
    assert.notEqual(copy.material, material);
    assert.notEqual(copy.material.map, texture);
  }
  assert.notEqual(a.geometry, b.geometry, 'separate snapshots own separate baked geometries');
  assert.notEqual(a.material, b.material);
  assert.notEqual(a.material.map, b.material.map);
  assert.equal(first.bakedSkinned, 1);
  assert.equal(second.bakedSkinned, 1);
  assert.equal(object.geometry, g);
  assert.equal(object.material, material);
  assert.equal(object.skeleton, skeleton);
  assert.equal(object.animations, animations);
  assert.equal(object.animations[0], clip);
  assert.equal(clip.tracks, tracks);
  assert.equal(object.bindMatrix, bind);
  assert.equal(object.bindMatrixInverse, inverse);
  matrixClose(bind, bindData, 'source bind unchanged');
  matrixClose(inverse, inverseData, 'source bind inverse unchanged');
  assert.equal(skeleton.boneInverses, boneInverses);
  assert.equal(skeleton.boneInverses[0], boneInverse);
  matrixClose(boneInverse, boneInverseData, 'source bone inverse unchanged');
  assert.equal(skeleton.boneMatrices, boneMatrices);
  assert.deepEqual(Array.from(boneMatrices), boneMatrixData);
  assert.equal(skeleton.boneTexture.version, boneTextureVersion);
  assert.equal(object.morphTargetInfluences, influences);
  assert.deepEqual(influences, influenceData);
  close(mixer.time, 0.5, 'mixer time');
  close(action.time, 0.5, 'action time');
  assert.ok(action.isRunning(), 'action remains running');
  arrayClose(bone.position.toArray(), bonePosition.toArray(), 'bone local translation');
  arrayClose(bone.quaternion.toArray(), boneQuaternion.toArray(), 'bone local rotation');
  arrayClose(bone.scale.toArray(), boneScale.toArray(), 'bone local scale');
  for (const { name, attribute, array, data, version } of attributes) {
    assert.equal(g.attributes[name], attribute, `${name} reference`);
    assert.equal(attribute.array, array, `${name} array reference`);
    assert.deepEqual(Array.from(array), data, `${name} values`);
    assert.equal(attribute.version, version, `${name} version`);
  }
  assert.equal(g.morphAttributes, morphAttributes);
  for (const { attribute, array, data } of morphs) {
    assert.equal(attribute.array, array);
    assert.deepEqual(Array.from(array), data);
  }
  assert.equal(g.index, index);
  assert.deepEqual(Array.from(g.index.array), indexData);
  assert.deepEqual(g.groups, groups);
  assert.deepEqual(g.drawRange, drawRange);
  assert.ok(g.boundingBox.equals(boundingBox));
  assert.ok(g.boundingSphere.equals(boundingSphere));
  for (let i = 0; i < tracks.length; i++) {
    assert.equal(tracks[i].times, trackData[i].times);
    assert.equal(tracks[i].values, trackData[i].values);
    assert.deepEqual(Array.from(tracks[i].times), trackData[i].timeData);
    assert.deepEqual(Array.from(tracks[i].values), trackData[i].valueData);
  }
  assert.deepEqual(source.children, [object]);
  assert.deepEqual(object.children, [bone]);
  assert.equal(bone.parent, object);
  assert.equal(object.userData.owner, source);
  const aCounts = disposalCounts([a.geometry, a.material, a.material.map]);
  const bCounts = disposalCounts([b.geometry, b.material, b.material.map]);
  bone.position.set(100, 200, 300);
  influences[0] = 1;
  g.attributes.position.setX(0, 99);
  texture.offset.x = 7;
  first.scene.updateMatrixWorld(true);
  second.scene.updateMatrixWorld(true);
  arrayClose(a.geometry.attributes.position.array, expected, 'first snapshot detached from later source edits');
  arrayClose(b.geometry.attributes.position.array, expected, 'second snapshot detached from later source edits');
  close(a.material.map.offset.x, 0, 'snapshot texture transform independent');
  first.dispose(); first.dispose();
  for (const count of aCounts.values()) assert.equal(count, 1, 'owned skin resource disposed exactly once');
  assertUndisposed(bCounts);
  arrayClose(b.geometry.attributes.position.array, expected, 'disposing one snapshot leaves the other intact');
  second.dispose(); second.dispose();
  for (const count of bCounts.values()) assert.equal(count, 1);
  assertUndisposed(sourceCounts);
});

test('dispose releases all owned geometries, scalar/array materials, maps and environment, never sources', () => {
  const texture = new THREE.DataTexture(new Uint8Array([255, 128, 64, 255]), 1, 1);
  const original = new THREE.MeshStandardMaterial({ map: texture, normalMap: texture });
  const physical = new THREE.MeshPhysicalMaterial({ roughnessMap: texture });
  const display = new THREE.MeshMatcapMaterial();
  const g = geometry(2);
  const a = mesh(display, g);
  a.userData.__originalMaterial = [original, physical];
  const b = mesh(original, g);
  const source = sceneWith(a, b);
  source.environment = hdrEnvironment();
  const sourceCounts = disposalCounts([g, original, physical, display, texture, source.environment]);
  const result = snapshot({ scene: source });
  const owned = new Set([result.scene.environment]);
  for (const copy of meshes(result.scene)) {
    owned.add(copy.geometry);
    for (const material of Array.isArray(copy.material) ? copy.material : [copy.material]) {
      owned.add(material);
      for (const value of Object.values(material)) if (value?.isTexture) owned.add(value);
    }
  }
  for (const resource of sourceCounts.keys()) assert.ok(!owned.has(resource), 'source resource leaked into snapshot');
  const ownedCounts = disposalCounts(owned);
  result.dispose();
  for (const [resource, count] of ownedCounts) {
    assert.ok(count >= 1, `owned ${resource.type || resource.constructor.name} not disposed`);
  }
  result.dispose();
  assertUndisposed(sourceCounts);
  assert.equal(a.geometry, g);
  assert.equal(a.material, display);
  assert.equal(b.material, original);
  assert.deepEqual(source.children, [a, b]);
});

test('budget failure never disposes source geometry, material, texture or environment', () => {
  const texture = new THREE.Texture({ width: 1, height: 1 });
  const material = new THREE.MeshStandardMaterial({ map: texture });
  const g = geometry(2);
  const source = sceneWith(mesh(material, g));
  source.environment = hdrEnvironment();
  const counts = disposalCounts([g, material, texture, source.environment]);
  assert.throws(() => tracing.buildTracingScene({ scene: source, maxTriangles: 1 }), /triangles/);
  assertUndisposed(counts);
  assert.equal(source.children[0].geometry, g);
  assert.equal(source.children[0].material, material);
});

for (const [name, makeCamera] of [
  ['perspective', () => new THREE.PerspectiveCamera(52, 1.3, 0.2, 700)],
  ['orthographic', () => new THREE.OrthographicCamera(-3, 5, 4, -2, 0.3, 900)]
]) {
  test(`${name} camera preserves parented world pose and avoids circular userData cloning`, () => {
    const outer = new THREE.Group();
    outer.position.set(10, -4, 6);
    outer.rotation.set(0.3, -0.4, 0.2);
    const parent = new THREE.Group();
    parent.position.set(2, 1, -3);
    parent.rotation.set(-0.2, 0.6, -0.1);
    const source = makeCamera();
    source.position.set(1, 3, 5);
    source.rotation.set(0.4, 0.2, -0.3);
    source.zoom = 1.7;
    source.up.set(0, 0, 1);
    source.layers.set(3);
    parent.add(source);
    outer.add(parent);
    source.userData.helper = parent;
    source.userData.self = source.userData;
    parent.userData.camera = source;
    outer.updateMatrixWorld(true);
    const expected = source.matrixWorld.clone();
    // Force the clone API to refresh ancestor transforms, not trust a cached matrixWorld.
    outer.position.x += 2;
    expected.elements[12] += 2;
    const copy = tracing.cloneTracingCamera(source, 16 / 9);
    assert.notEqual(copy, source);
    assert.equal(copy.type, source.type);
    assert.equal(copy.parent, null);
    matrixClose(copy.matrixWorld, expected, 'camera world pose');
    matrixClose(copy.matrixWorldInverse, expected.clone().invert(), 'camera view matrix');
    assert.equal(copy.near, source.near);
    assert.equal(copy.far, source.far);
    assert.equal(copy.zoom, source.zoom);
    assert.equal(copy.layers.mask, source.layers.mask);
    arrayClose(copy.up.toArray(), source.up.toArray(), 'camera up');
    assert.deepEqual(copy.userData, {}, 'camera userData must not be cloned');
    assert.equal(source.parent, parent);
    assert.equal(source.userData.helper, parent);
    assert.equal(source.userData.self, source.userData);
    source.position.set(100, 100, 100);
    outer.updateMatrixWorld(true);
    copy.updateMatrixWorld(true);
    matrixClose(copy.matrixWorld, expected, 'camera snapshot independent of later source movement');
  });
}

test('perspective camera adapts aspect and projection, preserving optical properties', () => {
  const source = new THREE.PerspectiveCamera(61, 4 / 3, 0.25, 800);
  source.zoom = 1.25;
  source.filmGauge = 42;
  source.filmOffset = 1.5;
  source.updateProjectionMatrix();
  const before = source.projectionMatrix.clone();
  const copy = tracing.cloneTracingCamera(source, 9 / 16);
  assert.equal(copy.aspect, 9 / 16);
  assert.equal(copy.fov, 61);
  assert.equal(copy.filmGauge, 42);
  assert.equal(copy.filmOffset, 1.5);
  const expected = new THREE.PerspectiveCamera(61, 9 / 16, 0.25, 800);
  expected.zoom = 1.25;
  expected.filmGauge = 42;
  expected.filmOffset = 1.5;
  expected.updateProjectionMatrix();
  matrixClose(copy.projectionMatrix, expected.projectionMatrix, 'perspective projection');
  matrixClose(copy.projectionMatrixInverse, expected.projectionMatrixInverse, 'inverse projection');
  assert.equal(source.aspect, 4 / 3);
  matrixClose(source.projectionMatrix, before, 'source projection unchanged');
});

test('orthographic camera adapts horizontal extent, preserving vertical span, center and zoom', () => {
  const source = new THREE.OrthographicCamera(-3, 5, 6, -2, 0.4, 600);
  source.zoom = 2;
  source.updateProjectionMatrix();
  const before = source.projectionMatrix.clone();
  for (const aspect of [16 / 9, 9 / 16]) {
    const copy = tracing.cloneTracingCamera(source, aspect);
    assert.ok(copy.isOrthographicCamera);
    assert.equal(copy.top, 6);
    assert.equal(copy.bottom, -2);
    close((copy.left + copy.right) / 2, 1, 'horizontal center');
    close((copy.right - copy.left) / (copy.top - copy.bottom), aspect, 'orthographic aspect');
    assert.equal(copy.zoom, 2);
    const expected = new THREE.OrthographicCamera(1 - 4 * aspect, 1 + 4 * aspect, 6, -2, 0.4, 600);
    expected.zoom = 2;
    expected.updateProjectionMatrix();
    matrixClose(copy.projectionMatrix, expected.projectionMatrix, 'orthographic projection');
    matrixClose(copy.projectionMatrixInverse, expected.projectionMatrixInverse, 'orthographic inverse projection');
  }
  assert.equal(source.left, -3);
  assert.equal(source.right, 5);
  matrixClose(source.projectionMatrix, before, 'source orthographic projection unchanged');
});

test('camera view-offset state is copied without sharing the source object', () => {
  for (const source of [new THREE.PerspectiveCamera(), new THREE.OrthographicCamera(-2, 2, 2, -2)]) {
    source.setViewOffset(800, 600, 100, 50, 400, 300);
    const originalView = { ...source.view };
    const copy = tracing.cloneTracingCamera(source, 4 / 3);
    assert.notEqual(copy.view, source.view);
    assert.deepEqual(copy.view, originalView);
    copy.view.offsetX = 200;
    assert.deepEqual(source.view, originalView);
  }
});

test('getTracingSize applies each allowed scale exactly below caps', () => {
  for (const scale of [0.5, 1, 2]) {
    assert.deepEqual(tracing.getTracingSize(640, 360, scale), { width: 640 * scale, height: 360 * scale });
  }
});

test('small landscape and portrait sizes are not enlarged to a minimum render size', () => {
  for (const [width, height, scale] of [[40, 20, 0.5], [20, 40, 1], [8, 4, 2], [2, 2, 0.5]]) {
    assert.deepEqual(tracing.getTracingSize(width, height, scale), { width: width * scale, height: height * scale });
  }
});

function assertSize(width, height, scale) {
  const size = tracing.getTracingSize(width, height, scale);
  assert.ok(Number.isInteger(size.width) && size.width > 0, 'output width is a positive integer');
  assert.ok(Number.isInteger(size.height) && size.height > 0, 'output height is a positive integer');
  assert.ok(size.width <= 2048 && size.height <= 2048, `2048 side cap: ${size.width}x${size.height}`);
  assert.ok(size.width * size.height <= 2000000, `2M pixel cap: ${size.width}x${size.height} = ${size.width * size.height}`);
  const factor = Math.min(scale, 2048 / width, 2048 / height, Math.sqrt(2000000 / (width * height)));
  // Integer rasterization may round either direction, but not distort or enlarge to a min-size floor.
  close(size.width, width * factor, 'uniformly scaled width', 1);
  close(size.height, height * factor, 'uniformly scaled height', 1);
  const aspectTolerance = (1 + width / height) / size.height;
  close(size.width / size.height, width / height, 'aspect within integer rounding', aspectTolerance);
  return size;
}

test('2048-side cap preserves landscape and portrait aspect under uniform downscaling', () => {
  assert.deepEqual(assertSize(8192, 2048, 1), { width: 2048, height: 512 });
  assert.deepEqual(assertSize(2048, 8192, 2), { width: 512, height: 2048 });
});

test('2M-pixel cap preserves square, landscape and portrait aspect', () => {
  for (const [width, height, scale] of [[2048, 2048, 1], [4000, 3000, 1], [3000, 4000, 2]]) {
    assertSize(width, height, scale);
  }
});

test('rounding at the 2M-pixel boundary never exceeds the hard pixel cap', () => {
  for (const [width, height, scale] of [[1600, 900, 2], [900, 1600, 2], [2000, 1000, 2], [1920, 1080, 1]]) {
    assertSize(width, height, scale);
  }
});

test('fractional finite dimensions produce finite integer sizes within caps', () => {
  for (const [width, height, scale] of [[641.25, 359.75, 0.5], [320.5, 180.25, 2]]) {
    assertSize(width, height, scale);
  }
});

test('dimensions reject zero, negatives, non-finite values and non-number inputs', () => {
  const invalid = [0, -1, NaN, Infinity, -Infinity, undefined, null, '640', {}, true];
  for (const value of invalid) {
    assert.throws(() => tracing.getTracingSize(value, 480, 1), `invalid width ${String(value)}`);
    assert.throws(() => tracing.getTracingSize(640, value, 1), `invalid height ${String(value)}`);
  }
});

test('scale rejects anything except numeric 0.5, 1 or 2', () => {
  for (const scale of [0, -1, 0.25, 1.5, 3, NaN, Infinity, -Infinity, undefined, null, '1', true]) {
    assert.throws(() => tracing.getTracingSize(640, 480, scale), `invalid scale ${String(scale)}`);
  }
});

function generate(result, check) {
  result.prepareGeometry();
  const generator = new PathTracingSceneGenerator(result.scene);
  try { check(generator.generate()); }
  finally { generator.geometry.dispose(); }
}

test('real vendor BVH preserves skinned world vertices, smooth world normals and PBR material groups', () => {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(
    [0, 0, 0, 1, 0, 0, 0, 1, 0, 2, 0, 0, 3, 0, 0, 2, 1, 0], 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(
    [0, 0.6, 0.8, 0, 0.6, 0.8, 0, 0.6, 0.8, 0.6, 0, 0.8, 0.6, 0, 0.8, 0.6, 0, 0.8], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], 2));
  skinGeometry(g);
  g.addGroup(0, 3, 0);
  g.addGroup(3, 3, 1);
  g.setDrawRange(0, 6);
  const materials = [new THREE.MeshStandardMaterial({ color: 0xff0000 }),
    new THREE.MeshPhysicalMaterial({ color: 0x00ff00, transmission: 0.4 })];
  const { object, bone } = boundSkin(g, materials);
  bone.rotation.x = Math.PI / 2;
  bone.position.set(2, 3, 4);
  object.position.set(10, 20, 30);
  object.rotation.z = Math.PI / 2;
  object.scale.set(2, 3, 4);
  const ordinary = mesh(new THREE.MeshStandardMaterial({ color: 0x123456 }));
  ordinary.position.x = -20;
  const sourceCounts = disposalCounts([g, ...materials, ordinary.geometry, ordinary.material]);
  const positionData = Array.from(g.attributes.position.array);
  const normalData = Array.from(g.attributes.normal.array);
  const result = snapshot({ scene: sceneWith(object, ordinary) });
  assert.equal(result.bakedSkinned, 1);
  assert.equal(result.meshCount, 2);
  assert.equal(result.triangleCount, 3);
  const baked = meshes(result.scene).find((node) => Array.isArray(node.material));
  assertStaticSkin(baked, object);
  assert.deepEqual(baked.geometry.groups, g.groups);
  const bakedCounts = disposalCounts([baked.geometry]);
  const expected = [
    { color: 0xff0000, vertices: [[1, 24, 46], [1, 26, 46], [1, 24, 50]],
      normal: [16 / Math.sqrt(337), 0, 9 / Math.sqrt(337)] },
    { color: 0x00ff00, vertices: [[1, 28, 46], [1, 30, 46], [1, 28, 50]],
      normal: [8 / Math.sqrt(145), 9 / Math.sqrt(145), 0] },
    { color: 0x123456, vertices: [[-20, 0, 0], [-19, 0, 0], [-20, 1, 0]], normal: [0, 0, 1] }
  ];
  generate(result, ({ geometry: generated, materials: generatedMaterials, bvh }) => {
    assert.ok(bvh, 'real vendor BVH must be generated from ordinary baked meshes');
    assert.equal(result.meshCount, 3, 'two skinned material groups plus ordinary mesh');
    assert.equal(result.bakedSkinned, 1, 'material splitting must not count skin twice');
    assert.equal(result.triangleCount, 3);
    assert.equal(generated.index.count, 9);
    const position = generated.attributes.position;
    const normal = generated.attributes.normal;
    const ids = generated.attributes.materialIndex;
    const seenTriangles = new Map();
    for (let offset = 0; offset < generated.index.count; offset += 3) {
      let triangleColor;
      const seenVertices = new Set();
      for (let j = 0; j < 3; j++) {
        const i = generated.index.getX(offset + j);
        const material = generatedMaterials[ids.getX(i)];
        const color = material.color.getHex();
        const fixture = expected.find((item) => item.color === color);
        assert.ok(fixture, `unexpected BVH material ${color}`);
        if (triangleColor === undefined) triangleColor = color;
        assert.equal(color, triangleColor, 'material group must not mix within a triangle');
        const vertex = [position.getX(i), position.getY(i), position.getZ(i)];
        const vertexIndex = fixture.vertices.findIndex((candidate) =>
          candidate.every((value, axis) => Math.abs(vertex[axis] - value) < 1e-5));
        assert.notEqual(vertexIndex, -1, `unexpected posed world vertex ${vertex}`);
        seenVertices.add(vertexIndex);
        arrayClose([normal.getX(i), normal.getY(i), normal.getZ(i)], fixture.normal, 'BVH smooth world normal');
        if (color === 0x00ff00) {
          assert.ok(material.isMeshPhysicalMaterial);
          close(material.transmission, 0.4, 'BVH physical material');
        }
      }
      assert.equal(seenVertices.size, 3, 'every expected triangle vertex occurs once');
      seenTriangles.set(triangleColor, (seenTriangles.get(triangleColor) || 0) + 1);
    }
    for (const fixture of expected) assert.equal(seenTriangles.get(fixture.color), 1);
    const hit = bvh.raycastFirst(new THREE.Ray(
      new THREE.Vector3(5, 74 / 3, 142 / 3), new THREE.Vector3(-1, 0, 0)), THREE.DoubleSide);
    assert.ok(hit, 'BVH ray must hit the posed red triangle, not the undeformed source');
    close(hit.distance, 4, 'posed triangle BVH hit distance', 1e-5);
    arrayClose(hit.point.toArray(), [1, 74 / 3, 142 / 3], 'posed triangle BVH hit point', 1e-5);
  });
  result.prepareGeometry();
  assert.equal(result.bakedSkinned, 1, 'repeat preparation leaves skin counter stable');
  arrayClose(g.attributes.position.array, positionData, 'BVH leaves source positions unchanged');
  arrayClose(g.attributes.normal.array, normalData, 'BVH leaves source smooth normals unchanged');
  assert.equal(g.groups.length, 2);
  assert.deepEqual(g.drawRange, { start: 0, count: 6 });
  const partCounts = disposalCounts(meshes(result.scene).map((part) => part.geometry));
  result.dispose(); result.dispose();
  for (const count of [...bakedCounts.values(), ...partCounts.values()]) assert.equal(count, 1);
  assertUndisposed(sourceCounts);
});

test('BVH preserves six cube-face materials and a subsequent scalar-material mesh', () => {
  const colors = [0xff0000, 0x00ff00, 0x0000ff, 0xffff00, 0xff00ff, 0x00ffff];
  const cube = mesh(colors.map((color) => new THREE.MeshStandardMaterial({ color })), new THREE.BoxGeometry());
  const other = mesh(new THREE.MeshStandardMaterial({ color: 0x123456 }));
  other.position.x = 5;
  const result = snapshot({ scene: sceneWith(cube, other) });
  generate(result, ({ geometry: g, materials, bvh }) => {
    assert.ok(bvh, 'real BVH generated');
    assert.equal(result.meshCount, 7);
    const counts = new Array(7).fill(0);
    const p = g.attributes.position, n = g.attributes.normal, ids = g.attributes.materialIndex;
    for (let offset = 0; offset < g.index.count; offset += 3) {
      const i = g.index.getX(offset);
      const expected = p.getX(i) > 3 ? 6 : n.getX(i) > 0.5 ? 0 : n.getX(i) < -0.5 ? 1 :
        n.getY(i) > 0.5 ? 2 : n.getY(i) < -0.5 ? 3 : n.getZ(i) > 0.5 ? 4 : 5;
      for (let j = 0; j < 3; j++) {
        const vertex = g.index.getX(offset + j);
        assert.equal(materials[ids.getX(vertex)].color.getHex(), expected === 6 ? 0x123456 : colors[expected]);
      }
      counts[expected]++;
    }
    assert.deepEqual(counts, [2, 2, 2, 2, 2, 2, 1]);
  });
});

for (const indexed of [true, false]) {
  test(`material groups intersect drawRange (${indexed ? 'indexed' : 'nonindexed'}) without changing source`, () => {
    const g = new THREE.BoxGeometry();
    const source = indexed ? g : g.toNonIndexed();
    source.setDrawRange(6, 12);
    const originalColor = source.attributes.color;
    const materials = Array.from({ length: 6 }, (_, i) => new THREE.MeshStandardMaterial({ color: i + 1 }));
    const cube = mesh(materials, source);
    cube.position.set(2, 3, 4);
    cube.updateMatrixWorld(true);
    const result = snapshot({ scene: sceneWith(cube) });
    const owned = onlyMesh(result).geometry;
    const sourceCounts = disposalCounts([source, ...materials]);
    const ownedCounts = disposalCounts([owned]);
    result.prepareGeometry();
    const parts = meshes(result.scene);
    assert.equal(parts.length, 2);
    assert.deepEqual(parts.map((part) => part.material.color.getHex()), [2, 3]);
    for (const part of parts) {
      assert.equal(part.geometry.index.count, 6);
      assert.equal(part.geometry.attributes.color.itemSize, 4);
      matrixClose(part.matrixWorld, cube.matrixWorld, 'split world transform');
    }
    const partCounts = disposalCounts(parts.map((part) => part.geometry));
    assert.equal(source.attributes.color, originalColor);
    assert.deepEqual(source.drawRange, { start: 6, count: 12 });
    assert.equal(source.groups.length, 6);
    result.dispose();
    for (const count of [...ownedCounts.values(), ...partCounts.values()]) assert.equal(count, 1);
    assertUndisposed(sourceCounts);
  });

  test(`scalar drawRange excludes unrendered triangles from BVH (${indexed ? 'indexed' : 'nonindexed'})`, () => {
    const g = geometry(3, indexed);
    g.setDrawRange(3, 3);
    const result = snapshot({ scene: sceneWith(mesh(undefined, g)) });
    generate(result, ({ geometry: generated }) => assert.equal(generated.index.count, 3));
    assert.deepEqual(g.drawRange, { start: 3, count: 3 });
  });
}

for (const order of [[0, 1, 2], [2, 1, 0]]) {
  test(`BVH mixes RGB, normalized RGBA and uncolored vertices in order ${order.join(',')}`, () => {
    const objects = [mesh(), mesh(), mesh()];
    objects[0].geometry.setAttribute('color', new THREE.Float32BufferAttribute([0.2, 0.4, 0.6, 0.2, 0.4, 0.6, 0.2, 0.4, 0.6], 3));
    objects[1].geometry.setAttribute('color', new THREE.Uint8BufferAttribute([51, 102, 153, 128, 51, 102, 153, 128, 51, 102, 153, 128], 4, true));
    objects.forEach((object, i) => { object.position.x = i * 5; object.material.vertexColors = true; });
    const originals = objects.map((object) => object.geometry.attributes.color);
    const result = snapshot({ scene: sceneWith(...objects) });
    meshes(result.scene).forEach((object, i) => { object.uuid = String(order.indexOf(i)); });
    generate(result, ({ geometry: g }) => {
      assert.equal(g.attributes.color.itemSize, 4);
      assert.ok(g.attributes.color.array instanceof Float32Array);
      for (let i = 0; i < g.attributes.position.count; i++) {
        const source = Math.round(g.attributes.position.getX(i) / 5);
        const expected = source === 0 ? [0.2, 0.4, 0.6, 1] : source === 1 ? [0.2, 0.4, 0.6, 128 / 255] : [1, 1, 1, 1];
        arrayClose(Array.from(g.attributes.color.array.slice(i * 4, i * 4 + 4)), expected, 'generated RGBA');
      }
    });
    objects.forEach((object, i) => assert.equal(object.geometry.attributes.color, originals[i]));
  });
}

test('empty material groups and zero scalar drawRange leave no renderable meshes', () => {
  const multi = mesh([new THREE.MeshStandardMaterial()]);
  const scalar = mesh(); scalar.geometry.setDrawRange(0, 0);
  const result = snapshot({ scene: sceneWith(multi, scalar) });
  assert.equal(result.meshCount, 2);
  result.prepareGeometry();
  assert.equal(result.meshCount, 0);
  assert.equal(meshes(result.scene).length, 0);
});

test('groups without a matching material are skipped like the viewport renderer', () => {
  const cube = mesh([new THREE.MeshStandardMaterial()], new THREE.BoxGeometry());
  const result = snapshot({ scene: sceneWith(cube) });
  generate(result, ({ geometry: g }) => {
    assert.equal(result.meshCount, 1);
    assert.equal(g.index.count, 6);
  });
  assert.equal(cube.material.length, 1);
});

test('preparation is repeatable for shared geometry and never disposes source resources', () => {
  const g = new THREE.BoxGeometry();
  const material = new THREE.MeshStandardMaterial();
  const objects = [mesh(material, g), mesh(material, g)];
  const sourceCounts = disposalCounts([g, material]);
  const result = snapshot({ scene: sceneWith(...objects) });
  result.prepareGeometry(); result.prepareGeometry();
  assert.equal(result.meshCount, 2);
  assert.equal(meshes(result.scene)[0].geometry.attributes.color.itemSize, 4);
  assert.equal(g.attributes.color, undefined);
  result.dispose();
  assertUndisposed(sourceCounts);
});

for (const channel of [1, 2, 3]) {
  test(`UV${channel} textures fail explicitly without disposing original textures/materials`, () => {
    const texture = new THREE.Texture(); texture.channel = channel;
    const material = new THREE.MeshStandardMaterial({ map: texture });
    const g = geometry();
    const sourceCounts = disposalCounts([texture, material, g]);
    assert.throws(() => snapshot({ scene: sceneWith(mesh(material, g)) }), /UV0.*UV1/);
    assertUndisposed(sourceCounts);
  });
}

test('environmentIntensity=0 is preserved (not defaulted to 1) and Euler/degree rotations clone independently', () => {
  const srcZero = new THREE.Scene();
  srcZero.userData.environmentIntensity = 0;
  srcZero.userData.environmentRotation = new THREE.Euler(0.1, 0.5, 0.2);
  const resZero = snapshot({ scene: srcZero });
  assert.equal(resZero.environmentIntensity, 0, 'zero intensity must not fall back to 1.0');
  assert.equal(resZero.scene.environmentIntensity, 0);
  assert.notEqual(resZero.environmentRotation, srcZero.userData.environmentRotation);
  close(resZero.environmentRotation.y, 0.5, 'Euler Y rotation');
  resZero.environmentRotation.y = 9;
  close(srcZero.userData.environmentRotation.y, 0.5, 'source Euler unchanged');

  const srcDeg = new THREE.Scene();
  srcDeg.userData.environmentRotation = 90;
  const resDeg = snapshot({ scene: srcDeg });
  close(resDeg.environmentRotation.y, Math.PI / 2, 'numeric degrees converted to radians');
});

test('negative-scale mirrored mesh preserves reflection matrix and intersects correctly in real BVH', () => {
  const mirrored = mesh(new THREE.MeshStandardMaterial({ color: 0x33aa44 }), geometry(1));
  mirrored.position.set(2, 0, 0);
  mirrored.scale.set(-2, 1, 1); // triangle [0..1] maps to world X in [0..2] (flipped)
  const result = snapshot({ scene: sceneWith(mirrored) });
  const copy = onlyMesh(result);
  assert.ok(copy.matrix.determinant() < 0, 'mirrored world matrix must keep negative determinant');
  generate(result, ({ bvh }) => {
    const hit = bvh.raycastFirst(new THREE.Ray(new THREE.Vector3(1.5, 0.2, 3), new THREE.Vector3(0, 0, -1)), THREE.DoubleSide);
    assert.ok(hit, 'BVH ray must hit mirrored triangle at world (1.5, 0.2, 0)');
    close(hit.distance, 3, 'mirrored hit distance', 1e-5);
  });
});

test('prepareGeometry on empty scene and repeated dispose before prepareGeometry are safe', () => {
  const empty = snapshot({ scene: new THREE.Scene() });
  empty.prepareGeometry();
  assert.equal(empty.meshCount, 0);
  empty.dispose();
  empty.dispose();
});

console.log(`\n${passed}/${total} PATHTRACE SCENE TESTS PASSED; ${failures.length} FAILED`);
if (failures.length) {
  console.error(`Contract mismatches:\n${failures.map((name) => `- ${name}`).join('\n')}`);
  process.exitCode = 1;
}
