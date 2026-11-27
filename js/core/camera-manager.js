/**
 * @file camera-manager.js
 * @description Scene camera objects, look-through view and camera helpers.
 */

import * as THREE from 'three';
import { TransformCommand } from './scene-manager.js';

const SENSOR_HEIGHT_MM = 24;

export class CameraManager {
  constructor(engine, options = {}) {
    this.engine = engine;
    this.sceneManager = options.sceneManager || engine.sceneManager || null;
    this.cameras = [];
    this.activeCamera = null;
    this.lookingThrough = null;
    this.lockToView = false;
    this._savedView = null;
    this._overlay = null;
    this._lockControlsCleanup = null;

    if (this.sceneManager) {
      this.sceneManager.on('objectAdded', ({ object }) => this._adoptCameraObject(object));
      this.sceneManager.on('objectRemoved', ({ object }) => this._onObjectRemoved(object));
      this.sceneManager.on('selectionChanged', ({ active }) => this._syncHelpers(active));
      this.sceneManager.on('historyChanged', () => this._refreshHelperGeometry());
      this.sceneManager.on('sceneCleared', () => this._onSceneCleared());
    }
  }

  _aspect() {
    const camera = this.engine.camera;
    return camera?.isOrthographicCamera
      ? (camera.right - camera.left) / (camera.top - camera.bottom)
      : camera?.aspect ?? 1.0;
  }

  /**
   * Creates a camera object (body mesh + PerspectiveCamera + helper).
   * The returned Group is what gets registered/selected in the Outliner.
   */
  createCamera(options = {}) {
    const sm = this.sceneManager;
    if (!sm) return null;

    const {
      name = 'Camera',
      position = { x: 6, y: 4, z: 8 },
      target = { x: 0, y: 1, z: 0 },
      fov = 50,
      near = 0.1,
      far = 2000,
      makeActive = true
    } = options;

    const group = new THREE.Group();
    group.name = name;
    group.userData.isCameraObject = true;

    const camera = new THREE.PerspectiveCamera(fov, this._aspect(), near, far);
    camera.name = `${name}.Data`;
    camera.userData.isCameraData = true;
    camera.userData.selectable = false;
    group.add(camera);

    const bodyMat = new THREE.MeshStandardMaterial({
      color: 0x3a3f46,
      roughness: 0.55,
      metalness: 0.45
    });
    const lensMat = new THREE.MeshStandardMaterial({
      color: 0x1b1f24,
      roughness: 0.25,
      metalness: 0.85,
      emissive: 0x0b2230
    });

    const body = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.34, 0.62), bodyMat);
    body.name = `${name}.Body`;
    body.castShadow = false;
    body.receiveShadow = false;
    body.userData.isCameraBody = true;
    body.userData.isCameraPart = true;
    body.userData.isHelper = true;
    body.userData.selectable = false;
    group.add(body);
    const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.17, 0.28, 20), lensMat);
    lens.name = `${name}.Lens`;
    lens.rotation.x = Math.PI / 2;
    lens.position.z = -0.4;
    lens.userData.isCameraBody = true;
    lens.userData.isCameraPart = true;
    lens.userData.isHelper = true;
    lens.userData.selectable = false;
    group.add(lens);

    // View direction indicator (small cone in front of the lens)
    const dirIndicator = new THREE.Mesh(
      new THREE.ConeGeometry(0.07, 0.2, 12),
      new THREE.MeshBasicMaterial({ color: 0x4a9eff, transparent: true, opacity: 0.85 })
    );
    dirIndicator.name = `${name}.Aim`;
    dirIndicator.rotation.x = -Math.PI / 2;
    dirIndicator.position.z = -0.62;
    dirIndicator.userData.isCameraBody = true;
    dirIndicator.userData.isCameraPart = true;
    dirIndicator.userData.isHelper = true;
    dirIndicator.userData.selectable = false;
    group.add(dirIndicator);

    group.position.set(position.x, position.y, position.z);
    this._orientGroupTowards(group, new THREE.Vector3(target.x, target.y, target.z));

    sm.addObject(group, null, true, true);

    // objectAdded (undo/redo redo path included) creates the registry entry.
    const entry = this.cameras.find(e => e.group === group) || this._adoptCameraObject(group);

    if (makeActive || !this.activeCamera) {
      this.setActiveCamera(group);
    }

    this._syncHelpers(sm.getActiveObject ? sm.getActiveObject() : group);
    window.dispatchEvent(new CustomEvent('blender:cameraChanged', {
      detail: { camera: group, cameras: this.cameras.map(c => c.group) }
    }));
    return group;
  }

  getCameraEntry(object) {
    if (!object) return null;
    let node = object;
    while (node) {
      if (node.userData?.isCameraObject) {
        return this.cameras.find(e => e.group === node) || null;
      }
      node = node.parent;
    }
    return null;
  }

  getActiveCameraObject() {
    return this.activeCamera && this.activeCamera.parent ? this.activeCamera : null;
  }

  getActiveCameraData() {
    const entry = this.cameras.find(e => e.group === this.getActiveCameraObject());
    return entry ? entry.camera : null;
  }

  setActiveCamera(cameraGroup) {
    if (!cameraGroup || !cameraGroup.userData?.isCameraObject) return false;
    this.activeCamera = cameraGroup;
    this._syncHelpers(this.sceneManager?.getActiveObject?.());
    window.dispatchEvent(new CustomEvent('blender:cameraChanged', {
      detail: { camera: cameraGroup, cameras: this.cameras.map(c => c.group) }
    }));
    return true;
  }

  /**
   * Enter/leave the selected (or active) camera view.
   */
  toggleViewCamera(cameraObject = null) {
    if (this.lookingThrough) {
      this.exitCameraView();
      return false;
    }
    const entry = this.getCameraEntry(cameraObject) ||
      this.cameras.find(e => e.group === this.getActiveCameraObject()) ||
      this.cameras[0];
    if (!entry) {
      // No camera in the scene yet: create one framing the origin.
      const created = this.createCamera();
      if (!created) return false;
      return this.enterCameraView(created);
    }
    return this.enterCameraView(entry.group);
  }

  enterCameraView(cameraObject) {
    const entry = this.getCameraEntry(cameraObject);
    if (!entry || !this.engine) return false;

    if (this.lookingThrough) this.exitCameraView();

    this._savedView = {
      camera: this.engine.camera,
      target: this.engine.controls ? this.engine.controls.target.clone() : new THREE.Vector3(),
      controlsEnabled: this.engine.controls ? this.engine.controls.enabled : true
    };

    const cam = entry.camera;
    cam.aspect = this._aspect();
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);

    this.engine.camera = cam;
    window.camera = cam;
    if (this.engine.controls) this.engine.controls.enabled = false;
    if (this.engine.transformControls) {
      this.engine.transformControls.camera = cam;
      this.engine.transformControls.updateMatrixWorld?.();
    }
    if (this.engine.viewHelper) this.engine.viewHelper.visible = false;

    // Hide the camera's own body/lens/aim meshes, otherwise they sit right in
    // front of the sensor and block the view.
    this._setCameraPartsVisible(entry, false);

    entry.helper.visible = false;
    this.lookingThrough = entry.group;
    this.setActiveCamera(entry.group);
    this._syncLockToViewControls();
    this._showOverlay(entry);

    window.dispatchEvent(new CustomEvent('blender:cameraViewChanged', {
      detail: { active: true, camera: entry.group, lockToView: this.lockToView }
    }));
    return true;
  }

  setLockToView(enabled) {
    this.lockToView = Boolean(enabled);
    this._syncLockToViewControls();
    window.dispatchEvent(new CustomEvent('blender:cameraChanged', {
      detail: { camera: this.getActiveCameraObject(), cameras: this.cameras.map(c => c.group), lockToView: this.lockToView }
    }));
    return this.lockToView;
  }

  _syncLockToViewControls() {
    if (this._lockControlsCleanup) {
      this._lockControlsCleanup();
      this._lockControlsCleanup = null;
    }
    const controls = this.engine?.controls;
    if (!controls || !this.lookingThrough) return;
    const entry = this.getCameraEntry(this.lookingThrough);
    if (!entry) return;

    if (!this.lockToView) {
      controls.object = this._savedView?.camera || controls.object;
      controls.enabled = false;
      this.engine?.syncViewportPaneControls?.();
      return;
    }

    // Drive a viewport PerspectiveCamera with OrbitControls and mirror its pose onto the scene Camera group
    const driver = this.engine.perspectiveCamera || this._savedView?.camera || entry.camera;
    const worldPos = new THREE.Vector3();
    const worldQuat = new THREE.Quaternion();
    entry.camera.getWorldPosition(worldPos);
    entry.camera.getWorldQuaternion(worldQuat);
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(worldQuat).normalize();
    const orbitDist = Math.max(1, this._savedView?.target ? worldPos.distanceTo(this._savedView.target) : 6);

    driver.position.copy(worldPos);
    driver.quaternion.copy(worldQuat);
    controls.object = driver;
    controls.target.copy(worldPos).addScaledVector(forward, orbitDist);
    controls.enabled = true;
    controls.update();

    const syncFromDriver = () => {
      if (!this.lookingThrough || !this.lockToView) return;
      const wPos = driver.position.clone();
      const wQuat = driver.quaternion.clone();
      if (entry.group.parent) {
        entry.group.parent.updateWorldMatrix(true, false);
        const invMat = entry.group.parent.matrixWorld.clone().invert();
        const invQuat = entry.group.parent.getWorldQuaternion(new THREE.Quaternion()).invert();
        entry.group.position.copy(wPos.applyMatrix4(invMat));
        entry.group.quaternion.copy(invQuat.multiply(wQuat));
      } else {
        entry.group.position.copy(wPos);
        entry.group.quaternion.copy(wQuat);
      }
      entry.group.updateMatrixWorld(true);
      entry.camera.updateMatrixWorld(true);
      entry.helper?.update?.();
      this.engine?.requestRender?.();
    };
    controls.addEventListener('change', syncFromDriver);
    this._lockControlsCleanup = () => {
      controls.removeEventListener('change', syncFromDriver);
      if (this._savedView?.camera) controls.object = this._savedView.camera;
    };
  }

  /**
   * Align active scene camera (creating one if absent) to the current viewport camera (Blender Ctrl+Alt+0).
   */
  alignActiveCameraToView(targetCamera = null) {
    if (!this.engine?.camera) return null;
    let camGroup = targetCamera?.userData?.isCameraObject ? targetCamera : this.getActiveCameraObject();
    if (!camGroup && this.cameras.length > 0) {
      camGroup = this.cameras[0].group;
      this.setActiveCamera(camGroup);
    }
    if (!camGroup) {
      camGroup = this.createCamera({ name: 'Camera', makeActive: true });
    }
    const entry = this.getCameraEntry(camGroup);
    if (!entry) return null;

    const viewCam = (this.lookingThrough === entry.group && this._savedView?.camera)
      ? this._savedView.camera
      : this.engine.camera;
    viewCam.updateMatrixWorld(true);

    const oldState = {
      position: entry.group.position.clone(),
      quaternion: entry.group.quaternion.clone(),
      scale: entry.group.scale.clone()
    };

    const worldPos = new THREE.Vector3();
    const worldQuat = new THREE.Quaternion();
    viewCam.getWorldPosition(worldPos);
    viewCam.getWorldQuaternion(worldQuat);

    if (entry.group.parent) {
      entry.group.parent.updateWorldMatrix(true, false);
      const invMat = entry.group.parent.matrixWorld.clone().invert();
      const invQuat = entry.group.parent.getWorldQuaternion(new THREE.Quaternion()).invert();
      entry.group.position.copy(worldPos.applyMatrix4(invMat));
      entry.group.quaternion.copy(invQuat.multiply(worldQuat));
    } else {
      entry.group.position.copy(worldPos);
      entry.group.quaternion.copy(worldQuat);
    }
    if (viewCam.isPerspectiveCamera) {
      entry.camera.fov = viewCam.fov;
      entry.camera.updateProjectionMatrix();
    }
    entry.group.updateMatrixWorld(true);
    entry.helper?.update?.();

    const newState = {
      position: entry.group.position.clone(),
      quaternion: entry.group.quaternion.clone(),
      scale: entry.group.scale.clone()
    };
    if (this.sceneManager) {
      this.sceneManager.recordExecutedCommand?.(
        new TransformCommand(entry.group, oldState, newState, () => {
          entry.group.updateMatrixWorld(true);
          entry.helper?.update?.();
        })
      );
    }
    window.dispatchEvent(new CustomEvent('blender:cameraChanged', {
      detail: { camera: entry.group, cameras: this.cameras.map(c => c.group) }
    }));
    this.engine.requestRender?.();
    return entry.group;
  }

  exitCameraView() {
    if (!this.lookingThrough) return false;

    if (this._lockControlsCleanup) {
      this._lockControlsCleanup();
      this._lockControlsCleanup = null;
    }

    const entry = this.getCameraEntry(this.lookingThrough);
    if (entry) {
      entry.helper.visible = false;
      this._setCameraPartsVisible(entry, true);
    }

    if (this._savedView) {
      this.engine.camera = this._savedView.camera;
      window.camera = this.engine.camera;
      if (this.engine.controls) {
        this.engine.controls.object = this._savedView.camera;
        this.engine.controls.target.copy(this._savedView.target);
        this.engine.controls.enabled = this._savedView.controlsEnabled !== false;
        this.engine.controls.update();
      }
      if (this.engine.transformControls) {
        this.engine.transformControls.camera = this._savedView.camera;
      }
    }
    if (this.engine.viewHelper) this.engine.viewHelper.visible = true;

    this.lookingThrough = null;
    this._savedView = null;
    this.engine.syncViewportPaneControls?.();
    this._hideOverlay();
    this._syncHelpers(this.sceneManager?.getActiveObject?.());

    window.dispatchEvent(new CustomEvent('blender:cameraViewChanged', {
      detail: { active: false, camera: entry ? entry.group : null }
    }));
    return true;
  }

  /**
   * Frames the current selection from a given camera without changing the user view.
   */
  frameSelection(entry) {
    const sm = this.sceneManager;
    if (!entry || !sm) return;
    const selected = (sm.getSelectedObjects ? sm.getSelectedObjects() : [sm.getActiveObject()])
      .filter((o) => o && o !== entry.group && !o.userData?.isCameraObject);

    const box = new THREE.Box3();
    if (selected.length > 0) {
      for (const obj of selected) {
        obj.updateWorldMatrix(true, true);
        box.expandByObject(obj);
      }
    } else {
      for (const obj of sm.objects.values()) {
        if (!obj || obj === entry.group || obj.userData?.isCameraObject || obj.userData?.isSystemObject) continue;
        if (obj.isMesh || obj.isGroup) {
          obj.updateWorldMatrix(true, true);
          box.expandByObject(obj);
        }
      }
    }
    if (box.isEmpty()) return;
    const center = new THREE.Vector3();
    const size = new THREE.Vector3();
    box.getCenter(center);
    box.getSize(size);
    const maxDim = Math.max(size.x, size.y, size.z) || 2;
    const cam = entry.camera;
    const distance = Math.abs(maxDim / (2 * Math.tan((cam.fov * Math.PI) / 360))) * 1.6;
    const forward = cam.getWorldDirection(new THREE.Vector3());
    if (forward.lengthSq() < 0.001) forward.set(0, 0, -1);
    entry.group.position.copy(center).addScaledVector(forward, -distance);
    this._orientGroupTowards(entry.group, center);
    entry.group.updateMatrixWorld(true);
    entry.helper.update();
    window.dispatchEvent(new CustomEvent('blender:cameraChanged', {
      detail: { camera: entry.group, cameras: this.cameras.map(c => c.group) }
    }));
  }

  updateAllAspects() {
    const aspect = this._aspect();
    for (const { camera } of this.cameras) {
      if (Math.abs(camera.aspect - aspect) > 0.001) {
        camera.aspect = aspect;
        camera.updateProjectionMatrix();
        if (this.lookingThrough && this.lookingThrough === this.getCameraEntry(camera)?.group) {
          camera.updateMatrixWorld(true);
        }
      }
    }
  }

  applyLens(entry, focalLengthMm) {
    if (!entry) return;
    const focal = Math.max(8, Math.min(300, focalLengthMm));
    const fov = THREE.MathUtils.radToDeg(2 * Math.atan(SENSOR_HEIGHT_MM / (2 * focal)));
    entry.camera.fov = fov;
    entry.camera.updateProjectionMatrix();
    entry.helper.update();
    window.dispatchEvent(new CustomEvent('blender:cameraChanged', {
      detail: { camera: entry.group, cameras: this.cameras.map(c => c.group) }
    }));
  }

  static focalLengthToFov(focalLengthMm) {
    return THREE.MathUtils.radToDeg(2 * Math.atan(SENSOR_HEIGHT_MM / (2 * Math.max(1, focalLengthMm))));
  }

  static fovToFocalLength(fovDeg) {
    return SENSOR_HEIGHT_MM / (2 * Math.tan(THREE.MathUtils.degToRad(fovDeg) / 2));
  }

  _syncHelpers(active) {
    const activeEntry = this.getCameraEntry(active);
    for (const entry of this.cameras) {
      if (!entry.group.parent) continue;
      entry.helper.visible = entry === activeEntry;
      if (entry.helper.visible) entry.helper.update();
    }
    if (this.lookingThrough) {
      const entry = this.getCameraEntry(this.lookingThrough);
      if (entry) entry.helper.visible = false;
    }
  }

  _refreshHelperGeometry() {
    for (const entry of this.cameras) {
      if (!entry.group.parent || !entry.helper) continue;
      entry.camera.updateMatrixWorld(true);
      entry.helper.update();
    }
  }

  // Object3D.lookAt() aims the +Z axis at the target, but a camera child looks
  // along -Z, so the group must be spun 180° or the sensor faces backwards.
  _orientGroupTowards(group, target) {
    group.lookAt(target);
    group.rotateY(Math.PI);
    group.updateMatrixWorld(true);
  }

  _setCameraPartsVisible(entry, visible) {
    if (!entry?.group) return;
    entry.group.children.forEach((child) => {
      if (child.isMesh) child.visible = visible;
    });
  }

  _adoptCameraObject(object) {
    if (!object || !object.userData?.isCameraObject) return null;
    const existing = this.cameras.find(e => e.group === object);
    if (existing) return existing;

    const camera = object.children.find(c => c.isCamera);
    if (!camera) return null;

    // Camera internals are picked through the parent group, never individually
    camera.userData.selectable = false;
    object.children.forEach((child) => {
      if (child !== camera && child.isMesh) {
        child.userData.selectable = false;
        child.userData.isCameraPart = true;
        child.userData.isHelper = true;
      }
    });

    const helper = new THREE.CameraHelper(camera);
    helper.name = `${object.name || 'Camera'}.Frustum`;
    helper.userData.isHelper = true;
    helper.userData.isSystemObject = true;
    helper.userData.cameraOwner = object;
    helper.visible = false;
    this.engine.scene.add(helper);

    const entry = { group: object, camera, helper };
    this.cameras.push(entry);
    object.userData.cameraHelper = helper;
    if (!this.activeCamera) this.activeCamera = object;
    return entry;
  }

  _onObjectRemoved(object) {
    const entry = this.getCameraEntry(object);
    if (!entry) return;
    if (entry.helper.parent) entry.helper.parent.remove(entry.helper);
    entry.helper.dispose?.();

    const index = this.cameras.indexOf(entry);
    if (index !== -1) this.cameras.splice(index, 1);

    if (this.lookingThrough === entry.group) this.exitCameraView();
    if (this.activeCamera === entry.group) this.activeCamera = this.cameras[0]?.group || null;

    window.dispatchEvent(new CustomEvent('blender:cameraChanged', {
      detail: { camera: this.activeCamera, cameras: this.cameras.map(c => c.group) }
    }));
  }

  _onSceneCleared() {
    if (this.lookingThrough) this.exitCameraView();
    for (const entry of this.cameras) {
      if (entry.helper.parent) entry.helper.parent.remove(entry.helper);
      entry.helper.dispose?.();
    }
    this.cameras.length = 0;
    this.activeCamera = null;
  }

  _showOverlay(entry) {
    const host = this.engine.domElement?.parentElement;
    if (!host) return;
    this._hideOverlay();
    const overlay = document.createElement('div');
    overlay.className = 'camera-view-overlay';
    const labelEl = document.createElement('div');
    labelEl.className = 'camera-view-label';
    const dot = document.createElement('span');
    dot.className = 'camera-view-dot';
    const hint = document.createElement('span');
    hint.className = 'camera-view-hint';
    hint.textContent = '0 / Numpad 0 / Esc to exit';
    labelEl.append(
      dot,
      document.createTextNode(` Camera View — ${String(entry?.group?.name ?? 'Camera')} `),
      hint
    );
    overlay.appendChild(labelEl);
    host.appendChild(overlay);
    this._overlay = overlay;

    const nameEl = document.getElementById('vp-camera-name');
    if (nameEl) nameEl.textContent = entry.group.name;
  }

  _hideOverlay() {
    if (this._overlay && this._overlay.parentElement) {
      this._overlay.parentElement.removeChild(this._overlay);
    }
    this._overlay = null;

    if (!this.lookingThrough) this.engine.updateViewportCameraLabel();
  }
}
