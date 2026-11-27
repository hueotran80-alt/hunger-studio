---
name: hunger-orchestrator
description: End-to-end orchestration for building, texturing, lighting, optimizing, and exporting commercial 3D assets and hollow walkable scenes 100% natively inside Hunger 3D Studio (studio.* DSL, Copilot Worker, or Remote MCP).
---

# Hunger 3D Orchestrator

Master orchestration workflow for any multi-phase 3D modeling, architectural visualization, industrial/product design, rigged character scene, or reference-locked asset production inside **Hunger 3D Studio** (100% web-native Three.js + Rust WASM + WebGL/WebGPU studio).

## 1. Execution Environment & Capability Preflight
Before writing or running geometry code, identify the active execution target and respect its exact boundary:

| Target | Entry Point | Capabilities & Hard Limits |
| :--- | :--- | :--- |
| **Browser Main DSL** | `window.studio.*` / Remote MCP `studio_execute_dsl` | Full `studio.*` CAD, procedural PBR, `createSignTexture` (DOM canvas), `exportModel`, `renderVideo`, `Modifiers`, `simulationManager`, `SceneManager` Undo/Redo. |
| **Copilot Worker** | `js/ai/copilot-exec-worker.js` via `CopilotRuntime` | Isolated CSP Worker (`connect-src 'none'`, `worker-src 'none'`), mirrored `THREE` + `studio.*` CAD/Instancing/Budget + allowlisted LIVE commands (`LIVE_COMMAND_META`). **No DOM (`createSignTexture`), no `fetch`, no storage.** |
| **Agent Exec Worker** | `agent.exec()` / Remote MCP `studio_agent_call` | Isolated CSP Worker with `ALLOWED_NEW_NODE_TYPES` allowlist (`E_UNSUPPORTED` on unsupported types), UUID-keyed queued host commands (`applyProceduralPBR`, `boolean`, `exportModel`), early monotonic deadline. |
| **Headless QA / CLI** | `bash tests/run_all.sh`, headless Chromium CDP, headless Blender/Godot | Always prefer headless/CLI execution for verification, builds, and DCC import checks; never launch desktop GUI tools unless explicitly requested. |

### Mandatory Preflight Rules
1. Confirm target budget tier (`mobile`, `product`, or `architecture`) before modeling.
2. Verify all required external `.glb` or texture URLs exist and pass provenance/size checks before scene mutation.
3. If a required capability or asset is unavailable, fail explicitly (`E_UNSUPPORTED`, `E_ASSET`, `E_PERMISSION`, `E_TX_CONFLICT`, `E_TIMEOUT`, `E_BUSY`) — **never** fabricate success or swallow required-asset errors in empty `catch (_) {}` blocks.
4. Keep Antigravity skills (`.agents/skills/hunger-*`) synchronized with the in-app Copilot skill engine (`js/ai/copilot-skills.js`) whenever new `studio.*` capabilities ship.

## 2. Six-Phase Production Pipeline (Strict Order)
Delegate each phase to its dedicated specialist Hunger skill and verify exit criteria before advancing:

1. **Phase 1 — Contract & Proportions (`hunger-project-contract`)**
   - Output a deterministic JSON contract (`units: "meters"`, `upAxis: "Y"`, `seed`, `budgetTier`, `dimensions`, `parts`, `materials`, `externalAssets`, `shotMatrix`).
   - Measure W:H, D:H, bay/tier counts, and hollow cavity clearances directly from reference views when supplied.
2. **Phase 2 — Parametric Modeling & Instancing (`hunger-parametric-cad`)**
   - Author watertight CAD geometry (`addExtrude`, `addSweep`, `addLathe`, `addLoft`, `addSurfaceGrid`, `boolean`, `sampleCurve3D`, `scatterOnCurve`, `mergeMeshes`, `addInstancedMesh`) rather than stacking raw cubes.
   - Consolidate static parts by material (`mergeMeshes({ removeSources: true, vertexAO: true })`) and instance repeated assemblies (`addInstancedMesh` / `scatterOnCurve`).
3. **Phase 3 — Procedural PBR, UVs & Look-Dev (`hunger-surface-pbr`)**
   - Share canonical materials; apply physical-scale `boxProjectUV`; run async `await studio.applyProceduralPBR(...)` using the 13 Worker patterns; verify `vertexColors` parity and `TextureLeaseRegistry` safety.
4. **Phase 4 — Characters, Rigging & Motion (`hunger-character-mocap`)** *(when scene includes actors/characters)*
   - Load CC0 rigs or external rigged GLBs, normalize height via `Box3`, never rename bound bones, verify live bone transform delta and clip track integrity.
5. **Phase 5 — Lighting, Shadows & Camera Calibration (`hunger-camera-look`)**
   - Mark horizon planes (`> 100 m`) `castShadow: false`, fit 4K sun frustum (`setupSunLight`), add non-shadow interior fill lights for hollow volumes, set AgX quality (`setRenderQuality`), and preserve user camera control.
6. **Phase 6 — Budget, Multi-Zoom QA & Delivery (`hunger-runtime-budget-agent` + `hunger-multizoom-qa-delivery`)**
   - Run `studio.inspectSceneBudget(root, { tier })`, capture the 5-shot multi-zoom matrix, compare side-by-side against references, export optimized `.glb` (JPEG color + lossless PNG data maps), verify GLB re-import, and run the full automated gate.

## 3. Zero-Hardcode & Commercial Architecture Rules
- **0% Project Hardcoding:** Engine modules (`js/`, `index.html`, `dist/`) and all 8 generic `.agents/skills/hunger-*` skills must remain 100% domain-agnostic and reusable across any architecture, product, mechanical, vehicle, or character domain.
- **Project Isolation:** Put single-project coordinates, palettes, asset lists, and reference shot matrices exclusively inside a thin Project Profile or JSON contract.
- **Atomic Undo Discipline:** Wrap multi-step destructive merges, instancing, and procedural material swaps so a single `Ctrl+Z` cleanly restores the scene without orphaned geometry or leaked GPU leases.
