import { BufferGeometry, Matrix4, Quaternion, Vector3 } from '../../vendor/three/three.module.js';

const MAX_OBJECTS = 5000;
const MAX_PAYLOAD_BYTES = 24 * 1024 * 1024;
const OBJECT_TYPES = new Set([
  'Scene', 'Group', 'Object3D', 'Mesh', 'SkinnedMesh', 'InstancedMesh', 'Bone', 'Armature',
  'Line', 'LineSegments', 'LineLoop', 'Points', 'Sprite', 'LOD',
  'AmbientLight', 'DirectionalLight', 'HemisphereLight', 'PointLight', 'SpotLight', 'RectAreaLight',
  'Camera', 'OrthographicCamera', 'PerspectiveCamera', 'CubeCamera',
  'AxesHelper', 'GridHelper', 'PolarGridHelper', 'SkeletonHelper', 'BoxHelper',
  'DirectionalLightHelper', 'HemisphereLightHelper', 'PointLightHelper', 'SpotLightHelper',
  'ViewHelper', 'TransformControls'
]);
const SCENE_RESOURCES = ['geometries', 'materials', 'textures', 'images', 'shapes', 'skeletons', 'animations'];

function fail(message) {
  throw Object.assign(new Error(message), { code: 'E_INVALID_RESULT' });
}

function safeUserData(value, seen = new WeakSet(), depth = 0) {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
  if (typeof value === 'bigint') return String(value);
  if (typeof value !== 'object') return undefined;
  if (depth > 20 || seen.has(value) || value.isObject3D || value.isTexture || value.isMaterial || value.isBufferGeometry || value.isSkeleton) return undefined;
  if (value instanceof Date) return value.toISOString();
  if (ArrayBuffer.isView(value)) return Array.from(value.length > 100000 ? value.slice(0, 100000) : value);
  seen.add(value);
  let result;
  if (Array.isArray(value)) {
    result = value.slice(0, 100000).map((item) => safeUserData(item, seen, depth + 1) ?? null);
  } else {
    result = {};
    for (const [key, item] of Object.entries(value)) {
      if (['skeleton', 'baseGeometry', 'texture'].includes(key)) continue;
      const clean = safeUserData(item, seen, depth + 1);
      if (clean !== undefined) Object.defineProperty(result, key, { value: clean, enumerable: true, configurable: true, writable: true });
    }
  }
  seen.delete(value);
  return result;
}

function serializeRoot(root) {
  const restore = [];
  const processed = new WeakSet();
  const geometrySnapshots = new Map();
  root.updateMatrixWorld(true);
  const snapshotGeometry = (source) => {
    if (!source?.isBufferGeometry || source.parameters === undefined) return null;
    if (geometrySnapshots.has(source)) return geometrySnapshots.get(source);
    const geometry = new BufferGeometry();
    geometry.uuid = source.uuid;
    geometry.name = source.name;
    geometry.copy(source);
    geometrySnapshots.set(source, geometry);
    return geometry;
  };
  const visit = (object) => {
    const geometry = snapshotGeometry(object.geometry);
    if (geometry) {
      restore.push([object, 'geometry', object.geometry]);
      object.geometry = geometry;
    }
    if (object.material === null || (Array.isArray(object.material) && object.material.some((material) => material == null))) {
      restore.push([object, 'material', object.material]);
      object.material = undefined;
    }
    for (const value of [object, object.geometry, ...(Array.isArray(object.material) ? object.material : [object.material])]) {
      if (!value?.userData || processed.has(value)) continue;
      processed.add(value);
      restore.push([value, 'userData', value.userData]);
      value.userData = safeUserData(value.userData) || {};
    }
    object.children.forEach(visit);
  };
  visit(root);
  try { return root.toJSON(); } finally {
    restore.forEach(([target, key, value]) => { target[key] = value; });
  }
}

function normalizeNode(node) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) fail('Invalid scene object.');
  let position = Array.isArray(node.position) ? [...node.position] : [0, 0, 0];
  let quaternion = Array.isArray(node.quaternion) ? [...node.quaternion] : [0, 0, 0, 1];
  let scale = Array.isArray(node.scale) ? [...node.scale] : [1, 1, 1];
  if (Array.isArray(node.matrix) && node.matrix.length === 16) {
    const matrix = new Matrix4().fromArray(node.matrix);
    const nextPosition = new Vector3();
    const nextQuaternion = new Quaternion();
    const nextScale = new Vector3();
    matrix.decompose(nextPosition, nextQuaternion, nextScale);
    position = nextPosition.toArray();
    quaternion = nextQuaternion.toArray();
    scale = nextScale.toArray();
  }
  const { matrix, rotation, children, userData, ...properties } = node;
  void matrix;
  void rotation;
  return {
    ...properties,
    name: typeof node.name === 'string' ? node.name : '',
    visible: typeof node.visible === 'boolean' ? node.visible : true,
    position,
    quaternion,
    scale,
    userData: safeUserData(userData || {}),
    children: Array.isArray(children) ? children.map(normalizeNode) : [],
  };
}

export function serializeScene(root) {
  if (!root || typeof root.toJSON !== 'function') fail('Scene root cannot be serialized.');
  const animations = [];
  root.traverse((object) => {
    if (Array.isArray(object.animations) && object.animations.length) {
      animations.push({
        objectUUID: object.uuid,
        clips: object.animations.slice(0, 100).map((clip) => clip.toJSON())
      });
    }
  });
  return sanitizeScenePayload({ scene: serializeRoot(root), animations });
}

export function sanitizeScenePayload(payload) {
  if (!payload || !payload.scene || typeof payload.scene !== 'object') fail('Worker returned an invalid scene payload.');
  const wrapper = payload.scene.object && payload.scene.metadata ? payload.scene : null;
  const scene = normalizeNode(wrapper?.object || payload.scene);
  if (wrapper) {
    for (const key of SCENE_RESOURCES) {
      if (wrapper[key] !== undefined) scene[key] = wrapper[key];
    }
  }
  const cleanMaterials = (value, seen = new WeakSet()) => {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach((item) => cleanMaterials(item, seen));
      return;
    }
    for (const key of Object.keys(value)) {
      if (key === 'url' || key === 'images') {
        delete value[key];
        continue;
      }
      cleanMaterials(value[key], seen);
    }
  };
  if (Array.isArray(scene.materials)) cleanMaterials(scene.materials);
  if (Array.isArray(scene.geometries)) {
    if (scene.geometries.length > 20000) fail('Geometry table exceeds the safety limit.');
    for (const geometry of scene.geometries) {
      if (geometry && typeof geometry === 'object') {
        cleanMaterials(geometry.userData);
        if (geometry.userData !== undefined) geometry.userData = safeUserData(geometry.userData);
      }
    }
  }
  if (Array.isArray(scene.materials) && scene.materials.length > 20000) fail('Material table exceeds the safety limit.');
  if (Array.isArray(scene.materials)) {
    for (const material of scene.materials) {
      if (material && typeof material === 'object' && material.userData !== undefined) material.userData = safeUserData(material.userData);
    }
  }
  const imagePlaceholder = () => ({ data: [0, 0, 0, 255], width: 1, height: 1, type: 'Uint8Array' });
  const safeImageURL = (value) => {
    if (Array.isArray(value)) return value.map(safeImageURL);
    if (typeof value === 'string' && /^data:image\/(?:png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/i.test(value)) return value;
    if (value && typeof value === 'object' && Array.isArray(value.data)
      && Number.isInteger(value.width) && value.width > 0 && value.width <= 16384
      && Number.isInteger(value.height) && value.height > 0 && value.height <= 16384
      && typeof value.type === 'string' && value.type.length <= 32) {
      return { data: value.data, width: value.width, height: value.height, type: value.type };
    }
    return imagePlaceholder();
  };
  if (Array.isArray(scene.images)) {
    if (scene.images.length > 20000) fail('Image table exceeds the safety limit.');
    for (const image of scene.images) {
      if (!image || typeof image !== 'object' || typeof image.uuid !== 'string') fail('Invalid image resource.');
      image.url = safeImageURL(image.url);
    }
  }
  const imageUUIDs = new Set(Array.isArray(scene.images) ? scene.images.map((image) => image.uuid) : []);
  if (Array.isArray(scene.textures)) {
    if (scene.textures.length > 20000) fail('Texture table exceeds the safety limit.');
    for (const texture of scene.textures) {
      if (!texture || typeof texture !== 'object') continue;
      delete texture.url;
      cleanMaterials(texture.image);
      if (typeof texture.image === 'string' && !imageUUIDs.has(texture.image)) delete texture.image;
    }
  }
  const animations = Array.isArray(payload.animations)
    ? payload.animations.map((entry) => ({
      objectUUID: String(entry?.objectUUID || ''),
      clips: Array.isArray(entry?.clips) ? entry.clips.slice(0, 100).map((clip) => safeUserData(clip)) : []
    }))
    : [];
  return { scene, animations };
}

export function scenePayloadSize(payload) {
  try {
    return JSON.stringify(payload).length;
  } catch {
    fail('Scene payload is not serializable.');
  }
}

export function sceneLoaderDocument(payload) {
  const { geometries, materials, textures, images, shapes, skeletons, animations, ...object } = payload.scene;
  return { object, geometries, materials, textures, images, shapes, skeletons, animations };
}

export function validateScenePayload(payload, { maxObjects = MAX_OBJECTS } = {}) {
  const clean = sanitizeScenePayload(payload);
  if (scenePayloadSize(clean) > MAX_PAYLOAD_BYTES) fail('Scene payload exceeds the 24 MB safety limit.');
  if (!Array.isArray(clean.scene.children)) fail('Scene payload has no children array.');
  if (clean.scene.geometries !== undefined && !Array.isArray(clean.scene.geometries)) fail('Invalid geometry table.');
  if (clean.scene.materials !== undefined && !Array.isArray(clean.scene.materials)) fail('Invalid material table.');

  const uuids = new Set();
  let count = 0;
  const visit = (node, parentUUID = null) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) fail('Invalid scene object.');
    if (typeof node.uuid !== 'string' || !node.uuid || uuids.has(node.uuid)) fail('Invalid or duplicated object UUID.');
    uuids.add(node.uuid);
    if (!OBJECT_TYPES.has(node.type)) fail(`Unsupported object type: ${node.type}`);
    if (typeof node.name !== 'string' || node.name.length > 200) fail('Object name exceeds 200 characters.');
    if (typeof node.visible !== 'boolean') fail('Invalid object visibility.');
    if (node.userData !== undefined && (!node.userData || typeof node.userData !== 'object' || Array.isArray(node.userData))) fail('Invalid object userData.');
    for (const key of ['geometry', 'material']) {
      if (node[key] !== undefined && node[key] !== null && !['string', 'number'].includes(typeof node[key]) && !Array.isArray(node[key])) fail(`Invalid object ${key} reference.`);
    }
    count += 1;
    if (count > maxObjects) fail('Scene exceeds the object safety limit.');
    for (const key of ['position', 'quaternion', 'scale']) {
      const values = node[key];
      const length = key === 'quaternion' ? 4 : 3;
      if (!Array.isArray(values) || values.length !== length || !values.every(Number.isFinite)) fail(`Invalid object ${key}.`);
    }
    if (!Array.isArray(node.children)) fail('Scene object children must be an array.');
    for (const child of node.children) visit(child, node.uuid);
    void parentUUID;
  };
  visit(clean.scene);
  for (const entry of clean.animations) {
    if (!entry || typeof entry.objectUUID !== 'string' || !uuids.has(entry.objectUUID)) fail('Animation references a missing object.');
    if (!Array.isArray(entry.clips) || entry.clips.length > 100 || entry.clips.some((clip) => !clip || typeof clip !== 'object' || !Array.isArray(clip.tracks) || clip.tracks.length > 10000)) fail('Invalid animation clip.');
  }
  return clean;
}

export function collectSceneObjects(root) {
  const objects = new Map();
  root.traverse((object) => objects.set(object.uuid, object));
  return objects;
}

export function sceneSelectionUUIDs(root, selection = []) {
  const objects = collectSceneObjects(root);
  return selection.filter((object) => object && objects.has(object.uuid)).map((object) => object.uuid);
}
