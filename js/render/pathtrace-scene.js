import * as THREE from 'three';

const isPBR = (material) => material?.isMeshStandardMaterial || material?.isMeshPhysicalMaterial;

function excluded(node, root) {
  for (let parent = node; parent; parent = parent.parent) {
    if (!parent.visible) return true;
    if (parent !== root) {
      const data = parent.userData || {};
      if (data.isSystemObject || data.isHelper || data.isLightHelper || data.isCameraPart ||
          data.isCameraObject || parent.isCamera || parent.isTransformControls || parent.isBone) return true;
    }
  }
  return false;
}

export function getTracingSize(width, height, scale) {
  if (![width, height].every((n) => Number.isFinite(n) && n > 0) || ![0.5, 1, 2].includes(scale)) {
    throw new Error('Invalid render dimensions.');
  }
  const factor = Math.min(scale, 2048 / width, 2048 / height, Math.sqrt(2000000 / (width * height)));
  return { width: Math.max(1, Math.floor(width * factor)), height: Math.max(1, Math.floor(height * factor)) };
}

export function cloneTracingCamera(source, aspect) {
  source.updateWorldMatrix(true, false);
  const camera = source.isOrthographicCamera
    ? new THREE.OrthographicCamera(source.left, source.right, source.top, source.bottom, source.near, source.far)
    : new THREE.PerspectiveCamera(source.fov, aspect, source.near, source.far);
  source.matrixWorld.decompose(camera.position, camera.quaternion, camera.scale);
  camera.up.copy(source.up);
  camera.zoom = source.zoom;
  camera.layers.mask = source.layers.mask;
  if (camera.isOrthographicCamera) {
    const center = (source.left + source.right) / 2;
    const halfWidth = (source.top - source.bottom) * aspect / 2;
    camera.left = center - halfWidth;
    camera.right = center + halfWidth;
  } else {
    camera.filmGauge = source.filmGauge;
    camera.filmOffset = source.filmOffset;
  }
  if (source.view) camera.view = { ...source.view };
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  return camera;
}

export function buildTracingScene({ scene, rootContainer = null, lightsGroup = null, maxTriangles = 200000 }) {
  const out = new THREE.Scene();
  out.background = scene.background?.isColor ? scene.background.clone() : null;
  const resources = new Set();
  const materials = new Map();
  const textures = new Map();
  const geometries = new Map();
  const visited = new Set();
  const result = {
    scene: out, meshCount: 0, lightCount: 0, bakedSkinned: 0, skippedSkinned: 0, skippedMaterial: 0,
    triangleCount: 0, environmentSkipped: false, bakedInstanceColors: 0,
    prepareGeometry() {
      const meshNodes = [];
      out.traverse((node) => { if (node.isMesh) meshNodes.push(node); });
      for (const mesh of meshNodes) {
        const geometry = mesh.geometry;
        const color = geometry.attributes.color;
        const rgba = new Float32Array(geometry.attributes.position.count * 4);
        for (let i = 0; i < rgba.length / 4; i++) {
          rgba[i * 4] = color ? color.getX(i) : 1;
          rgba[i * 4 + 1] = color ? color.getY(i) : 1;
          rgba[i * 4 + 2] = color ? color.getZ(i) : 1;
          rgba[i * 4 + 3] = color?.itemSize === 4 ? color.getW(i) : 1;
        }
        geometry.setAttribute('color', new THREE.BufferAttribute(rgba, 4));
        const total = geometry.index?.count ?? geometry.attributes.position.count;
        const multiple = Array.isArray(mesh.material);
        if (!multiple && geometry.drawRange.start === 0 && geometry.drawRange.count >= total) continue;
        // The generator ignores drawRange and assigns one material per mesh instead of per group.
        const groups = multiple ? geometry.groups : [{ start: 0, count: total }];
        for (const group of groups) {
          const material = multiple ? mesh.material[group.materialIndex] : mesh.material;
          if (!material) continue;
          const start = Math.max(group.start, geometry.drawRange.start);
          const end = Math.min(total, group.start + group.count, geometry.drawRange.start + geometry.drawRange.count);
          if (end <= start) continue;
          const part = geometry.clone();
          const indices = geometry.index
            ? geometry.index.array.slice(start, end)
            : Uint32Array.from({ length: end - start }, (_, i) => start + i);
          part.setIndex(new THREE.BufferAttribute(indices, 1));
          part.clearGroups();
          part.setDrawRange(0, Infinity);
          resources.add(part);
          const child = new THREE.Mesh(part, material);
          child.name = mesh.name;
          child.matrix.copy(mesh.matrix);
          child.matrixAutoUpdate = false;
          out.add(child);
        }
        out.remove(mesh);
      }
      result.meshCount = 0;
      out.traverse((node) => { if (node.isMesh) result.meshCount++; });
      out.updateMatrixWorld(true);
    },
    dispose() {
      for (const resource of resources) resource.dispose();
      resources.clear();
      out.clear();
    }
  };
  function copyTexture(texture) {
    if (!textures.has(texture)) {
      const clone = texture.clone();
      clone.needsUpdate = true;
      textures.set(texture, clone);
      resources.add(clone);
    }
    return textures.get(texture);
  }
  function copyMaterial(material) {
    if (!materials.has(material)) {
      const clone = material.clone();
      for (const key of Object.keys(clone)) {
        const val = clone[key];
        if (val?.isTexture) {
          const texCopy = copyTexture(val);
          // GLB aoMap/lightMap commonly target UV1 (channel 1); remap cleanly to UV0 for path tracer
          if (texCopy.channel !== 0) {
            if (key === 'aoMap' || key === 'lightMap') {
              texCopy.channel = 0;
            } else {
              throw new Error(`Texture "${key}" uses UV${texCopy.channel}; path tracing supports UV0 textures only (UV1+ unsupported).`);
            }
          }
          clone[key] = texCopy;
        }
      }
      materials.set(material, clone);
      resources.add(clone);
    }
    return materials.get(material);
  }
  function tintMaterial(material, color) {
    const clone = material.clone();
    clone.color = material.color.clone().multiply(color);
    resources.add(clone);
    return clone;
  }
  function bakeSkin(node, geometry) {
    // updateWorldMatrix does not refresh SkinnedMesh.bindMatrixInverse in r160.
    const bindInverse = node.bindMode === THREE.AttachedBindMode
      ? node.matrixWorld.clone().invert() : node.bindMatrix.clone().invert();
    const bones = node.skeleton.bones.map((bone, i) => {
      bone.updateWorldMatrix(true, false);
      return new THREE.Matrix4().multiplyMatrices(bone.matrixWorld, node.skeleton.boneInverses[i])
        .premultiply(bindInverse).multiply(node.bindMatrix);
    });
    const { skinIndex, skinWeight } = node.geometry.attributes;
    const count = node.geometry.attributes.position.count;
    const position = new THREE.Float32BufferAttribute(new Float32Array(count * 3), 3);
    const normal = node.geometry.attributes.normal && new THREE.Float32BufferAttribute(new Float32Array(count * 3), 3);
    const tangent = node.geometry.attributes.tangent && new THREE.Float32BufferAttribute(new Float32Array(count * 4), 4);
    geometry.setAttribute('position', position);
    if (normal) geometry.setAttribute('normal', normal);
    if (tangent) geometry.setAttribute('tangent', tangent);
    const vertex = new THREE.Vector3(), posed = new THREE.Vector4();
    const direction = new THREE.Vector3(), baseNormal = new THREE.Vector3(), delta = new THREE.Vector3();
    const indices = new THREE.Vector4(), weights = new THREE.Vector4();
    const skin = new THREE.Matrix4(), rotation = new THREE.Matrix3();
    const morphNormals = node.geometry.morphAttributes.normal;
    for (let i = 0; i < position.count; i++) {
      THREE.Mesh.prototype.getVertexPosition.call(node, i, vertex);
      indices.fromBufferAttribute(skinIndex, i);
      weights.fromBufferAttribute(skinWeight, i);
      skin.elements.fill(0);
      for (let j = 0; j < 4; j++) {
        const weight = weights.getComponent(j);
        if (weight === 0) continue;
        const matrix = bones[indices.getComponent(j)].elements;
        for (let k = 0; k < 16; k++) skin.elements[k] += weight * matrix[k];
      }
      posed.set(vertex.x, vertex.y, vertex.z, 1).applyMatrix4(skin);
      position.setXYZ(i, posed.x, posed.y, posed.z);
      rotation.setFromMatrix4(skin);
      if (normal) {
        baseNormal.fromBufferAttribute(node.geometry.attributes.normal, i);
        direction.copy(baseNormal);
        if (morphNormals && node.morphTargetInfluences) {
          for (let j = 0; j < morphNormals.length; j++) {
            const weight = node.morphTargetInfluences[j];
            if (weight === 0) continue;
            delta.fromBufferAttribute(morphNormals[j], i);
            if (!node.geometry.morphTargetsRelative) delta.sub(baseNormal);
            direction.addScaledVector(delta, weight);
          }
        }
        direction.applyMatrix3(rotation).normalize();
        normal.setXYZ(i, direction.x, direction.y, direction.z);
      }
      if (tangent) {
        direction.fromBufferAttribute(node.geometry.attributes.tangent, i).applyMatrix3(rotation).normalize();
        tangent.setXYZW(i, direction.x, direction.y, direction.z, node.geometry.attributes.tangent.getW(i));
      }
    }
    geometry.morphAttributes = {};
    geometry.deleteAttribute('skinIndex');
    geometry.deleteAttribute('skinWeight');
    if (!normal) geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
  }
  function copyGeometry(node) {
    if (!geometries.has(node.geometry) || node.isSkinnedMesh || node.morphTargetInfluences?.some((n) => n !== 0)) {
      const geometry = node.geometry.clone();
      resources.add(geometry);
      if (node.isSkinnedMesh) {
        bakeSkin(node, geometry);
      } else if (node.morphTargetInfluences?.some((n) => n !== 0)) {
        const position = geometry.attributes.position;
        const vertex = new THREE.Vector3();
        for (let i = 0; i < position.count; i++) {
          node.getVertexPosition(i, vertex);
          position.setXYZ(i, vertex.x, vertex.y, vertex.z);
        }
        geometry.morphAttributes = {};
        geometry.computeVertexNormals();
      } else {
        geometries.set(node.geometry, geometry);
      }
      return geometry;
    }
    return geometries.get(node.geometry);
  }
  function addMesh(node, geometry, material, matrix) {
    const triangles = (geometry.index?.count ?? geometry.attributes.position.count) / 3;
    result.triangleCount += triangles;
    if (result.triangleCount > maxTriangles) throw new Error(`Scene exceeds the ${maxTriangles} triangles limit for Path Tracing.`);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = node.name;
    mesh.matrix.copy(matrix);
    mesh.matrixAutoUpdate = false;
    out.add(mesh);
    result.meshCount++;
  }
  function visit(node, root) {
    if (visited.has(node) || excluded(node, root)) return;
    visited.add(node);
    if (node.isMesh) {
      const original = node.userData?.__originalMaterial || node.material;
      const list = Array.isArray(original) ? original : [original];
      if (!list.length || !list.every(isPBR)) { result.skippedMaterial++; return; }
      if (node.isSkinnedMesh && (!node.skeleton || !node.geometry.attributes.skinIndex || !node.geometry.attributes.skinWeight)) {
        result.skippedSkinned++;
        return;
      }
      const triangles = (node.geometry.index?.count ?? node.geometry.attributes.position.count) / 3;
      if (result.triangleCount + triangles * (node.isInstancedMesh ? node.count : 1) > maxTriangles) {
        throw new Error(`Scene exceeds the ${maxTriangles} triangles limit for Path Tracing.`);
      }
      const copied = list.map(copyMaterial);
      const material = Array.isArray(original) ? copied : copied[0];
      const geometry = copyGeometry(node);
      if (node.isInstancedMesh) {
        const instance = new THREE.Matrix4();
        const instanceColor = new THREE.Color();
        for (let i = 0; i < node.count; i++) {
          node.getMatrixAt(i, instance);
          let mat = material;
          if (node.instanceColor) {
            node.getColorAt(i, instanceColor);
            mat = Array.isArray(material) ? material.map((m) => tintMaterial(m, instanceColor)) : tintMaterial(material, instanceColor);
            result.bakedInstanceColors++;
          }
          addMesh(node, geometry, mat, instance.premultiply(node.matrixWorld));
        }
      } else {
        addMesh(node, geometry, material, node.matrixWorld);
        if (node.isSkinnedMesh) result.bakedSkinned++;
      }
      return;
    }
    let light;
    if (node.isPointLight) light = new THREE.PointLight(node.color, node.intensity, node.distance, node.decay);
    else if (node.isSpotLight) light = new THREE.SpotLight(node.color, node.intensity, node.distance, node.angle, node.penumbra, node.decay);
    else if (node.isDirectionalLight) light = new THREE.DirectionalLight(node.color, node.intensity);
    else if (node.isRectAreaLight) light = new THREE.RectAreaLight(node.color, node.intensity, node.width, node.height);
    if (light) {
      node.matrixWorld.decompose(light.position, light.quaternion, light.scale);
      if (node.target) {
        light.target.position.copy(node.target.getWorldPosition(new THREE.Vector3()));
        out.add(light.target);
      }
      out.add(light);
      result.lightCount++;
    }
  }
  try {
    const rawSource = scene.userData?.rawEnvironmentSource;
    let targetEnv = null;

    if (rawSource && rawSource.isDataTexture && rawSource.format === THREE.RGBAFormat &&
        ((rawSource.type === THREE.HalfFloatType && rawSource.image?.data instanceof Uint16Array) ||
         (rawSource.type === THREE.FloatType && rawSource.image?.data instanceof Float32Array))) {
      targetEnv = rawSource;
    } else if (rawSource && rawSource.isDataTexture && rawSource.image?.data) {
      targetEnv = rawSource;
    } else if (scene.environment) {
      const environment = scene.environment;
      const envData = environment.image?.data;
      const rawHDR = environment.isDataTexture && environment.format === THREE.RGBAFormat &&
        ((environment.type === THREE.HalfFloatType && envData instanceof Uint16Array) ||
          (environment.type === THREE.FloatType && envData instanceof Float32Array));
      if (rawHDR) {
        targetEnv = environment;
      }
    }

    if (targetEnv) {
      out.environment = copyTexture(targetEnv);
      result.environmentSkipped = false;
    } else {
      result.environmentSkipped = !!scene.environment || !!rawSource;
    }

    out.environmentIntensity = scene.environmentIntensity !== undefined
      ? scene.environmentIntensity
      : (scene.userData?.environmentIntensity !== undefined ? scene.userData.environmentIntensity : 1.0);

    if (scene.environmentRotation instanceof THREE.Euler) {
      out.environmentRotation = scene.environmentRotation.clone();
    } else if (typeof scene.userData?.environmentRotation === 'number') {
      out.environmentRotation = new THREE.Euler(0, scene.userData.environmentRotation * Math.PI / 180, 0);
    } else if (scene.userData?.environmentRotation instanceof THREE.Euler) {
      out.environmentRotation = scene.userData.environmentRotation.clone();
    } else {
      out.environmentRotation = new THREE.Euler(0, 0, 0);
    }

    result.environmentIntensity = out.environmentIntensity;
    result.environmentRotation = out.environmentRotation;
    const root = rootContainer || scene;
    root.updateWorldMatrix(true, true);
    root.traverse((node) => visit(node, root));
    if (lightsGroup) {
      lightsGroup.updateWorldMatrix(true, true);
      lightsGroup.traverse((node) => { if (node.isLight) visit(node, lightsGroup); });
    }
    if (result.lightCount === 0) {
      const key = new THREE.DirectionalLight(0xffffff, 3);
      key.position.set(5, 8, 6);
      const fill = new THREE.DirectionalLight(0xbfd4ff, 1.2);
      fill.position.set(-6, 4, -4);
      out.add(key, fill);
      result.lightCount = 2;
    }
    out.updateMatrixWorld(true);
    return result;
  } catch (error) {
    result.dispose();
    throw error;
  }
}
