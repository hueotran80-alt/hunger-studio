/**
 * @file light-helper.js
 * @description Blender-style light gizmos. Each registered light gets one
 * non-selectable helper child that is shown only while the light is selected.
 * Helpers are marked as system objects so they never appear in the Outliner,
 * GLB export or project JSON.
 */

import * as THREE from 'three';

const boundManagers = new WeakSet();
const lightProxyMap = new WeakMap();
const _targetWorld = new THREE.Vector3();
const _forwardVec = new THREE.Vector3();
const _lightWorldPos = new THREE.Vector3();
const _lightWorldQuat = new THREE.Quaternion();
const DEFAULT_MAX_SHADOW_LIGHTS = 4;

function lineMaterial(color) {
  return new THREE.LineBasicMaterial({
    color,
    transparent: true,
    opacity: 0.9,
    depthTest: false
  });
}

function addCircle(parent, radius, material, segments = 32) {
  const points = [];
  for (let i = 0; i < segments; i += 1) {
    const a = (i / segments) * Math.PI * 2;
    points.push(new THREE.Vector3(Math.cos(a) * radius, Math.sin(a) * radius, 0));
  }
  const geometry = new THREE.BufferGeometry().setFromPoints(points);
  parent.add(new THREE.LineLoop(geometry, material));
}

function addSegment(parent, from, to, material) {
  const geometry = new THREE.BufferGeometry().setFromPoints([from, to]);
  parent.add(new THREE.Line(geometry, material));
}

function buildPointGizmo(group, material) {
  const wire = new THREE.WireframeGeometry(new THREE.SphereGeometry(0.28, 10, 6));
  group.add(new THREE.LineSegments(wire, material));
  addSegment(group, new THREE.Vector3(-0.45, 0, 0), new THREE.Vector3(0.45, 0, 0), material);
  addSegment(group, new THREE.Vector3(0, -0.45, 0), new THREE.Vector3(0, 0.45, 0), material);
  addSegment(group, new THREE.Vector3(0, 0, -0.45), new THREE.Vector3(0, 0, 0.45), material);
}

function buildSunGizmo(group, material) {
  addCircle(group, 0.32, material);
  for (const [x, y] of [[0, 0], [-0.25, -0.25], [0.25, -0.25], [-0.25, 0.25], [0.25, 0.25]]) {
    addSegment(
      group,
      new THREE.Vector3(x, y, 0.35),
      new THREE.Vector3(x, y, 1.15),
      material
    );
  }
}

function buildSpotGizmo(group, material, angle = Math.PI / 6) {
  const height = 2;
  const radius = Math.tan(Math.max(0.05, Math.min(angle, Math.PI / 2.2))) * height;
  const cone = new THREE.ConeGeometry(radius, height, 18, 1, true);
  cone.translate(0, -height / 2, 0);
  const mesh = new THREE.LineSegments(new THREE.WireframeGeometry(cone), material);
  mesh.rotation.x = -Math.PI / 2;
  group.add(mesh);
  addCircle(group, 0.18, material, 20);
}

function buildAreaGizmo(group, material, width = 2, height = 2) {
  const hw = Math.max(0.1, Number(width) || 2) * 0.5;
  const hh = Math.max(0.1, Number(height) || 2) * 0.5;
  const pts = [
    new THREE.Vector3(-hw, -hh, 0),
    new THREE.Vector3(hw, -hh, 0),
    new THREE.Vector3(hw, hh, 0),
    new THREE.Vector3(-hw, hh, 0),
  ];
  group.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), material));
  addSegment(group, new THREE.Vector3(-hw, -hh, 0), new THREE.Vector3(hw, hh, 0), material);
  addSegment(group, new THREE.Vector3(hw, -hh, 0), new THREE.Vector3(-hw, hh, 0), material);
  addSegment(group, new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1.2), material);
  addSegment(group, new THREE.Vector3(0, 0, -1.2), new THREE.Vector3(-0.14, 0, -0.95), material);
  addSegment(group, new THREE.Vector3(0, 0, -1.2), new THREE.Vector3(0.14, 0, -0.95), material);
}

function buildAmbientGizmo(group, material) {
  const wire = new THREE.WireframeGeometry(new THREE.SphereGeometry(0.22, 8, 5));
  group.add(new THREE.LineSegments(wire, material));
  for (const dir of [
    new THREE.Vector3(1, 0, 0), new THREE.Vector3(-1, 0, 0),
    new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, -1, 0),
    new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1)
  ]) {
    addSegment(group, dir.clone().multiplyScalar(0.28), dir.clone().multiplyScalar(0.55), material);
  }
}

function populateLightHelperGroup(light, group) {
  const color = light.color && light.color.isColor ? light.color.getHex() : 0xffffff;
  const material = lineMaterial(color);

  if (light.isPointLight) buildPointGizmo(group, material);
  else if (light.isDirectionalLight) buildSunGizmo(group, material);
  else if (light.isSpotLight) buildSpotGizmo(group, material, light.angle);
  else if (light.isRectAreaLight) buildAreaGizmo(group, material, light.width, light.height);
  else buildAmbientGizmo(group, material);
}

function disposeGroupResources(group) {
  group?.traverse?.((node) => {
    node.geometry?.dispose?.();
    if (Array.isArray(node.material)) node.material.forEach((m) => m?.dispose?.());
    else node.material?.dispose?.();
  });
}

export function getLightProxy(light) {
  if (!light) return null;
  const mapped = lightProxyMap.get(light);
  if (mapped && mapped.parent === light) return mapped;
  return light.children?.find((child) => child.userData?.isLightProxy) || null;
}

export function ensureLightProxy(light) {
  if (!light || !light.isLight || light.isAmbientLight || light.isHemisphereLight) return null;
  const cached = lightProxyMap.get(light);
  if (cached && cached.parent === light) {
    return cached;
  }
  const existing = light.children.find((child) => child.userData?.isLightProxy);
  if (existing) {
    lightProxyMap.set(light, existing);
    return existing;
  }

  const color = light.color && light.color.isColor ? light.color.getHex() : 0xffe484;
  const bulbMat = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.72,
    depthTest: true
  });
  const bulbGeo = light.isRectAreaLight
    ? new THREE.PlaneGeometry(0.42, 0.32)
    : new THREE.OctahedronGeometry(0.22, 0);
  if (light.isRectAreaLight) {
    bulbMat.side = THREE.DoubleSide;
  }
  const proxy = new THREE.Mesh(bulbGeo, bulbMat);
  proxy.name = `${light.name || light.type}.PickProxy`;
  proxy.castShadow = false;
  proxy.receiveShadow = false;
  proxy.renderOrder = 998;
  proxy.userData.isHelper = true;
  proxy.userData.isLightProxy = true;
  // Never store Object3D refs on userData (breaks Object3D.clone JSON.stringify)
  light.add(proxy);
  lightProxyMap.set(light, proxy);
  return proxy;
}

export function ensureLightHelper(light) {
  if (!light || !light.isLight) return null;
  ensureLightProxy(light);
  const cached = light.userData.lightHelper;
  if (cached && cached.parent === light) return cached;

  // Duplicated lights keep a cloned gizmo child but userData points at the
  // original gizmo; adopt the clone instead of creating a second one.
  const existingChild = light.children.find((child) => child.userData?.isLightHelper);
  if (existingChild) {
    light.userData.lightHelper = existingChild;
    return existingChild;
  }

  const group = new THREE.Group();
  group.name = `${light.name || light.type}.Gizmo`;
  group.userData.isHelper = true;
  group.userData.isSystemObject = true;
  group.userData.isLightHelper = true;
  group.userData.selectable = false;
  group.renderOrder = 999;
  group.visible = false;

  populateLightHelperGroup(light, group);

  light.add(group);
  light.userData.lightHelper = group;
  return group;
}

export function refreshLightHelper(light) {
  if (!light || !light.isLight) return null;
  const helper = ensureLightHelper(light);
  if (helper) {
    while (helper.children.length > 0) {
      const ch = helper.children.pop();
      disposeGroupResources(ch);
      helper.remove(ch);
    }
    populateLightHelperGroup(light, helper);
  }
  const proxy = getLightProxy(light);
  if (proxy?.material?.color && light.color?.isColor) {
    proxy.material.color.copy(light.color);
  }
  return helper;
}

export function syncLightDirection(light) {
  if (!light || (!light.isDirectionalLight && !light.isSpotLight) || !light.target) return false;
  if (light.userData?.useExplicitTarget === true) return false;

  // Ensure light.target is attached in scene graph so Three.js updates its matrixWorld
  if (!light.target.parent && light.parent) {
    light.parent.add(light.target);
    light.target.userData.isSystemObject = true;
    light.target.userData.isHelper = true;
    light.target.userData.selectable = false;
  }

  light.updateWorldMatrix(true, false);
  light.getWorldPosition(_lightWorldPos);
  light.getWorldQuaternion(_lightWorldQuat);
  _forwardVec.set(0, 0, -1).applyQuaternion(_lightWorldQuat).normalize();

  const worldTarget = _lightWorldPos.clone().addScaledVector(_forwardVec, 10);
  if (light.target.parent) {
    light.target.parent.updateWorldMatrix(true, false);
    light.target.parent.worldToLocal(worldTarget);
  }
  light.target.position.copy(worldTarget);
  light.target.updateMatrixWorld(true);
  return true;
}

export function enforceShadowBudget(sceneOrManager, activeObject = null, maxShadows = DEFAULT_MAX_SHADOW_LIGHTS) {
  const limit = Math.max(0, Math.floor(Number(maxShadows) || DEFAULT_MAX_SHADOW_LIGHTS));
  const lights = [];
  if (sceneOrManager?.objects instanceof Map) {
    for (const obj of sceneOrManager.objects.values()) {
      if (obj?.isLight) lights.push(obj);
    }
  }
  const sceneRoot = sceneOrManager?.scene || sceneOrManager?.rootContainer?.parent || sceneOrManager?.rootContainer || sceneOrManager;
  if (sceneRoot && typeof sceneRoot.traverse === 'function') {
    const seen = new Set(lights);
    sceneRoot.traverse((obj) => {
      if (obj?.isLight && !seen.has(obj)) {
        seen.add(obj);
        lights.push(obj);
      }
    });
  }

  const shadowLights = [];
  for (const light of lights) {
    if (!light.isDirectionalLight && !light.isSpotLight && !light.isPointLight) continue;
    if (light.userData._shadowDesired === undefined) {
      light.userData._shadowDesired = Boolean(light.castShadow);
    } else if (light.castShadow) {
      light.userData._shadowDesired = true;
    }
    if (light.userData._shadowDesired && light.visible !== false) {
      shadowLights.push(light);
    }
  }

  shadowLights.sort((a, b) => {
    const aActive = a === activeObject ? 1 : 0;
    const bActive = b === activeObject ? 1 : 0;
    if (aActive !== bActive) return bActive - aActive;
    const typeScore = (l) => (l.isDirectionalLight ? 3 : (l.isSpotLight ? 2 : 1));
    const td = typeScore(b) - typeScore(a);
    if (td !== 0) return td;
    return (Number(b.intensity) || 0) - (Number(a.intensity) || 0);
  });

  const enabled = [];
  shadowLights.forEach((light, index) => {
    const keep = index < limit;
    light.castShadow = keep;
    if (keep) {
      enabled.push(light);
      if (light.shadow?.mapSize) {
        light.shadow.mapSize.width = Math.min(2048, Math.max(256, light.shadow.mapSize.width || 1024));
        light.shadow.mapSize.height = Math.min(2048, Math.max(256, light.shadow.mapSize.height || 1024));
      }
    }
  });
  return { enabledCount: enabled.length, suppressedCount: Math.max(0, shadowLights.length - enabled.length), limit };
}

function syncLightHelpers(sceneManager) {
  const active = sceneManager.getActiveObject ? sceneManager.getActiveObject() : null;
  for (const object of sceneManager.objects.values()) {
    if (!object.isLight) continue;
    const helper = ensureLightHelper(object);
    if (!helper) continue;
    if (object.userData?.rotationDriven) {
      syncLightDirection(object);
    }
    const proxy = getLightProxy(object);
    if (proxy?.material?.color && object.color?.isColor) {
      proxy.material.color.copy(object.color);
    }
    helper.visible = object === active;
    if (helper.visible && (object.isDirectionalLight || object.isSpotLight) && object.target) {
      object.target.updateWorldMatrix(true, false);
      object.target.getWorldPosition(_targetWorld);
      helper.lookAt(_targetWorld);
    }
  }
}

export function bindLightHelpers(sceneManager) {
  if (!sceneManager || typeof sceneManager.on !== 'function' || boundManagers.has(sceneManager)) return;
  boundManagers.add(sceneManager);

  const sync = () => syncLightHelpers(sceneManager);
  const onObjectEvent = ({ object } = {}) => {
    if (object && object.isLight) {
      ensureLightHelper(object);
      enforceShadowBudget(sceneManager, sceneManager.getActiveObject?.());
    }
    sync();
  };
  const onTransform = (objOrEvent) => {
    const obj = objOrEvent?.detail?.object || objOrEvent;
    if (!obj?.isLight) return;
    if (obj.isDirectionalLight || obj.isSpotLight) {
      obj.userData.useExplicitTarget = false;
      obj.userData.rotationDriven = true;
      syncLightDirection(obj);
    }
    sync();
  };

  sceneManager.on('selectionChanged', sync);
  sceneManager.on('historyChanged', sync);
  sceneManager.on('transformChanged', onTransform);
  sceneManager.on('objectAdded', onObjectEvent);
  sceneManager.on('objectRemoved', onObjectEvent);
  sceneManager.on('sceneCleared', sync);

  // Lights that existed before binding (e.g. restored from a project).
  for (const object of sceneManager.objects.values()) {
    if (object.isLight) ensureLightHelper(object);
  }
  enforceShadowBudget(sceneManager, sceneManager.getActiveObject?.());
  sync();
}

export function removeLightHelper(light) {
  const helper = light?.userData?.lightHelper;
  if (helper) {
    disposeGroupResources(helper);
    if (helper.parent) helper.parent.remove(helper);
    light.userData.lightHelper = null;
  }
  const proxy = getLightProxy(light);
  if (proxy) {
    proxy.geometry?.dispose?.();
    proxy.material?.dispose?.();
    if (proxy.parent) proxy.parent.remove(proxy);
    lightProxyMap.delete(light);
  }
}
