---
name: hunger-multizoom-qa-delivery
description: Execute multi-zoom visual inspection, topology/budget validation, GLB/WBS round-trip checks, and commercial delivery packaging for Hunger 3D Studio assets.
---

# Hunger Multi-Zoom QA & Delivery

Use this skill at every milestone and before delivering any 3D scene, exported `.glb`/`.wbs`, or engine change in **Hunger 3D Studio**. Never declare visual or production readiness without capturing and inspecting real rendered frames and passing the automated gate.

## 1. Mandatory 5-Shot Multi-Zoom Visual Matrix
Capture and inspect at least 4–5 calibrated views via `studio_capture_viewport` (Remote MCP) or headless Chromium CDP:
1. **Overview / Macro Elevation:** Verify silhouette proportion (`W:H`, `D:H`), vertical hierarchy, skyline balance, and far-field material tone.
2. **3/4 Hero & Side/Rear Massing:** Verify depth, roof junctions, rear/side wings, shadow continuity (zero clipped shadow frustum), and backface culling.
3. **Close-Up Micro-Detail (`5–20 m` arch / `0.5–2 m` product):** Verify mitered moldings, tracery, balusters, fasteners/hardware, texture crispness, UV tile scale, and **zero floating geometry or z-fighting**.
4. **Hollow Interior / Cavity Shot** *(required for hollow assets)*: Place camera inside at eye height (`1.7–3.2 m`) and verify continuous walls/floor/vault, unobstructed volume, warm interior fill bounce, and interior fixtures.
5. **Side-by-Side Reference Composite** *(required for reference-locked builds)*: Place source reference photos directly beside matched Hunger captures and audit concrete deltas (silhouette, part counts, color value, material contrast) before sign-off.

## 2. Technical Round-Trip & Asset Integrity Gate
1. **Scene Budget Audit:** Run `studio.inspectSceneBudget(root, { tier })` and record:
   - `uniqueTris`, `renderedTris`, `drawCalls`, `uniqueMaterials`, `uniqueImages` (`colorMapCount` / `dataMapCount`), `uniqueGeomMB`, `textureVRAM_MB`, `estimatedGlbMB`, `jsHeapMB`, `status`.
2. **GLB Export & Semantic Parity Audit:** Export with `optimize: true, textureFormat: 'auto', lossyDataMaps: false` and verify:
   - Exact mesh/primitive count and multi-material `groups` match pre-export scene.
   - Data maps (`normalMap`, `roughnessMap`, `metalnessMap`, `aoMap`) remain lossless `image/png`; opaque albedo maps compress to `image/jpeg`.
   - Re-import `.glb` cleanly via `GLTFLoader` (plus headless Godot/Blender import checks for DCC delivery).
   - Export `.wbs` round-trip succeeds with zero runtime lease/userData bloat.
3. **Runtime Hygiene:** Confirm `0` console errors, `0` uncaught exceptions, `0` COEP/CSP blocks, `0` missing required assets, and interactive `OrbitControls` restored cleanly after scripted captures.

## 3. Full Repository & Production Deployment Gate (When Modifying Studio Code)
- Run the complete quality gate in headless/CLI mode (never skip browser or production checks before release):
  ```bash
  bash tests/run_all.sh
  ```
  Verify:
  - **Fast Gate:** Python security/cloud/agent + Node CAD/PBR/Worker/Skills + Rust WASM + Godot/Blender import PASS.
  - **Headless Browser Suites:** All 14/14 suites PASS (`0` failed, `0` COEP blocked, `0` uncaught).
  - **Production `dist/` Gate:** Vite build + `dist/` size policy (`0` files `> 25 MB`) + all 9/9 runtime checks PASS.
- When deploying live to Cloudflare Workers, run `npx cf deploy` and record the live URL + deployed Version ID.
