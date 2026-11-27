import * as THREE from 'three';
import { DecalGeometry } from 'three/addons/geometries/DecalGeometry.js';
import { AgentError } from './agent-core.js';

const EPS = 1e-10;
const MAX_PIXELS = 16_777_216;
const invalid = message => { throw new AgentError('E_INVALID_ARG', message); };
const unsupported = message => { throw new AgentError('E_UNSUPPORTED', message); };
const missing = message => { throw new AgentError('E_NOT_FOUND', message); };

function options(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Options must be an object.');
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) invalid(`Unknown option: ${key}`);
  }
  return value;
}

function number(value, name, min = -Infinity, max = Infinity) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    invalid(`${name} must be a finite number in [${min}, ${max}].`);
  }
  return value;
}

function tuple(value, length, name, scalar = false) {
  if (scalar && typeof value === 'number') value = Array(length).fill(value);
  if (value?.isVector2 || value?.isVector3) value = value.toArray();
  if (!Array.isArray(value) || value.length !== length) invalid(`${name} must contain ${length} numbers.`);
  return value.map(v => number(v, name));
}

function vector(value, name) { return new THREE.Vector3(...tuple(value, 3, name)); }
function channelName(channel = 0) {
  number(channel, 'channel', 0, 3);
  if (!Number.isInteger(channel)) invalid('channel must be an integer (0–3 in Three.js r160).');
  return channel === 0 ? 'uv' : `uv${channel}`;
}

function geometryOf(mesh) {
  if (mesh.isInstancedMesh) unsupported('Specify a regular mesh; instanced geometry cannot be edited independently.');
  const geometry = mesh.geometry;
  const position = geometry?.getAttribute('position');
  if (!geometry?.isBufferGeometry || !position) missing('Mesh has no position geometry.');
  const count = geometry.index?.count ?? position.count;
  if (position.itemSize !== 3 || count % 3 !== 0) unsupported('Only triangle BufferGeometry is supported.');
  for (let i = 0; i < position.count; i++) {
    if (![position.getX(i), position.getY(i), position.getZ(i)].every(Number.isFinite)) {
      invalid('Geometry contains non-finite positions.');
    }
  }
  if (geometry.index) {
    for (let i = 0; i < count; i++) {
      const index = geometry.index.getX(i);
      if (!Number.isInteger(index) || index < 0 || index >= position.count) invalid('Invalid geometry index.');
    }
  }
  return geometry;
}

function uvOf(geometry, channel = 0) {
  const name = channelName(channel);
  const uv = geometry.getAttribute(name);
  if (!uv) missing(`Geometry has no ${name} attribute. Use uv.unwrap or uv.project first.`);
  if (uv.itemSize !== 2 || uv.count !== geometry.getAttribute('position').count) invalid(`Invalid ${name} attribute.`);
  for (let i = 0; i < uv.count; i++) {
    if (!Number.isFinite(uv.getX(i)) || !Number.isFinite(uv.getY(i))) invalid(`${name} contains non-finite coordinates.`);
  }
  return uv;
}

function expandAttribute(attribute, indices) {
  if (attribute.isInstancedBufferAttribute) unsupported('Instanced vertex attributes cannot be unwrapped.');
  const source = attribute.isInterleavedBufferAttribute ? attribute.data.array : attribute.array;
  if (!source) unsupported('GPU-only vertex attributes cannot be edited.');
  const array = new source.constructor(indices.length * attribute.itemSize);
  const stride = attribute.isInterleavedBufferAttribute ? attribute.data.stride : attribute.itemSize;
  const offset = attribute.isInterleavedBufferAttribute ? attribute.offset : 0;
  for (let i = 0; i < indices.length; i++) {
    if (indices[i] >= attribute.count) invalid('Vertex attribute count does not match the index.');
    for (let c = 0; c < attribute.itemSize; c++) {
      array[i * attribute.itemSize + c] = source[indices[i] * stride + offset + c];
    }
  }
  const result = attribute.isFloat16BufferAttribute ? new THREE.Float16BufferAttribute(array, attribute.itemSize, attribute.normalized) :
    new THREE.BufferAttribute(array, attribute.itemSize, attribute.normalized);
  result.name = attribute.name;
  result.setUsage(attribute.usage ?? attribute.data?.usage ?? THREE.StaticDrawUsage);
  if (attribute.gpuType !== undefined) result.gpuType = attribute.gpuType;
  return result;
}

function editableGeometry(geometry) {
  const clone = geometry.clone();
  if (!geometry.index) return clone;
  const indices = Array.from({ length: geometry.index.count }, (_, i) => geometry.index.getX(i));
  for (const [name, attribute] of Object.entries(geometry.attributes)) {
    clone.setAttribute(name, expandAttribute(attribute, indices));
  }
  clone.morphAttributes = {};
  for (const [name, targets] of Object.entries(geometry.morphAttributes)) {
    clone.morphAttributes[name] = targets.map(attribute => expandAttribute(attribute, indices));
  }
  clone.setIndex(null);
  return clone;
}

function facesOf(geometry) {
  const position = geometry.getAttribute('position');
  const count = geometry.index?.count ?? position.count;
  const faces = [];
  for (let i = 0; i < count; i += 3) {
    const indices = [0, 1, 2].map(j => geometry.index ? geometry.index.getX(i + j) : i + j);
    const points = indices.map(index => new THREE.Vector3().fromBufferAttribute(position, index));
    const areaNormal = new THREE.Vector3().subVectors(points[1], points[0])
      .cross(new THREE.Vector3().subVectors(points[2], points[0]));
    faces.push({ index: i / 3, indices, points, normal: areaNormal.clone().normalize(), areaNormal });
  }
  return faces;
}

function adjacency(faces, uv = null) {
  const bounds = new THREE.Box3();
  faces.forEach(face => face.points.forEach(point => bounds.expandByPoint(point)));
  const tolerance = Math.max(bounds.getSize(new THREE.Vector3()).length() * 1e-7, 1e-12);
  const edges = new Map();
  const neighbors = faces.map(() => new Set());
  const key = (point, index) => {
    let result = point.toArray().map(v => Math.round(v / tolerance)).join(',');
    if (uv) result += `:${Math.round(uv.getX(index) / 1e-7)},${Math.round(uv.getY(index) / 1e-7)}`;
    return result;
  };
  for (const face of faces) {
    const keys = face.points.map((p, i) => key(p, face.indices[i]));
    for (let i = 0; i < 3; i++) {
      const a = keys[i], b = keys[(i + 1) % 3];
      if (a === b) continue;
      const edge = a < b ? `${a}|${b}` : `${b}|${a}`;
      if (!edges.has(edge)) edges.set(edge, []);
      edges.get(edge).push(face.index);
    }
  }
  for (const incident of edges.values()) {
    if (incident.length !== 2 || incident[0] === incident[1]) continue;
    neighbors[incident[0]].add(incident[1]);
    neighbors[incident[1]].add(incident[0]);
  }
  return neighbors;
}

function cubeNormal(normal) {
  const a = [Math.abs(normal.x), Math.abs(normal.y), Math.abs(normal.z)];
  const axis = a[0] >= a[1] && a[0] >= a[2] ? 0 : a[1] >= a[2] ? 1 : 2;
  const result = new THREE.Vector3();
  result.setComponent(axis, normal.getComponent(axis) < 0 ? -1 : 1);
  return result;
}

function basis(normal, rotation = 0) {
  if (!Number.isFinite(normal.length()) || normal.length() === 0) invalid('normal must have a finite, nonzero length.');
  const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal.clone().normalize());
  quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), rotation));
  return {
    quaternion,
    u: new THREE.Vector3(1, 0, 0).applyQuaternion(quaternion),
    v: new THREE.Vector3(0, 1, 0).applyQuaternion(quaternion),
    n: normal.clone().normalize()
  };
}

function growCharts(faces, neighbors, accepts) {
  const visited = new Set(), charts = [];
  for (const seed of faces) {
    if (visited.has(seed.index)) continue;
    const chart = { faces: [], first: seed.index };
    const queue = [seed.index];
    visited.add(seed.index);
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const current = faces[queue[cursor]];
      chart.faces.push(current.index);
      for (const index of neighbors[current.index]) {
        if (!visited.has(index) && accepts(seed, current, faces[index])) {
          visited.add(index);
          queue.push(index);
        }
      }
    }
    charts.push(chart);
  }
  return charts;
}

function chartBounds(chart, uv, faces) {
  chart.min = [Infinity, Infinity];
  chart.max = [-Infinity, -Infinity];
  for (const index of chart.faces) {
    for (const vertex of faces[index].indices) {
      const point = [uv.getX(vertex), uv.getY(vertex)];
      for (let c = 0; c < 2; c++) {
        chart.min[c] = Math.min(chart.min[c], point[c]);
        chart.max[c] = Math.max(chart.max[c], point[c]);
      }
    }
  }
  chart.width = chart.max[0] - chart.min[0];
  chart.height = chart.max[1] - chart.min[1];
}

function shelfPack(charts, uv, faces, margin, rotate) {
  number(margin, 'margin', 0, 0.49);
  if (typeof rotate !== 'boolean') invalid('rotate must be a boolean.');
  if (!charts.length) missing('Geometry has no faces to pack.');
  charts.forEach(chart => chartBounds(chart, uv, faces));
  const extent = charts.reduce((largest, chart) => Math.max(largest, chart.width, chart.height), 1e-12);
  const rectangles = charts.map(chart => {
    const rotated = rotate && chart.width > chart.height;
    return { chart, rotated, width: Math.max(rotated ? chart.height : chart.width, extent * 1e-9),
      height: Math.max(rotated ? chart.width : chart.height, extent * 1e-9) };
  }).sort((a, b) => b.height - a.height || b.width - a.width || a.chart.first - b.chart.first);
  const arrange = scale => {
    const shelves = [], placements = [];
    let usedHeight = 0;
    for (const rectangle of rectangles) {
      const width = rectangle.width * scale + margin * 2;
      const height = rectangle.height * scale + margin * 2;
      let shelf = shelves.find(s => height <= s.height + 1e-12 && s.x + width <= 1 + 1e-12);
      if (!shelf) {
        if (width > 1 + 1e-12 || usedHeight + height > 1 + 1e-12) return null;
        shelf = { x: 0, y: usedHeight, height };
        shelves.push(shelf);
        usedHeight += height;
      }
      placements.push({ rectangle, x: shelf.x + margin, y: shelf.y + margin });
      shelf.x += width;
    }
    return placements;
  };
  if (!arrange(0)) throw new AgentError('E_TOO_LARGE', 'Chart margins cannot fit in the UV square. Reduce margin.');
  let low = 0, high = 1 / extent;
  for (let i = 0; i < 56; i++) {
    const mid = (low + high) / 2;
    if (arrange(mid)) low = mid; else high = mid;
  }
  for (const { rectangle, x, y } of arrange(low)) {
    const chart = rectangle.chart;
    for (const index of chart.faces) {
      for (const vertex of faces[index].indices) {
        const u = uv.getX(vertex) - chart.min[0], v = uv.getY(vertex) - chart.min[1];
        uv.setXY(vertex, x + (rectangle.rotated ? chart.height - v : u) * low,
          y + (rectangle.rotated ? u : v) * low);
      }
    }
  }
  uv.needsUpdate = true;
  return { charts: charts.length, packingScale: low, margin, rotate };
}

function worldReady(mesh) {
  mesh.updateWorldMatrix(true, false);
  const determinant = mesh.matrixWorld.determinant();
  if (!Number.isFinite(determinant) || determinant === 0) invalid('Mesh world transform is singular.');
  if (mesh.isSkinnedMesh) {
    if (!mesh.skeleton) missing('Skinned mesh has no bound skeleton.');
    mesh.updateMatrixWorld(true);
    mesh.skeleton.bones.forEach(bone => bone.updateWorldMatrix(true, false));
    mesh.skeleton.update();
  }
  return determinant < 0 ? -1 : 1;
}

function resolveFaces(mesh, geometry, region, ctx) {
  const faces = facesOf(geometry);
  if (region == null) return faces.map(face => face.index);
  if (Array.isArray(region)) region = { faceIndices: region };
  if (!region || typeof region !== 'object') invalid('region must be a selection or a region descriptor.');
  if (region.meshAgentId !== undefined && ctx.node(region.meshAgentId) !== mesh) invalid('Region belongs to a different mesh.');
  if (region.faceIndices !== undefined) {
    options(region, ['faceIndices', 'meshAgentId', 'mode', 'faceCount']);
    if (!Array.isArray(region.faceIndices)) invalid('faceIndices must be an array.');
    for (const index of region.faceIndices) {
      if (!Number.isInteger(index) || index < 0 || index >= faces.length) invalid('faceIndices contains an invalid face index.');
    }
    return [...new Set(region.faceIndices)].sort((a, b) => a - b);
  }
  const { mode, space = 'local' } = region;
  if (!['local', 'world'].includes(space)) invalid('space must be local or world.');
  const handedness = space === 'world' ? worldReady(mesh) : 1;
  const pointsOf = face => space === 'world' ? face.indices.map(index =>
    mesh.getVertexPosition(index, new THREE.Vector3()).applyMatrix4(mesh.matrixWorld)) : face.points;
  let test;
  if (mode === 'box') {
    options(region, ['mode', 'space', 'min', 'max']);
    const min = vector(region.min, 'min'), max = vector(region.max, 'max');
    if (min.x > max.x || min.y > max.y || min.z > max.z) invalid('Box min must not exceed max.');
    const box = new THREE.Box3(min, max);
    test = face => box.containsPoint(pointsOf(face).reduce((sum, p) => sum.add(p), new THREE.Vector3()).multiplyScalar(1 / 3));
  } else if (mode === 'sphere') {
    options(region, ['mode', 'space', 'center', 'radius']);
    const center = vector(region.center, 'center'), radius = number(region.radius, 'radius', 0);
    test = face => pointsOf(face).reduce((sum, p) => sum.add(p), new THREE.Vector3()).multiplyScalar(1 / 3).distanceTo(center) <= radius;
  } else if (mode === 'normal') {
    options(region, ['mode', 'space', 'normal', 'direction', 'angleLimit']);
    if (region.normal !== undefined && region.direction !== undefined) invalid('Supply either normal or direction, not both.');
    const direction = vector(region.normal ?? region.direction, 'normal');
    if (!Number.isFinite(direction.length()) || direction.length() === 0) invalid('normal must have a finite, nonzero length.');
    direction.normalize();
    const limit = Math.cos(THREE.MathUtils.degToRad(number(region.angleLimit ?? 30, 'angleLimit', 0, 180)));
    test = face => {
      const points = pointsOf(face);
      const normal = new THREE.Vector3().subVectors(points[1], points[0])
        .cross(new THREE.Vector3().subVectors(points[2], points[0])).multiplyScalar(handedness);
      return normal.lengthSq() > 0 && normal.normalize().dot(direction) >= limit - 1e-12;
    };
  } else if (mode === 'byName') {
    options(region, ['mode', 'name']);
    if (typeof region.name !== 'string' || !region.name) invalid('name must be a nonempty string.');
    const named = mesh.userData?.faceRegions?.[region.name] ?? geometry.userData?.faceRegions?.[region.name]
      ?? mesh.userData?.regions?.[region.name] ?? geometry.userData?.regions?.[region.name];
    if (named !== undefined) return resolveFaces(mesh, geometry, { faceIndices: Array.isArray(named) ? named : named.faceIndices }, ctx);
    const materials = ctx.materialsOf(mesh);
    test = face => mesh.name === region.name || geometry.groups.some(group =>
      face.index * 3 >= group.start && face.index * 3 + 2 < group.start + group.count &&
      (group.name === region.name || materials[group.materialIndex]?.name === region.name)) ||
      (!geometry.groups.length && materials[0]?.name === region.name);
  } else invalid('mode must be box, sphere, normal, or byName.');
  return faces.filter(test).map(face => face.index);
}

function canvas(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 ||
      width > 8192 || height > 8192 || width * height > MAX_PIXELS) {
    throw new AgentError('E_TOO_LARGE', 'Texture canvas must be at most 8192 per side and 16 megapixels.');
  }
  const result = typeof document !== 'undefined' ? document.createElement('canvas') :
    typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(width, height) : null;
  if (!result) unsupported('Texture baking requires Canvas2D.');
  result.width = width;
  result.height = height;
  if (!result.getContext('2d')) unsupported('Canvas2D is unavailable.');
  return result;
}

function imageCanvas(texture) {
  if (texture.isCompressedTexture || texture.isCubeTexture || texture.isData3DTexture ||
      texture.isDataArrayTexture || texture.isDepthTexture || texture.isVideoTexture || texture.isRenderTargetTexture) {
    unsupported('Baking requires a loaded 2D image or unsigned-byte RGBA DataTexture.');
  }
  const image = texture.image;
  if (!image) missing('Texture has no loaded image.');
  const width = image.naturalWidth ?? image.videoWidth ?? image.width;
  const height = image.naturalHeight ?? image.videoHeight ?? image.height;
  if (!width || !height) missing('Texture image is not loaded.');
  const result = canvas(width, height), context = result.getContext('2d');
  try {
    if (image.data) {
      if (texture.type !== THREE.UnsignedByteType || texture.format !== THREE.RGBAFormat || image.data.length !== width * height * 4) {
        unsupported('Only unsigned-byte RGBA DataTextures can be baked.');
      }
      const pixels = context.createImageData(width, height);
      pixels.data.set(image.data);
      context.putImageData(pixels, 0, 0);
    } else context.drawImage(image, 0, 0, width, height);
    context.getImageData(0, 0, 1, 1);
  } catch (error) {
    if (error instanceof AgentError) throw error;
    throw new AgentError(error.name === 'SecurityError' ? 'E_CORS' : 'E_UNSUPPORTED', `Cannot read texture image: ${error.message}`);
  }
  return result;
}

function textureMatrix(texture) {
  if (!texture) return new THREE.Matrix3();
  return texture.matrixAutoUpdate ? new THREE.Matrix3().setUvTransform(texture.offset.x, texture.offset.y,
    texture.repeat.x, texture.repeat.y, texture.rotation, texture.center.x, texture.center.y) : texture.matrix.clone();
}

function wrap(value, mode) {
  if (mode === THREE.RepeatWrapping) return value - Math.floor(value);
  if (mode === THREE.MirroredRepeatWrapping) {
    const tile = Math.floor(value), fraction = value - tile;
    return Math.abs(tile % 2) === 1 ? 1 - fraction : fraction;
  }
  if (mode !== THREE.ClampToEdgeWrapping) unsupported('Unsupported texture wrapping mode.');
  return Math.max(0, Math.min(1, value));
}

function projectorImage(texture) {
  const source = imageCanvas(texture), width = source.width, height = source.height;
  const sourcePixels = source.getContext('2d').getImageData(0, 0, width, height).data;
  const result = canvas(width, height), context = result.getContext('2d');
  const output = context.createImageData(width, height), matrix = textureMatrix(texture);
  const uv = new THREE.Vector2();
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      uv.set((x + 0.5) / width, 1 - (y + 0.5) / height).applyMatrix3(matrix);
      let u = wrap(uv.x, texture.wrapS), v = wrap(uv.y, texture.wrapT);
      if (texture.flipY) v = 1 - v;
      const sx = u * width - 0.5, sy = v * height - 0.5;
      const ix = Math.floor(sx), iy = Math.floor(sy), fx = sx - ix, fy = sy - iy;
      const at = (px, py, c) => sourcePixels[(Math.max(0, Math.min(height - 1, py)) * width + Math.max(0, Math.min(width - 1, px))) * 4 + c];
      for (let c = 0; c < 4; c++) {
        output.data[(y * width + x) * 4 + c] =
          at(ix, iy, c) * (1 - fx) * (1 - fy) + at(ix + 1, iy, c) * fx * (1 - fy) +
          at(ix, iy + 1, c) * (1 - fx) * fy + at(ix + 1, iy + 1, c) * fx * fy;
      }
    }
  }
  context.putImageData(output, 0, 0);
  return result;
}

function clipPlane(polygon, distance) {
  const result = [];
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i], b = polygon[(i + 1) % polygon.length];
    const da = distance(a), db = distance(b);
    if (da >= 0) result.push(a);
    if ((da >= 0) !== (db >= 0)) {
      const t = da / (da - db);
      result.push({ p: a.p.clone().lerp(b.p, t), uv: a.uv.clone().lerp(b.uv, t) });
    }
  }
  return result;
}

function clipProjector(polygon, size) {
  for (let axis = 0; axis < 3 && polygon.length; axis++) {
    const half = size.getComponent(axis) / 2;
    polygon = clipPlane(polygon, vertex => half - vertex.p.getComponent(axis));
    polygon = clipPlane(polygon, vertex => half + vertex.p.getComponent(axis));
  }
  return polygon;
}

function area2(a, b, c) { return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x); }
function polygonArea(polygon) {
  let area = 0;
  for (let i = 1; i + 1 < polygon.length; i++) area += area2(polygon[0], polygon[i], polygon[i + 1]);
  return Math.abs(area) / 2;
}

function overlaps(a, b) {
  if (polygonArea(a) <= 1e-12 || polygonArea(b) <= 1e-12) return false;
  const bounds = points => points.reduce((box, p) => box.expandByPoint(new THREE.Vector3(p.x, p.y, 0)), new THREE.Box3());
  if (!bounds(a).intersectsBox(bounds(b))) return false;
  let polygon = a;
  const sign = area2(b[0], b[1], b[2]) >= 0 ? 1 : -1;
  for (let edge = 0; edge < b.length && polygon.length; edge++) {
    const start = b[edge], end = b[(edge + 1) % b.length], output = [];
    for (let i = 0; i < polygon.length; i++) {
      const p = polygon[i], q = polygon[(i + 1) % polygon.length];
      const dp = sign * area2(start, end, p), dq = sign * area2(start, end, q);
      if (dp >= 0) output.push(p);
      if ((dp >= 0) !== (dq >= 0)) output.push(p.clone().lerp(q, dp / (dp - dq)));
    }
    polygon = output;
  }
  return polygonArea(polygon) > 1e-12;
}

function drawAffine(context, image, source, target, opacity) {
  const det = area2(source[0], source[1], source[2]);
  if (Math.abs(det) < EPS || Math.abs(area2(target[0], target[1], target[2])) < EPS) return false;
  const sx1 = source[1].x - source[0].x, sy1 = source[1].y - source[0].y;
  const sx2 = source[2].x - source[0].x, sy2 = source[2].y - source[0].y;
  const tx1 = target[1].x - target[0].x, ty1 = target[1].y - target[0].y;
  const tx2 = target[2].x - target[0].x, ty2 = target[2].y - target[0].y;
  const a = (tx1 * sy2 - tx2 * sy1) / det, c = (tx2 * sx1 - tx1 * sx2) / det;
  const b = (ty1 * sy2 - ty2 * sy1) / det, d = (ty2 * sx1 - ty1 * sx2) / det;
  context.save();
  try {
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.beginPath();
    context.moveTo(target[0].x, target[0].y);
    context.lineTo(target[1].x, target[1].y);
    context.lineTo(target[2].x, target[2].y);
    context.closePath();
    context.clip();
    context.globalAlpha = opacity;
    context.globalCompositeOperation = 'source-over';
    context.setTransform(a, b, c, d, target[0].x - a * source[0].x - c * source[0].y,
      target[0].y - b * source[0].x - d * source[0].y);
    context.drawImage(image, 0, 0);
  } finally { context.restore(); }
  return true;
}

function materialIndex(geometry, face, materials) {
  if (materials.length === 1) return 0;
  const groups = geometry.groups.filter(group => face * 3 >= group.start && face * 3 + 2 < group.start + group.count);
  if (groups.length !== 1 || !materials[groups[0].materialIndex]) unsupported('Baking requires unambiguous material groups for every face.');
  return groups[0].materialIndex;
}

function bakeDecal(mesh, geometry, texture, position, frame, size, opacity, ctx) {
  const handedness = worldReady(mesh), faces = facesOf(geometry), materials = ctx.materialsOf(mesh);
  if (!materials.length) missing('Mesh has no original materials.');
  const inverse = frame.quaternion.clone().invert(), jobs = new Map();
  const posed = faces.map(face => {
    const world = face.indices.map(index => mesh.getVertexPosition(index, new THREE.Vector3()).applyMatrix4(mesh.matrixWorld));
    const normal = new THREE.Vector3().subVectors(world[1], world[0])
      .cross(new THREE.Vector3().subVectors(world[2], world[0])).multiplyScalar(handedness).normalize();
    return { face, world, normal, slot: materialIndex(geometry, face.index, materials) };
  });
  for (const { face, world, normal, slot } of posed) {
    if (normal.dot(frame.n) <= 1e-6) continue;
    const material = materials[slot], old = material.map;
    const uv = uvOf(geometry, old?.channel ?? 0);
    let polygon = face.indices.map((index, i) => ({
      p: world[i].clone().sub(position).applyQuaternion(inverse),
      uv: new THREE.Vector2().fromBufferAttribute(uv, index)
    }));
    polygon = clipProjector(polygon, size);
    if (polygon.length < 3 || polygonArea(polygon.map(v => new THREE.Vector2(v.p.x, v.p.y))) < EPS) continue;
    if (!jobs.has(slot)) jobs.set(slot, { material, old, polygons: [], uv, matrix: textureMatrix(old) });
    jobs.get(slot).polygons.push({ face: face.index, vertices: polygon });
  }
  if (!jobs.size) missing('Projector does not intersect any front-facing triangles.');
  const source = projectorImage(texture), staged = [];
  try {
    for (const [slot, job] of jobs) {
      if (job.material.isShaderMaterial || job.material.isRawShaderMaterial || !('map' in job.material)) {
        unsupported('Original material does not support a base texture map.');
      }
      if (job.old && job.old.colorSpace !== texture.colorSpace) unsupported('Source and base texture color spaces must match for Canvas2D baking.');
      const target = job.old ? imageCanvas(job.old) : canvas(1024, 1024);
      const context = target.getContext('2d');
      if (!job.old) { context.fillStyle = '#ffffff'; context.fillRect(0, 0, target.width, target.height); }
      const mapped = uv => {
        const point = uv.clone().applyMatrix3(job.matrix);
        if (job.old?.flipY ?? true) point.y = 1 - point.y;
        return point;
      };
      const triangles = posed.filter(entry => entry.slot === slot).map(({ face }) => ({
        face: face.index,
        points: face.indices.map(index => mapped(new THREE.Vector2().fromBufferAttribute(job.uv, index)))
      }));
      if (triangles.some(triangle => triangle.points.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y) ||
          p.x < -1e-7 || p.x > 1 + 1e-7 || p.y < -1e-7 || p.y > 1 + 1e-7))) {
        unsupported('Baking across wrapped or clamped base UV boundaries is unsafe. Unwrap to unique UVs first.');
      }
      for (const polygon of job.polygons) {
        const destination = polygon.vertices.map(v => mapped(v.uv));
        if (triangles.some(triangle => triangle.face !== polygon.face && overlaps(destination, triangle.points))) {
          unsupported('Overlapping base UVs would bleed the decal onto other faces. Unwrap to unique UVs first.');
        }
        for (let i = 1; i + 1 < polygon.vertices.length; i++) {
          const vertices = [polygon.vertices[0], polygon.vertices[i], polygon.vertices[i + 1]];
          const sourcePoints = vertices.map(v => new THREE.Vector2((v.p.x / size.x + 0.5) * source.width,
            (0.5 - v.p.y / size.y) * source.height));
          const targetPoints = [destination[0], destination[i], destination[i + 1]]
            .map(v => new THREE.Vector2(v.x * target.width, v.y * target.height));
          drawAffine(context, source, sourcePoints, targetPoints, opacity);
        }
      }
      const map = job.old ? new THREE.Texture().copy(job.old) : new THREE.CanvasTexture(target);
      map.source = new THREE.Source(target);
      if (!job.old) map.colorSpace = texture.colorSpace || THREE.SRGBColorSpace;
      map.name = `${job.old?.name || mesh.name || 'Mesh'}_decal`;
      delete map.userData[ctx.textures.key];
      map.needsUpdate = true;
      const material = job.material.clone();
      delete material.userData.agentMatId;
      material.map = map;
      material.needsUpdate = true;
      staged.push({ slot, material, map, faces: job.polygons.length });
    }
    const replacements = materials.slice();
    staged.forEach(entry => { replacements[entry.slot] = entry.material; });
    ctx.setMaterials(mesh, replacements);
    const bakedTextures = staged.map(entry => ({ textureId: ctx.textures.assign(entry.map), materialIndex: entry.slot, faces: entry.faces }));
    ctx.changed();
    return { meshAgentId: ctx.ids.assign(mesh), sourceTextureId: ctx.textures.assign(texture), baked: true,
      decalAgentId: null, faces: staged.reduce((sum, entry) => sum + entry.faces, 0), textures: bakedTextures };
  } catch (error) {
    staged.forEach(entry => { entry.map.dispose(); entry.material.dispose(); });
    throw error;
  }
}

export function createGeometryTools(ctx) {
  const commitUV = (id, mesh, geometry, channel, extra = {}) => {
    geometry.getAttribute(channelName(channel)).needsUpdate = true;
    mesh.geometry = geometry;
    ctx.changed();
    return { meshAgentId: id, channel, attribute: channelName(channel),
      vertices: geometry.getAttribute('position').count, faces: geometry.getAttribute('position').count / 3, ...extra };
  };
  const uv = {
    list(id) {
      const geometry = geometryOf(ctx.mesh(id)), channels = [];
      for (let channel = 0; channel < 4; channel++) {
        if (!geometry.hasAttribute(channelName(channel))) continue;
        const attribute = uvOf(geometry, channel);
        const min = [Infinity, Infinity], max = [-Infinity, -Infinity];
        for (let i = 0; i < attribute.count; i++) {
          min[0] = Math.min(min[0], attribute.getX(i)); min[1] = Math.min(min[1], attribute.getY(i));
          max[0] = Math.max(max[0], attribute.getX(i)); max[1] = Math.max(max[1], attribute.getY(i));
        }
        channels.push({ channel, attribute: channelName(channel), vertices: attribute.count,
          min: attribute.count ? min : null, max: attribute.count ? max : null });
      }
      return { meshAgentId: id, channels };
    },

    unwrap(id, input = {}) {
      const { method = 'smart', angleLimit = 66, margin = 0.02, channel = 0 } =
        options(input, ['method', 'angleLimit', 'margin', 'channel']);
      if (method === 'angle' || method === 'conformal') unsupported(`True ${method} unwrapping is not implemented. Use smart or cube.`);
      if (!['smart', 'cube'].includes(method)) invalid('method must be smart, cube, angle, or conformal.');
      number(angleLimit, 'angleLimit', 0, 180);
      if (method === 'cube' && input.angleLimit !== undefined) unsupported('angleLimit is only applicable to smart unwrapping.');
      channelName(channel);
      number(margin, 'margin', 0, 0.49);
      const mesh = ctx.mesh(id), geometry = editableGeometry(geometryOf(mesh)), faces = facesOf(geometry);
      const neighbors = adjacency(faces), cosine = Math.max(Math.cos(THREE.MathUtils.degToRad(angleLimit)), 1e-6);
      const charts = growCharts(faces, neighbors, (seed, current, candidate) => {
        if (!seed.areaNormal.lengthSq() || !candidate.areaNormal.lengthSq()) return false;
        if (method === 'cube') return cubeNormal(seed.normal).equals(cubeNormal(candidate.normal));
        return seed.normal.dot(candidate.normal) >= cosine - 1e-12 && current.normal.dot(candidate.normal) >= cosine - 1e-12;
      });
      const attribute = new THREE.Float32BufferAttribute(new Float32Array(geometry.getAttribute('position').count * 2), 2);
      for (const chart of charts) {
        const seed = faces[chart.first];
        const normal = seed.areaNormal.lengthSq() ? (method === 'cube' ? cubeNormal(seed.normal) : seed.normal) : new THREE.Vector3(0, 0, 1);
        const frame = basis(normal), origin = seed.points[0];
        for (const index of chart.faces) {
          const face = faces[index];
          face.indices.forEach((vertex, i) => {
            const relative = face.points[i].clone().sub(origin);
            attribute.setXY(vertex, relative.dot(frame.u), relative.dot(frame.v));
          });
        }
      }
      geometry.setAttribute(channelName(channel), attribute);
      const packed = shelfPack(charts, attribute, faces, margin, false);
      return commitUV(id, mesh, geometry, channel, { method, ...packed });
    },

    project(id, input = {}) {
      const { from = 'front', channel = 0, scale = [1, 1], offset = [0, 0] } =
        options(input, ['from', 'channel', 'scale', 'offset']);
      channelName(channel);
      const s = tuple(scale, 2, 'scale', true), o = tuple(offset, 2, 'offset');
      const directions = { front: [0, 0, 1], back: [0, 0, -1], right: [1, 0, 0], left: [-1, 0, 0], top: [0, 1, 0], bottom: [0, -1, 0] };
      const mesh = ctx.mesh(id), geometry = editableGeometry(geometryOf(mesh));
      let normal, world = false, origin = new THREE.Vector3();
      if (from === 'camera') {
        const camera = ctx.engine?.camera;
        if (!camera) missing('No active camera is available.');
        camera.updateWorldMatrix(true, false);
        normal = camera.getWorldDirection(new THREE.Vector3()).negate();
        origin = camera.getWorldPosition(new THREE.Vector3());
        worldReady(mesh);
        world = true;
      } else if (typeof from === 'string') {
        if (!directions[from]) invalid('from must be front, back, left, right, top, bottom, camera, or a direction vector.');
        normal = new THREE.Vector3(...directions[from]);
      } else normal = vector(from, 'from');
      const frame = basis(normal), position = geometry.getAttribute('position');
      const attribute = new THREE.Float32BufferAttribute(new Float32Array(position.count * 2), 2);
      let minU = Infinity, minV = Infinity, maxU = -Infinity, maxV = -Infinity;
      for (let i = 0; i < position.count; i++) {
        const point = new THREE.Vector3().fromBufferAttribute(position, i);
        if (world) point.applyMatrix4(mesh.matrixWorld).sub(origin);
        const u = point.dot(frame.u), v = point.dot(frame.v);
        attribute.setXY(i, u, v);
        minU = Math.min(minU, u); maxU = Math.max(maxU, u);
        minV = Math.min(minV, v); maxV = Math.max(maxV, v);
      }
      if (!position.count) missing('Geometry has no vertices to project.');
      const extent = Math.max(maxU - minU, maxV - minV, 1e-12);
      for (let i = 0; i < position.count; i++) {
        attribute.setXY(i, ((attribute.getX(i) - (minU + maxU) / 2) / extent + 0.5) * s[0] + o[0],
          ((attribute.getY(i) - (minV + maxV) / 2) / extent + 0.5) * s[1] + o[1]);
      }
      geometry.setAttribute(channelName(channel), attribute);
      return commitUV(id, mesh, geometry, channel, { from: typeof from === 'string' ? from : normal.toArray(), scale: s, offset: o });
    },

    pack(id, input = {}) {
      const { margin = 0.02, rotate = true, channel = 0 } = options(input, ['margin', 'rotate', 'channel']);
      const mesh = ctx.mesh(id), original = geometryOf(mesh);
      uvOf(original, channel);
      const geometry = editableGeometry(original), source = uvOf(geometry, channel), faces = facesOf(geometry);
      const attribute = new THREE.Float32BufferAttribute(new Float32Array(source.count * 2), 2);
      for (let i = 0; i < source.count; i++) attribute.setXY(i, source.getX(i), source.getY(i));
      geometry.setAttribute(channelName(channel), attribute);
      const charts = growCharts(faces, adjacency(faces, attribute), () => true);
      return commitUV(id, mesh, geometry, channel, shelfPack(charts, attribute, faces, margin, rotate));
    },

    transform(id, input = {}) {
      const { channel = 0, offset = [0, 0], scale = [1, 1], rotation = 0, region = null } =
        options(input, ['channel', 'offset', 'scale', 'rotation', 'region']);
      const o = tuple(offset, 2, 'offset'), s = tuple(scale, 2, 'scale', true);
      number(rotation, 'rotation');
      const mesh = ctx.mesh(id), original = geometryOf(mesh);
      uvOf(original, channel);
      const selected = resolveFaces(mesh, original, region, ctx);
      if (!selected.length) return { meshAgentId: id, channel, faceIndices: [], faces: 0, modified: false };
      const geometry = editableGeometry(original), attribute = uvOf(geometry, channel);
      // A fresh float attribute also makes normalized/interleaved UV input safe to transform.
      const result = new THREE.Float32BufferAttribute(new Float32Array(attribute.count * 2), 2);
      for (let i = 0; i < attribute.count; i++) result.setXY(i, attribute.getX(i), attribute.getY(i));
      const cosine = Math.cos(rotation), sine = Math.sin(rotation);
      for (const face of selected) {
        for (let j = 0; j < 3; j++) {
          const i = face * 3 + j, u = (attribute.getX(i) - 0.5) * s[0], v = (attribute.getY(i) - 0.5) * s[1];
          result.setXY(i, u * cosine - v * sine + 0.5 + o[0], u * sine + v * cosine + 0.5 + o[1]);
        }
      }
      geometry.setAttribute(channelName(channel), result);
      return commitUV(id, mesh, geometry, channel, { faceIndices: selected, transformedFaces: selected.length, offset: o, scale: s, rotation });
    },

    selectRegion(id, input = {}) {
      const mesh = ctx.mesh(id), geometry = geometryOf(mesh);
      const faceIndices = resolveFaces(mesh, geometry, input, ctx);
      return { meshAgentId: id, mode: input.mode ?? null, faceCount: faceIndices.length, faceIndices };
    }
  };

  const decal = {
    project(input = {}) {
      const { meshAgentId, textureId, position, normal, size, rotation = 0, opacity = 1, blendMode = 'normal', bake = false } =
        options(input, ['meshAgentId', 'textureId', 'position', 'normal', 'size', 'rotation', 'opacity', 'blendMode', 'bake']);
      if (blendMode !== 'normal') unsupported(`blendMode ${blendMode} is not implemented; use normal.`);
      if (typeof bake !== 'boolean') invalid('bake must be a boolean.');
      number(rotation, 'rotation'); number(opacity, 'opacity', 0, 1);
      const center = vector(position, 'position'), direction = vector(normal, 'normal');
      const box = tuple(size, Array.isArray(size) && size.length === 2 ? 2 : 3, 'size', true);
      const dimensions = new THREE.Vector3(box[0], box[1], box[2] ?? Math.max(box[0], box[1]));
      if (dimensions.toArray().some(v => v <= 0)) invalid('size components must be positive world-space dimensions.');
      const frame = basis(direction, rotation), mesh = ctx.mesh(meshAgentId), geometry = geometryOf(mesh);
      const texture = ctx.textures.get(textureId);
      if (!texture?.isTexture) missing(`Texture ${textureId} was not found.`);
      if (mesh.isSkinnedMesh && !bake) unsupported('Skinned meshes require bake: true so decals preserve deformation.');
      if (bake) return bakeDecal(mesh, geometry, texture, center, frame, dimensions, opacity, ctx);
      if (mesh.morphTargetInfluences?.some(value => value !== 0)) unsupported('Active morph deformation requires bake: true.');
      const handedness = worldReady(mesh), faces = facesOf(geometry), vertices = [], normals = [];
      const sourceNormal = geometry.getAttribute('normal'), normalMatrix = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
      for (const face of faces) {
        const world = face.points.map(p => p.clone().applyMatrix4(mesh.matrixWorld));
        const faceNormal = new THREE.Vector3().subVectors(world[1], world[0])
          .cross(new THREE.Vector3().subVectors(world[2], world[0])).multiplyScalar(handedness).normalize();
        if (faceNormal.dot(frame.n) <= 1e-6) continue;
        face.indices.forEach((index, i) => {
          vertices.push(...world[i].toArray());
          const n = sourceNormal ? new THREE.Vector3().fromBufferAttribute(sourceNormal, index).applyNormalMatrix(normalMatrix) : faceNormal;
          normals.push(...n.toArray());
        });
      }
      const proxyGeometry = new THREE.BufferGeometry();
      proxyGeometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
      proxyGeometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
      const proxy = new THREE.Mesh(proxyGeometry, null);
      let projected;
      try {
        projected = new DecalGeometry(proxy, center, new THREE.Euler().setFromQuaternion(frame.quaternion), dimensions);
      } finally { proxyGeometry.dispose(); }
      if (!projected.getAttribute('position').count) {
        projected.dispose();
        missing('Projector does not intersect any front-facing triangles.');
      }
      // DecalGeometry emits world vertices. The child must store mesh-local vertices.
      projected.applyMatrix4(mesh.matrixWorld.clone().invert());
      projected.computeBoundingBox(); projected.computeBoundingSphere();
      const material = new THREE.MeshStandardMaterial({ map: texture, transparent: true, opacity,
        roughness: 1, metalness: 0, depthWrite: false, polygonOffset: true,
        polygonOffsetFactor: -4, polygonOffsetUnits: -4, blending: THREE.NormalBlending });
      // A decal uses its own projector UVs, not the source mesh's texture channel.
      if (texture.channel !== 0) {
        projected.setAttribute(channelName(texture.channel), projected.getAttribute('uv').clone());
      }
      const object = new THREE.Mesh(projected, material);
      object.name = `${mesh.name || 'Mesh'}_Decal`;
      object.userData.decal = { meshAgentId, textureId, position: center.toArray(), normal: frame.n.toArray(),
        size: dimensions.toArray(), rotation, opacity, blendMode };
      try {
        ctx.sceneManager.addObject(object, mesh, false, false);
        const decalAgentId = ctx.ids.assign(object);
        ctx.changed();
        return { meshAgentId, decalAgentId, textureId, baked: false,
          vertices: projected.getAttribute('position').count, faces: projected.getAttribute('position').count / 3 };
      } catch (error) {
        projected.dispose(); material.dispose();
        throw error;
      }
    }
  };
  return { uv, decal };
}
