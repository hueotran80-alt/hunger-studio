import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const workerCode = [
  "import { parentPort } from 'node:worker_threads';",
  readFileSync(resolve('js/agent/agent-exec-worker.js'), 'utf8')
    .replace("from '../../vendor/three/three.module.js'", `from '${pathToFileURL(resolve('vendor/three/three.module.js')).href}'`)
    .replace("from '../core/geometry/parametric-cad.js'", `from '${pathToFileURL(resolve('js/core/geometry/parametric-cad.js')).href}'`)
    .replace("from '../core/scene-budget.js'", `from '${pathToFileURL(resolve('js/core/scene-budget.js')).href}'`)
    .replace(/\bself\b/g, 'globalThis')
    .replace('const send = globalThis.postMessage.bind(globalThis);', 'const send = message => parentPort.postMessage(message);'),
  "parentPort.on('message', data => globalThis.onmessage({ data }));"
].join('\n');
let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}\n     ${error?.stack || error}`);
  }
}

function runWorker(code) {
  return new Promise((resolveRun, reject) => {
    const worker = new Worker(workerCode, { eval: true, workerData: { code } });
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error('agent.exec test worker timed out'));
    }, 5000);
    const finish = (fn, value) => {
      clearTimeout(timer);
      worker.terminate().finally(() => fn(value));
    };
    worker.on('message', message => {
      if (message.kind === 'result') finish(resolveRun, message.value);
      else if (message.kind === 'error') finish(reject, Object.assign(new Error(message.error.message), { code: message.error.code }));
      else if (message.kind === 'log') finish(reject, new Error(`unexpected log: ${JSON.stringify(message.entry)}`));
    });
    worker.on('error', error => finish(reject, error));
    worker.postMessage({ code, nodes: [], selection: [] });
  });
}

await test('agent.exec still executes supported scene scripts', async () => {
  const result = await runWorker(`
    studio.addCube({ name: 'ExecSafeCube' });
    return studio.getObject('ExecSafeCube').name;
  `);
  assert.equal(result, 'ExecSafeCube');
});

await test('agent.exec supports Phase-2 CAD, Curve, Instancing, Budget & queued PBR/Boolean/Export parity', async () => {
  const result = await runWorker(`
    const ring = (r) => Array.from({ length: 12 }, (_, i) => [Math.cos(i/12*Math.PI*2)*r, Math.sin(i/12*Math.PI*2)*r]);
    const loft = studio.addLoft({ name: 'LoftA', sections: [{ contour: ring(1), y: 0 }, { contour: ring(0.5), y: 2 }], samples: 12 });
    const curve = studio.createCurve3D({ type: 'catenary', start: [-3, 2, 0], end: [3, 2, 0], sag: 1, segments: 8 });
    const sc = studio.scatterOnCurve({ name: 'CurveLanterns', curve });
    const bud = studio.inspectSceneBudget('product');
    const pbr = studio.applyProceduralPBR('LoftA', { pattern: 'ashlar_stone' });
    const boolCmd = studio.boolean('LoftA', 'LoftA', 'union');
    const expCmd = studio.exportModel({ binary: true });
    return { loft: loft.name, scCount: sc.count, budgetStatus: bud.status, pbrQueued: pbr.queued, boolQueued: boolCmd.queued, expQueued: expCmd.queued };
  `);
  assert.equal(result.loft, 'LoftA');
  assert.ok(result.scCount >= 5);
  assert.equal(result.budgetStatus, 'ok');
  assert.equal(result.pbrQueued, true);
  assert.equal(result.boolQueued, true);
  assert.equal(result.expQueued, true);
});

await test('agent.exec preserves pre-existing PointLight & InstancedMesh node types across mirror round-trip', async () => {
  const result = await new Promise((resolveRun, reject) => {
    const worker = new Worker(workerCode, { eval: true });
    const timer = setTimeout(() => { worker.terminate(); reject(new Error('timeout')); }, 5000);
    worker.on('message', (msg) => {
      if (msg.kind === 'result') { clearTimeout(timer); worker.terminate().finally(() => resolveRun(msg)); }
      else if (msg.kind === 'error') { clearTimeout(timer); worker.terminate().finally(() => reject(new Error(msg.error.message))); }
    });
    const geom = { metadata: { version: 4.5, type: 'BufferGeometry' }, type: 'BufferGeometry', data: { attributes: { position: { itemSize: 3, type: 'Float32Array', array: [0,0,0, 1,0,0, 0,1,0], normalized: false } } } };
    worker.postMessage({
      code: 'return { lightType: studio.getObject("KeyLight").type, instCount: studio.getObject("Bolts").count };',
      nodes: [
        { uuid: 'u-light', agentId: 'a1', type: 'PointLight', name: 'KeyLight', visible: true, parentUUID: null, position: [1,2,3], quaternion: [0,0,0,1], scale: [1,1,1], geometry: null, materials: [], lightColor: 0xffcc88, lightIntensity: 2.5 },
        { uuid: 'u-inst', agentId: 'a2', type: 'InstancedMesh', name: 'Bolts', visible: true, parentUUID: null, position: [0,0,0], quaternion: [0,0,0,1], scale: [1,1,1], geometry: geom, materials: [], instanceCount: 2, instanceMatrices: [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1, 1,0,0,0,0,1,0,0,0,0,1,0,2,0,0,1] },
      ],
      selection: [],
    });
  });
  assert.equal(result.value.lightType, 'PointLight');
  assert.equal(result.value.instCount, 2);
  const outLight = result.nodes.find((n) => n.name === 'KeyLight');
  const outInst = result.nodes.find((n) => n.name === 'Bolts');
  assert.equal(outLight.type, 'PointLight');
  assert.equal(outLight.lightIntensity, 2.5);
  assert.equal(outInst.type, 'InstancedMesh');
  assert.equal(outInst.instanceCount, 2);
});

await test('agent.exec preserves parent/rotation opts & queues PBR target by UUID even after rename', async () => {
  const result = await new Promise((resolveRun, reject) => {
    const worker = new Worker(workerCode, { eval: true });
    const timer = setTimeout(() => { worker.terminate(); reject(new Error('timeout')); }, 5000);
    worker.on('message', (msg) => {
      if (msg.kind === 'result') { clearTimeout(timer); worker.terminate().finally(() => resolveRun(msg)); }
      else if (msg.kind === 'error') { clearTimeout(timer); worker.terminate().finally(() => reject(new Error(msg.error.message))); }
    });
    worker.postMessage({
      code: `
        const grp = studio.addGroup('RigGroup');
        const box = studio.addCube({ name: 'BeforeRename', parent: grp, rotationY: 0.5 });
        box.name = 'AfterRename';
        studio.applyProceduralPBR(box, { pattern: 'ashlar_stone' });
        return { boxUuid: box.uuid, grpUuid: grp.uuid };
      `,
      nodes: [],
      selection: [],
    });
  });
  const boxNode = result.nodes.find((n) => n.uuid === result.value.boxUuid);
  assert.equal(boxNode.parentUUID, result.value.grpUuid, 'primitive opts.parent preserved');
  assert.ok(Math.abs(boxNode.quaternion[1]) > 0.2, 'primitive opts.rotationY preserved');
  const pbrCmd = (result.commands || []).find((c) => c.method === 'applyProceduralPBR');
  assert.equal(pbrCmd?.args?.[0], result.value.boxUuid, 'queued applyProceduralPBR passes stable UUID (not stale name)');
});

for (const [label, expression] of [
  ['indexedDB', 'indexedDB'],
  ['caches', 'caches'],
  ['cookieStore', 'cookieStore'],
  ['BroadcastChannel', 'BroadcastChannel'],
  ['MessageChannel', 'MessageChannel'],
  ['WebTransport', 'WebTransport'],
  ['navigator.storage', 'navigator.storage'],
  ['Worker', 'Worker'],
  ['location', 'location']
]) {
  await test(`agent.exec blocks ${label}`, async () => {
    await assert.rejects(
      runWorker(`return ${expression};`),
      error => error?.code === 'E_PERMISSION',
      `${label} must throw E_PERMISSION`
    );
  });
}

console.log(`\nAgent exec isolation: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
