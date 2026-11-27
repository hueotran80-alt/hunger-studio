---
name: hunger-runtime-budget-agent
description: Enforce commercial WebGL memory, draw-call, triangle, and GLB export budgets plus safe Worker/transaction execution inside Hunger 3D Studio.
---

# Hunger Runtime Budget & Agent Safety

Use this skill on every non-trivial 3D build, optimization pass, Copilot Worker script, `agent.exec` call, or commercial `.glb` export inside **Hunger 3D Studio**.

## 1. Commercial Budget Tiers (`studio.inspectSceneBudget()`)
Always audit with `const report = studio.inspectSceneBudget(root, { tier })` (accepts `'mobile'`, `'product'`, or `'architecture'` directly or via options) and keep `report.status === 'ok'`:

| Tier | Rendered Tris | Draw Calls | Texture VRAM (w/ Mips) | Exported GLB |
| :--- | :--- | :--- | :--- | :--- |
| `mobile` | `<= 30,000` | `<= 40` | `<= 32 MB` | `<= 5 MB` |
| `product` | `<= 50,000` | `<= 60` | `<= 64 MB` | `<= 8 MB` |
| `architecture` | `<= 750,000` | `<= 350` | `<= 96 MB` | `<= 24 MB` |

Note: `inspectSceneBudget` accurately counts **multi-material geometry groups** as individual draw calls, accounts for `InstancedMesh` matrix buffer bytes (`count × 64 B`), handles `InterleavedBufferAttribute` buffers, and tracks `uniqueTris` vs `renderedTris`, `uniqueGeomMB`, `textureVRAM_MB`, `estimatedGlbMB`, and `jsHeapMB`.

### Hard Engine Safety Caps
- Script size: `<= 200 KB`; serialized mirror payload: `<= 24 MB`; max objects: `5,000`.
- Procedural texture size: `<= 2048×2048` (LRU byte budget `128 MB`, protected by `TextureLeaseRegistry`).
- Parametric CAD preflight: `maxGridDim <= 512`, `maxTotalVerts <= 1,500,000`, `maxInstances <= 200,000`.
- Commercial bundle asset policy (`asset-ship-policy.json`): `<= 5 MB` per shipped asset, `0` files `> 25 MB` in `dist/`.

## 2. Worker Sandbox, Transactions & Isolation Contract
1. **CSP Worker Enforcement:** Both `CopilotRuntime` (`copilot-exec-worker.js`) and `agent.exec` (`agent-exec-worker.js`) verify `Content-Security-Policy` (`connect-src 'none'`, `worker-src 'none'`) before launch. `E_PERMISSION` errors are hard security blocks and **must never** trigger auto-repair or fallback to main-thread `AsyncFunction`.
2. **Absolute Monotonic Deadline:** Execution deadlines (`deadlineAt`) begin **before** `fetch(workerURL)` and govern the entire pipeline (fetch + Worker execution + commit + queued host/LIVE commands) with a single `AbortController`.
3. **Per-Command Conflict Metadata (`LIVE_COMMAND_META`):** Copilot checks selection and camera invariants around every individual LIVE command using explicit metadata (`mutatesSelection`, `mutatesCamera`, `mutatesEditMode`, `mutatesScene`) — never regex guesses. Rollback on `E_TX_CONFLICT` preserves the user's newer selection.
4. **Node Type Allowlist & UUID Identity (`agent.exec`):** `validateExecNodes` (`ALLOWED_NEW_NODE_TYPES`) permits only supported mirror types (`Mesh`, `InstancedMesh`, `Group`, `Object3D`, `Bone`, `PointLight`, `DirectionalLight`, `SpotLight`, `HemisphereLight`, `AmbientLight`) and throws `E_UNSUPPORTED` on unsupported types (e.g., `RectAreaLight`) instead of silent downgrade. Queued commands (`applyProceduralPBR`, `setColor`, `setEmissive`, `boolean`) resolve targets by stable **UUID** even after renames.

## 3. Memory Cleanup & Commercial GLB Export Mutex
- Call `studio.clearScene()` before full rebuilds to free GPU geometries, procedural LRU cache entries, and `renderer.renderLists`.
- Export with:
  ```js
  const res = await studio.exportModel({
    binary: true,
    optimize: true,
    textureFormat: 'auto',     // opaque color maps -> JPEG, alpha & all data maps -> lossless PNG
    lossyDataMaps: false,
    maxTextureSize: 1024,
    indexGeometries: true,     // preserves multi-material groups, drawRange, uv1, tangent
    deduplicateMaterials: true // compares full Standard + Physical signature
  });
  ```
- **Export Abort & Mutex Invariant:** `StudioExporter.exportGLTF` enforces a strict single-job mutex (`E_BUSY`). If aborted via `AbortSignal` mid-parse, the caller rejects immediately with `AbortError`, while `restoreAll()` and mutex unlock defer safely until `GLTFExporter.parse()` settles — preventing use-after-dispose and overlapping exports.
