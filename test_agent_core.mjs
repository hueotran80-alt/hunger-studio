import assert from 'node:assert/strict';
import { THREE, IdRegistry, TxManager, LogBuffer, EventBus, RateLimiter } from './js/agent/agent-core.js';

function fixture() {
  const scene = new THREE.Scene(), rootContainer = new THREE.Group(); scene.add(rootContainer);
  const handlers = new Map();
  const sm = { scene, rootContainer, objects: new Map(), selectedObjects: new Set(), activeObject: null, undoStack: [], redoStack: [],
    getSelectedObjects() { return [...this.selectedObjects]; },
    executeCommand(command) { this.undoStack.push(command); this.redoStack = []; },
    undo() { const c = this.undoStack.pop(); if (c) { c.undo(); this.redoStack.push(c); } },
    redo() { const c = this.redoStack.pop(); if (c) { c.execute(); this.undoStack.push(c); } },
    canUndo() { return !!this.undoStack.length; }, canRedo() { return !!this.redoStack.length; },
    clearHistory() { this.undoStack = []; this.redoStack = []; },
    emit(event, payload) { handlers.get(event)?.forEach(cb => cb(payload)); }
  };
  const ctx = { sceneManager: sm, engine: { scene }, log: new LogBuffer(), events: new EventBus() };
  const tx = new TxManager(ctx); tx.install();
  const add = object => { object.userData.id = object.uuid; sm.objects.set(object.uuid, object); rootContainer.add(object); return object; };
  return { sm, tx, add };
}

const ids = new IdRegistry('obj_');
const a = new THREE.Group(), b = new THREE.Group();
assert.equal(ids.assign(a), 'obj_1'); assert.equal(ids.assign(a), 'obj_1'); assert.equal(ids.assign(b), 'obj_2');
const loaded = new THREE.Group(); loaded.userData.agentId = 'obj_19'; ids.assign(loaded);
assert.equal(ids.assign(new THREE.Group()), 'obj_20');
const cloned = a.clone(); assert.equal(ids.assign(cloned), 'obj_21');

const { sm, tx, add } = fixture();
const mesh = add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial()));
mesh.name = 'Cube';
const before = mesh.geometry.attributes.position.array.slice();
await assert.rejects(tx.run('failure', async () => {
  mesh.position.x = 10; mesh.name = 'Changed'; mesh.material.color.set('#ff0000'); mesh.geometry.attributes.position.array[0] = 44;
  add(new THREE.Group()); throw new Error('intentional');
}, { deep: true }), /intentional/);
assert.equal(mesh.position.x, 0); assert.equal(mesh.name, 'Cube'); assert.equal(sm.objects.size, 1);
assert.deepEqual(mesh.geometry.attributes.position.array, before); assert.equal(mesh.material.color.getHexString(), 'ffffff'); assert.equal(sm.undoStack.length, 0);

await tx.run('move', () => { mesh.position.set(1, 2, 3); });
assert.equal(sm.undoStack.length, 1); tx.undo(); assert.deepEqual(mesh.position.toArray(), [0, 0, 0]); tx.redo(); assert.deepEqual(mesh.position.toArray(), [1, 2, 3]);

const explicit = tx.begin('batch', { deep: true, explicit: true });
await tx.run('rename', () => { mesh.name = 'Batch'; });
await tx.run('move', () => { mesh.position.x = 9; });
assert.equal(sm.undoStack.length, 1); tx.commit(explicit.txId); assert.equal(sm.undoStack.length, 2);
tx.undo(); assert.equal(mesh.name, 'Cube'); assert.equal(mesh.position.x, 1);

const nested = tx.begin('outer', { deep: true });
await assert.rejects(tx.run('inner', () => { mesh.position.x = 88; throw new Error('inner'); }), /inner/);
assert.equal(mesh.position.x, 1); assert.equal(tx.current.txId, nested.txId); tx.rollback(nested.txId);

const interleaved = new THREE.InterleavedBuffer(new Float32Array([0, 0, 0, 1, 1, 1]), 3);
mesh.geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.InterleavedBufferAttribute(interleaved, 3, 0));
mesh.geometry.morphAttributes.position = [new THREE.Float32BufferAttribute([0, 0, 0, 1, 1, 1], 3)];
await assert.rejects(tx.run('arrays', () => { interleaved.array[0] = 55; mesh.geometry.morphAttributes.position[0].array[0] = 66; throw new Error('arrays'); }, { deep: true }), /arrays/);
assert.equal(interleaved.array[0], 0); assert.equal(mesh.geometry.morphAttributes.position[0].array[0], 0);

const limiter = new RateLimiter({ assets: 2 }); assert.equal(limiter.take('assets').allowed, true); assert.equal(limiter.take('assets').allowed, true); assert.equal(limiter.take('assets').allowed, false);
console.log('PASS: IDs, atomic rollback, shared undo/redo, explicit/nested transactions, interleaved/morph buffers, rate limits');
