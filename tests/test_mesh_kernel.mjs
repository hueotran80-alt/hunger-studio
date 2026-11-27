import assert from 'assert';
import { initMeshKernel, isMeshKernelReady, weldAndExtractTopology, subdivideMesh } from '../js/core/mesh-kernel-bridge.js';

console.log('=== Test Suite: Rust WASM Mesh Kernel ===');

// 1. Initialization
const ok = await initMeshKernel();
assert.strictEqual(ok, true, 'initMeshKernel should succeed');
assert.strictEqual(isMeshKernelReady(), true, 'isMeshKernelReady should be true');
console.log('ok   Rust WASM Kernel initialized successfully');

// 2. Vertex Welding on a 2-triangle quad with duplicate vertices
// Tri 1: (0,0,0), (1,0,0), (1,1,0)
// Tri 2: (0,0,0), (1,1,0), (0,1,0) - (0,0,0) and (1,1,0) are duplicated
const rawPositions = new Float32Array([
  0, 0, 0,
  1, 0, 0,
  1, 1, 0,
  0, 0, 0, // dup of 0
  1, 1, 0, // dup of 2
  0, 1, 0
]);

const result = weldAndExtractTopology(rawPositions, null, 0.001);
assert(result !== null, 'weldAndExtractTopology should return result');
assert.strictEqual(result.vertices.length, 4 * 3, 'Should weld 6 vertices down to 4 unique vertices (12 floats)');
assert.strictEqual(result.indices.length, 6, 'Should output 6 triangle indices');
assert.strictEqual(result.edges.length, 10, 'A quad with 1 diagonal has 5 unique edges (10 vertex indices)');
assert.strictEqual(result.normals.length, 6, 'Should compute 2 triangle face normals (6 floats)');
assert.strictEqual(result.map.length, 6, 'Map length should match original vertex count');
console.log('ok   weldAndExtractTopology welds vertices and extracts unique edges');

// 3. Subdivision Test
// Take 1 triangle and subdivide it
const triPositions = new Float32Array([
  0, 0, 0,
  2, 0, 0,
  0, 2, 0
]);
const triIndices = new Uint32Array([0, 1, 2]);

const subResult = subdivideMesh(triPositions, triIndices, false);
assert(subResult !== null, 'subdivideMesh should return result');
assert.strictEqual(subResult.indices.length, 12, '1 triangle subdivides into 4 triangles (12 indices)');
assert.strictEqual(subResult.vertices.length, 6 * 3, '3 original + 3 midpoints = 6 vertices (18 floats)');
console.log('ok   subdivideMesh subdivides 1 triangle into 4 sub-triangles');

// 4. Performance Benchmark: 10,000 triangles
console.log('--- Benchmarking High-Poly Processing in Rust WASM ---');
const NUM_TRIS = 10000;
const benchPositions = new Float32Array(NUM_TRIS * 3 * 3);
// Generate a grid of triangles with many shared vertices
for (let i = 0; i < NUM_TRIS; i++) {
  const x = (i % 100) * 0.1;
  const y = Math.floor(i / 100) * 0.1;
  benchPositions[i * 9 + 0] = x;
  benchPositions[i * 9 + 1] = y;
  benchPositions[i * 9 + 2] = 0;

  benchPositions[i * 9 + 3] = x + 0.1;
  benchPositions[i * 9 + 4] = y;
  benchPositions[i * 9 + 5] = 0;

  benchPositions[i * 9 + 6] = x;
  benchPositions[i * 9 + 7] = y + 0.1;
  benchPositions[i * 9 + 8] = 0;
}

const t0 = performance.now();
const benchResult = weldAndExtractTopology(benchPositions, null, 0.0001);
const t1 = performance.now();
const elapsed = (t1 - t0).toFixed(2);

assert(benchResult !== null, 'Benchmark weld should succeed');
console.log(`ok   Rust WASM welded ${NUM_TRIS * 3} vertices down to ${benchResult.vertices.length / 3} vertices and extracted ${benchResult.edges.length / 2} edges in ${elapsed} ms!`);

// Subdivide the 10,000 triangles into 40,000 triangles
const t2 = performance.now();
const subBench = subdivideMesh(benchResult.vertices, benchResult.indices, false);
const t3 = performance.now();
const subElapsed = (t3 - t2).toFixed(2);

assert(subBench !== null, 'Benchmark subdivide should succeed');
console.log(`ok   Rust WASM subdivided ${benchResult.indices.length / 3} triangles into ${subBench.indices.length / 3} triangles (${subBench.vertices.length / 3} vertices) in ${subElapsed} ms!`);

console.log('\nALL RUST MESH KERNEL TESTS PASSED');
