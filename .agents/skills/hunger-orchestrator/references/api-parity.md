# Hunger 3D Studio — Host Parity Reference (`RapidStudio` ↔ `Copilot Worker` ↔ `agent.exec`)

| Capability | `window.studio` (Main) | `copilot-exec-worker.js` | `agent-exec-worker.js` | Execution Mode |
|---|---|---|---|---|
| Primitives (`addCube`, `addSphere`, `addCylinder`, `addCone`, `addTorus`, `addPlane`, `addGroup`) | Yes | Yes | Yes | Mirror / Direct |
| Parametric CAD (`addExtrude`, `addSweep`, `addLathe`, `addSurfaceGrid`, `addLoft`, `mergeMeshes`) | Yes | Yes | Yes | Pure Geometry |
| 3D Curves & Instancing (`sampleCurve3D` / `createCurve3D`, `scatterOnCurve`, `scatter`, `addInstancedMesh`) | Yes | Yes | Yes | Pure Geometry + `InstancedMesh` |
| Geometry Modifiers (`modifyGeometry`, `indexGeometry`) | Yes | Yes | Yes | Pure Geometry |
| CSG Boolean (`boolean`) | Yes | Queued LIVE | Queued LIVE | Host Transaction |
| Procedural PBR (`applyProceduralPBR`) | Async Worker | Queued LIVE | Queued LIVE | Host Worker + Lease |
| Scene Budget (`inspectSceneBudget`) | Sync | Sync (Mirror) | Sync (Mirror) | Pure Read |
| Export (`exportModel` / `exportGLTF`) | Async | Queued LIVE | Queued LIVE | Host Exporter |

## Security Boundaries
- Both `copilot-exec-worker.js` and `agent-exec-worker.js` execute with CSP `connect-src 'none'; worker-src 'none'` and deny `fetch`, `XMLHttpRequest`, `WebSocket`, `indexedDB`, `caches`, `cookieStore`, `Worker`, `location`, `navigator`.
- Destructive deletions (`X`, `Delete`, `Shift+X`, `Shift+Delete`) enforce `E_NEEDS_CONFIRM`.
- Linear data maps (`normalMap`, `roughnessMap`, `metalnessMap`, `aoMap`, `clearcoatNormalMap`, `bumpMap`, `displacementMap`) stay lossless `image/png` on GLB and `.wbs` export.
