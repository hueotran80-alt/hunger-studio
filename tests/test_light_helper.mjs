import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  ensureLightHelper,
  bindLightHelpers,
  removeLightHelper
} from '../js/core/light-helper.js';

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log(`ok   ${name}`);
};

class MockSceneManager {
  constructor() {
    this.objects = new Map();
    this.handlers = {};
    this.active = null;
  }
  on(event, cb) { (this.handlers[event] = this.handlers[event] || []).push(cb); }
  emit(event, payload = {}) { (this.handlers[event] || []).forEach((cb) => cb(payload)); }
  getActiveObject() { return this.active; }
}

test('ensureLightHelper creates one non-selectable system gizmo', () => {
  const light = new THREE.PointLight(0xff8800, 1);
  const helper = ensureLightHelper(light);
  assert.ok(helper, 'helper missing');
  assert.equal(helper.parent, light);
  assert.equal(helper.userData.isLightHelper, true);
  assert.equal(helper.userData.isSystemObject, true);
  assert.equal(helper.userData.selectable, false);
  assert.equal(helper.visible, false);
  assert.equal(light.userData.lightHelper, helper);
});

test('ensureLightHelper is idempotent', () => {
  const light = new THREE.SpotLight(0xffffff, 1);
  const first = ensureLightHelper(light);
  const second = ensureLightHelper(light);
  assert.equal(first, second);
  assert.equal(light.children.filter((c) => c.userData.isLightHelper).length, 1);
});

test('cloned light adopts its cloned gizmo instead of the original', () => {
  const light = new THREE.DirectionalLight(0xffffff, 1);
  const original = ensureLightHelper(light);
  const clone = light.clone();
  const adopted = ensureLightHelper(clone);
  assert.notEqual(adopted, original);
  assert.equal(adopted.parent, clone);
  assert.equal(clone.userData.lightHelper, adopted);
  assert.equal(clone.children.filter((c) => c.userData.isLightHelper).length, 1);
});

test('gizmo is visible only for the active light', () => {
  const manager = new MockSceneManager();
  const a = new THREE.PointLight(0xffffff, 1);
  const b = new THREE.PointLight(0xffffff, 1);
  manager.objects.set('a', a);
  manager.objects.set('b', b);
  bindLightHelpers(manager);

  manager.emit('objectAdded', { object: a });
  manager.emit('objectAdded', { object: b });
  assert.ok(a.userData.lightHelper && b.userData.lightHelper);

  manager.active = a;
  manager.emit('selectionChanged', { active: a });
  assert.equal(a.userData.lightHelper.visible, true);
  assert.equal(b.userData.lightHelper.visible, false);

  manager.active = b;
  manager.emit('selectionChanged', { active: b });
  assert.equal(a.userData.lightHelper.visible, false);
  assert.equal(b.userData.lightHelper.visible, true);

  manager.active = null;
  manager.emit('selectionChanged', { active: null });
  assert.equal(b.userData.lightHelper.visible, false);
});

test('bindLightHelpers handles lights that existed before binding', () => {
  const manager = new MockSceneManager();
  const light = new THREE.DirectionalLight(0xffffff, 1);
  manager.objects.set('existing', light);
  bindLightHelpers(manager);
  assert.ok(light.userData.lightHelper, 'pre-existing light has no gizmo');
});

test('removeLightHelper detaches and clears the reference', () => {
  const light = new THREE.PointLight(0xffffff, 1);
  const helper = ensureLightHelper(light);
  removeLightHelper(light);
  assert.equal(helper.parent, null);
  assert.equal(light.userData.lightHelper, null);
});

console.log(`\nALL ${passed} LIGHT HELPER TESTS PASSED`);
