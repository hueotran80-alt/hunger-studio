---
name: hunger-parametric-cad
description: Author watertight, clean-topology hard-surface, architectural, mechanical, and hollow 3D geometry natively in Hunger 3D Studio using studio.* parametric CAD, loft, sweep, boolean, curve, and GPU instancing APIs.
---

# Hunger Parametric CAD & Instancing

Use this skill for all hard-surface, architectural, mechanical, furniture, vehicle, and hollow interior geometry inside **Hunger 3D Studio** (`studio.*` Browser DSL, Copilot Worker, `agent.exec`, or Remote MCP). Always prefer parametric CAD primitives and GPU instancing over stacking unindexed boxes.

## 1. Core Hunger CAD Primitives & Exact Signatures

### 2D Contours & Pierced Extrusions (Walls, Facades, Plates, Frames)
```js
const archHole = studio.sampleContour({ type: 'twoCenterArc', width: 1.8, height: 3.2, springY: 1.8 }, 20);
const wall = studio.addExtrude({
  name: 'PiercedWall',
  contour: [[-4, 0], [4, 0], [4, 6], [-4, 6]],
  holes: [archHole],
  depth: 0.45,
  bevelSize: 0.03,
  bevelSegments: 2,
  uvScale: 2.0,
  creaseAngleDeg: 32,
  material: wallMat,
});
```
Supported `sampleContour` types: `twoCenterArc`, `circle`, `regularPolygon`, `rosette` (plus arbitrary `[x, y]` point loops).

### Mitered Sweeps (Moldings, Cornices, Pipes, Structural Ribs, Handrails)
```js
const cornice = studio.addSweep({
  name: 'MiteredCornice',
  profile: [[0, 0], [0.22, 0], [0.26, 0.14], [0.10, 0.24], [0, 0.24]],
  path: [[-5, 4, -3], [5, 4, -3], [5, 4, 3], [-5, 4, 3]],
  planeNormal: [0, 1, 0],
  closedPath: true,
  miterLimit: 3.0,
  scaleStart: 1.0,
  scaleEnd: 1.0,
  material: trimMat,
});
```

### Turned Solids (`addLathe`), Multi-Profile Transitions (`addLoft`) & Curved Shells (`addSurfaceGrid`)
- **Lathe** (domes, balusters, columns, vases, bells, nozzles):
  `studio.addLathe({ profile: [[r0, y0], ...], segments: 24, capEnds: true, creaseAngleDeg: 35, material })`
- **Loft** (tapered spires, hulls, aerodynamic bodies, transitions between differing contours):
  `studio.addLoft({ sections: [{ contour, x, y, z, scale, twist, plane: 'xz'|'xy' }, ...], samples: 24, capStart: true, capEnd: true, creaseAngleDeg: 32, material })`
- **Surface Shell Grid** (vaults, tension canopies, ribbed domes, double-curved panels):
  `studio.addSurfaceGrid({ grid, thickness: 0.18, creaseAngleDeg: 34, material })`

### 3D Curves, Booleans & Single-Draw-Call Consolidation
- **3D Curves:** `const pts = studio.sampleCurve3D({ type: 'catenary'|'helix'|'scroll'|'arch'|'bezier'|'catmullrom', start, end, sag, radius, height, turns, segments });` *(alias `studio.createCurve3D`)*
- **Curve Instancing:** `studio.scatterOnCurve(protoMeshOrGeom, pts, { seed: 42, alignTangent: true, scaleMin: 0.95, scaleMax: 1.05, removeSource: true, name })`
- **GPU Instancing (Mandatory for `>= 4` repeated parts):**
  `studio.addInstancedMesh(protoMeshOrGeom, instances, { removeSource: true, name, material })`
  where each item is `{ x, y, z, rx, ry, rz, sx, sy, sz }` or a `THREE.Matrix4`.
- **Material-Grouped Merge:**
  `studio.mergeMeshes(parts, { removeSources: true, recomputeCreaseNormals: true, vertexAO: true, name, material })`
  *(Removes both registered and unregistered child meshes inside a single atomic Undo batch preserving exact `childIndex`.)*
- **CSG Boolean:** `studio.boolean('subtract'|'union'|'intersect', targetA, targetB)`

## 2. Non-Destructive Modifiers & Geometry Polish
- **Async Modifier Stack (`studio.modifiers.*`):** `add(type, params, mesh)`, `update`, `remove`, `toggle`, `reorder`, `bake(upTo, mesh)` supporting `bevel`, `subdivision` (True Catmull-Clark), `solidify`, `displace`, `smooth`, `mirror`, `array`, `decimate`, `screw`, `weld`, `remesh`, `wireframe`. Both `scrubModifier` and `bakeModifiers` roll back `baseGeometry`, `modifierStack`, `geometry`, and cache cleanly on abort/error.
- **Sync Polish Helpers:**
  - `studio.boxProjectUV(target, { metersPerTile: 2.0, worldSpace: true })`
  - `studio.computeCreaseNormals(target, 32)` (splits sharp hard-surface creases while smoothing curved faces)
  - `studio.bakeVertexAO(target, { strength: 0.35 })` (compact `Uint8` normalized cavity AO; auto-enables `material.vertexColors = true`)
  - `studio.modifyGeometry(target, 'taper'|'twist'|'solidify'|'mirror'|'array'|'crease_normals'|'box_uv'|'vertex_ao', params)`

## 3. Watertight Topology & Preflight Safety Rules
1. **Preflight Hard Caps:** Keep `maxGridDim <= 512`, `maxTotalVerts <= 1_500_000`, `maxInstances <= 200_000`, `segments <= 256`. Non-finite inputs (`NaN`, `Infinity`) are rejected/clamped.
2. **Indexed & Group-Safe Geometry:** CAD outputs automatically run `indexGeometry` which preserves multi-material `groups`, `drawRange`, `uv1`, `tangent`, vertex `color`, and `InterleavedBufferAttribute` buffers.
3. **Zero Z-Fighting & Hollow Continuity:** Offset layered trims, frames, decals, and glass panes by `>= 0.005 m` along face normals; verify hollow rooms have flush floor/wall/vault joins with no floating skylight seams.
4. **Parenting & Transforms:** Pass `{ parent, x, y, z, rotationX, rotationY, rotationZ, scale }` directly into primitives/CAD calls to keep Outliner hierarchy clean and shallow.
