#!/usr/bin/env bash
# Unified Production Quality Gate for Web Blender Studio:
#   - Groups 1..66: Python security/cloud/concurrency + Node geometry/WASM/rig/DSL + Godot + WebGPU Cycles X
#   - Group 67: All 14 Headless Browser, WebGL, Mocap & Chaos UI Suites (`tests/run_browser_suites.mjs`)
#   - Group 68: Production Vite Bundle `dist/` End-to-End Gate (`tests/test_dist_production.mjs --build`)
# Pass `--fast` (or `STUDIO_FAST=1`) to skip Groups 67..68 during rapid local iteration.
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1

FAST_MODE="${STUDIO_FAST:-0}"
for arg in "$@"; do
  if [ "$arg" = "--fast" ]; then
    FAST_MODE=1
  fi
done

PY="${PYTHON:-.venv/bin/python}"
if [ ! -x "$PY" ]; then
  PY="$(command -v python3 || command -v python)"
fi

status=0

echo "== 1/68  Security + robustness (P0) + mocap parity =="
"$PY" -m unittest discover -s tests -p 'test_*.py' -v || status=1

echo
echo "== 2/68  Agent server / bridge =="
"$PY" test_agent_server.py || status=1

echo
echo "== 3/68  Agent core (JS) =="
if command -v node >/dev/null 2>&1; then
  node --import ./tests/three-resolve-hooks.mjs test_agent_core.mjs || status=1
else
  echo "SKIP: node not found"
fi

echo
echo "== 4/68  Client-side mocap (filters, foot-lock, WASM engine) =="
if command -v node >/dev/null 2>&1; then
  node tests/test_mocap_filters.mjs || status=1
else
  echo "SKIP: node not found"
fi

echo
echo "== 5/68  Shared mocap math (median / clamp / frame binary search) =="
if command -v node >/dev/null 2>&1; then
  node tests/test_mocap_math.mjs || status=1
else
  echo "SKIP: node not found"
fi
echo
echo "== 6/68  Rig mapping: Mixamo / VRM-VRoid / Character Creator =="
if command -v node >/dev/null 2>&1; then
  node --import ./tests/three-resolve-hooks.mjs tests/test_rig_mapping.mjs || status=1
else
  echo "SKIP: node not found"
fi

echo
echo "== 7/68  GLB export with AnimationClip (parse back + re-import) =="
if command -v node >/dev/null 2>&1; then
  node --import ./tests/three-resolve-hooks.mjs tests/test_glb_animation.mjs || status=1
else
  echo "SKIP: node not found"
fi

echo
echo "== 8/68  BVH picking + CSG Boolean (three-mesh-bvh / three-bvh-csg) =="
if command -v node >/dev/null 2>&1; then
  node --import ./tests/three-resolve-hooks.mjs tests/test_bvh_csg.mjs || status=1
else
  echo "SKIP: node not found"
fi
echo
echo "== 9/68  Godot headless import of the exported .glb =="
bash tests/godot_import_check.sh || status=1

echo
echo "== 9a/68  Blender headless CLI import of the exported .glb & Bot_CC0.glb =="
bash tests/blender_import_check.sh || status=1

echo
echo "== 10/68  Prefab library (AI Copilot assembly of .glb assets) =="
if command -v node >/dev/null 2>&1; then
  node --import ./tests/three-resolve-hooks.mjs tests/test_prefab_library.mjs || status=1
else
  echo "SKIP: node not found"
fi
echo
echo "== 11/68  Copilot camera-guard + animate engine bridge =="
if command -v node >/dev/null 2>&1; then
  node --import ./tests/three-resolve-hooks.mjs tests/test_copilot_camera_guard.mjs || status=1
else
  echo "SKIP: node not found"
fi
echo
echo "== 12/68  Camera framing matches the source video =="
if command -v node >/dev/null 2>&1; then
  node tests/test_camera_framing.mjs || status=1
else
  echo "SKIP: node not found"
fi
echo
echo "== 13/68  Timeline plays the attached AnimationClip (mocap / imported .glb) =="
if command -v node >/dev/null 2>&1; then
  node --import ./tests/three-resolve-hooks.mjs tests/test_timeline_clip_playback.mjs || status=1
else
  echo "SKIP: node not found"
fi

echo
echo "== 14/68  Embed/share protocol (URL flags, gzip payload, link builders) =="
if command -v node >/dev/null 2>&1; then
  node tests/test_embed_core.mjs || status=1
else
  echo "SKIP: node not found"
fi

echo
echo "== 15/68  CloudClient (sessions, Supabase refresh, errors, uploads) =="
if command -v node >/dev/null 2>&1; then
  node tests/test_cloud_client.mjs || status=1
else
  echo "SKIP: node not found"
fi

echo
echo "== 16/68  Undo/redo command semantics (undo/redo, group, duplicate, history) =="
if command -v node >/dev/null 2>&1; then
  node --import ./tests/three-resolve-hooks.mjs tests/test_scene_history.mjs || status=1
else
  echo "SKIP: node not found"
fi

echo
echo "== 17/68  Light gizmos (single object, selection visibility, clone) =="
if command -v node >/dev/null 2>&1; then
  node --import ./tests/three-resolve-hooks.mjs tests/test_light_helper.mjs || status=1
else
  echo "SKIP: node not found"
fi

echo
echo "== 18/68  Rapier rigid-body simulation (deterministic + bake) =="
if command -v node >/dev/null 2>&1; then
  node --import ./tests/three-resolve-hooks.mjs tests/test_simulation_manager.mjs || status=1
else
  echo "SKIP: node not found"
fi

echo
echo "== 19/68  STEM Mode curriculum, auto-grader, movable avatar & 1-on-1 voice =="
if command -v node >/dev/null 2>&1; then
  node --import ./tests/three-resolve-hooks.mjs tests/test_stem_tutor.mjs || status=1
else
  echo "SKIP: node not found"
fi

echo
echo "== 20/68  Path tracing scene isolation, BVH materials/colors and render budgets =="
if command -v node >/dev/null 2>&1; then
  node --import ./tests/three-resolve-hooks.mjs tests/test_pathtrace_scene.mjs || status=1
else
  echo "SKIP: node not found"
fi

echo
echo "== 21/68  Rust WASM Mesh Kernel (high-poly welding, edges, subdivision) =="
if command -v node >/dev/null 2>&1; then
  node tests/test_mesh_kernel.mjs || status=1
else
  echo "SKIP: node not found"
fi

echo
echo "== 22/68  Geometry Pipeline (codec, budget, mesh topology weld/UV) =="
if command -v node >/dev/null 2>&1; then
  node --import ./tests/three-resolve-hooks.mjs tests/test_geometry_pipeline.mjs || status=1
else
  echo "SKIP: node not found"
fi

echo
echo "== 23/68  Modifier History (stack command undo/redo, byte budget, duplicate) =="
if command -v node >/dev/null 2>&1; then
  node --import ./tests/three-resolve-hooks.mjs tests/test_modifier_history.mjs || status=1
else
  echo "SKIP: node not found"
fi

echo
echo "== 24/68  Deform Modifiers (Solidify, Displace, Smooth, Randomize, EvenEdges) =="
if command -v node >/dev/null 2>&1; then
  node --import ./tests/three-resolve-hooks.mjs tests/test_deform_modifiers.mjs || status=1
else
  echo "SKIP: node not found"
fi

echo
echo "== 25/68  Shading & Normals (Auto-Smooth dihedral angles, Recalculate, Flip) =="
if command -v node >/dev/null 2>&1; then
  node --import ./tests/three-resolve-hooks.mjs tests/test_shading_normals.mjs || status=1
else
  echo "SKIP: node not found"
fi

echo
echo "== 26/68  True Bevel (Edge Chamfer, Round Profile, Overlap Clamp, Angle Limit) =="
if command -v node >/dev/null 2>&1; then
  node --import ./tests/three-resolve-hooks.mjs tests/test_bevel_true.mjs || status=1
else
  echo "SKIP: node not found"
fi

echo
echo "== 27/68  True Catmull-Clark (Curvature Smoothing, Simple Mode, Crease, Boundary) =="
if command -v node >/dev/null 2>&1; then
  node --import ./tests/three-resolve-hooks.mjs tests/test_catmull_clark.mjs || status=1
else
  echo "SKIP: node not found"
fi

echo
echo "== 28/68  Look-Dev Raster & Material Realism (Principled BSDF, Procedural Textures, Post-Processing) =="
if command -v node >/dev/null 2>&1; then
  node --import ./tests/three-resolve-hooks.mjs tests/test_material_realism.mjs || status=1
else
  echo "SKIP: node not found"
fi

echo
echo "== 29/68  Video Export (Rust WASM Kernel, Deterministic Timeline Seek, WebCodecs MP4) =="
if command -v node >/dev/null 2>&1; then
  node --import ./tests/three-resolve-hooks.mjs tests/test_video_export.mjs || status=1
else
  echo "SKIP: node not found"
fi

echo
echo "== 30/68  Path-Tracing Parity (Procedural HalfFloat HDRI, Environment Parity, Session & Hero Frame) =="
if command -v node >/dev/null 2>&1; then
  node --import ./tests/three-resolve-hooks.mjs tests/test_pathtrace_environment.mjs || status=1
else
  echo "SKIP: node not found"
fi

echo
echo "== 31/68  Rust 4-Crate Unit Suite (mesh_kernel, mocap_kernel, video_kernel, render_kernel) =="
if command -v cargo >/dev/null 2>&1; then
  for crate in mesh_kernel mocap_kernel video_kernel render_kernel; do
    echo "  -- cargo test --release --lib ($crate) --"
    (cd "crates/$crate" && cargo test --release --lib 2>&1 | tail -4) || status=1
  done
fi
if command -v node >/dev/null 2>&1; then
  node --import ./tests/three-resolve-hooks.mjs tests/test_rust_render.mjs || status=1
else
  echo "SKIP: node not found"
fi

echo
echo "== 32/68  Blender Pro Modeling (Vertex/Edge Extrude, F, Dissolve, Bridge, Knife, Bevel, Slide, Loops) =="
if command -v node >/dev/null 2>&1; then
  node --import ./tests/three-resolve-hooks.mjs tests/test_blender_pro_tools.mjs || status=1
else
  echo "SKIP: node not found"
fi

echo
echo "== 33/68  Workspace Corner-Drag Split & Join Areas =="
if command -v node >/dev/null 2>&1; then
  node --import ./tests/three-resolve-hooks.mjs tests/test_workspace_areas.mjs || status=1
else
  echo "SKIP: node not found"
fi

echo
echo "== 34/68  Blender-Standard UV Pipeline (Seams, LSCM, Smart Project, Projections, Pack, Stretch) =="
if command -v node >/dev/null 2>&1; then
  node --import ./tests/three-resolve-hooks.mjs tests/test_uv_unwrap.mjs || status=1
else
  echo "SKIP: node not found"
fi

echo
echo "== 35/68  Hard-Surface & Non-Destructive Modifier Stack (Boolean, BoolTool, Decimate, Screw, Weighted Normal) =="
if command -v node >/dev/null 2>&1; then
  node --import ./tests/three-resolve-hooks.mjs tests/test_hard_surface_modifiers.mjs || status=1
else
  echo "SKIP: node not found"
fi

echo
echo "== 36/68  Sculpt Mode 2.0 (Rust WASM 10 Brushes, BVH Sphere Query, Seam Welding, Mask, Voxel Remesh) =="
if command -v node >/dev/null 2>&1; then
  node --import ./tests/three-resolve-hooks.mjs tests/test_sculpt_2.mjs || status=1
else
  echo "SKIP: node not found"
fi

echo
echo "== 37/68  Mouse & Navigation Interaction Regression (LMB/MMB/RMB, ViewHelper, Gizmo, Sculpt Sync) =="
if command -v node >/dev/null 2>&1; then
  node --import ./tests/three-resolve-hooks.mjs tests/test_mouse_interaction.mjs || status=1
else
  echo "SKIP: node not found"
fi

echo
echo "== 38/68  Image Objects (Add Reference/Background/Mesh Plane, Inspector Props, RapidAPI) =="
if command -v node >/dev/null 2>&1; then
  node --import ./tests/three-resolve-hooks.mjs tests/test_image_add.mjs || status=1
else
  echo "SKIP: node not found"
fi

echo
echo "== 39/68  Pure-Rust WASM Mocap Kernel (Despike, 1-Euro, Foot-Lock IK, Retarget & Re-Apply) =="
if command -v node >/dev/null 2>&1; then
  node --import ./tests/three-resolve-hooks.mjs tests/test_mocap_kernel.mjs || status=1
else
  echo "SKIP: node not found"
fi

echo
echo "== 40/68  Rig System (Edit Bones, Weight Paint Brush & Tools, Capsule Auto-Skin, IK, Pose) =="
if command -v node >/dev/null 2>&1; then
  node --import ./tests/three-resolve-hooks.mjs tests/test_rig_system.mjs || status=1
else
  echo "SKIP: node not found"
fi

echo
echo "== 41/68  Mocap Audio Muxing, Multi-Person Subject Lock & ASCII FBX 7.4 =="
if command -v node >/dev/null 2>&1; then
  node --import ./tests/three-resolve-hooks.mjs tests/test_mocap_audio_fbx.mjs || status=1
else
  echo "SKIP: node not found"
fi

echo
echo "== 42/68  Join multi-material + merge groups + atomic undo/redo =="
if command -v node >/dev/null 2>&1; then
  node --import ./tests/three-resolve-hooks.mjs tests/test_join_merge.mjs || status=1
else
  echo "SKIP: node not found"
fi

echo
echo "== 43/68  Character pipeline (auto-skin, pose keys, bake, glTF skin/anim; D1/D2/D4 verified) =="
if command -v node >/dev/null 2>&1; then
  node --import ./tests/three-resolve-hooks.mjs tests/test_character_pipeline.mjs || status=1
else
  echo "SKIP: node not found"
fi

echo
echo "== 44/68  Wave 0 Storage (OPFS/IDB BlobStore, Schema v5 Migration, DataBlocks, Rolling Autosave, .wbs ZIP) =="
if command -v node >/dev/null 2>&1; then
  node --import ./tests/three-resolve-hooks.mjs tests/test_wave0_storage.mjs || status=1
else
  echo "SKIP: node not found"
fi

echo
echo "== 45/68  Wave 1B/1C Interchange (Full FBX 7.4 Mesh+Skin+BlendShape, USDZ 64B-aligned, 3MF, Game Pack LOD/UCX/UV2) =="
if command -v node >/dev/null 2>&1; then
  node --import ./tests/three-resolve-hooks.mjs tests/test_wave1_interchange.mjs || status=1
else
  echo "SKIP: node not found"
fi

echo
echo "== 46/68  Wave 2 Surface (Vertex/Texture Paint, Rust BVH Bake, Shader Nodes GLSL/WASM, Asset Browser) =="
if command -v node >/dev/null 2>&1; then
  node --import ./tests/three-resolve-hooks.mjs tests/test_wave2_surface.mjs || status=1
else
  echo "SKIP: node not found"
fi

echo
echo "== 47/68  Wave 3 Modeling (Curves/Text3D, 10 Pro Modifiers, Subdiv Levels, Collections/Orientations, Dyntopo/Multires) =="
if command -v node >/dev/null 2>&1; then
  node --import ./tests/three-resolve-hooks.mjs tests/test_wave3_modeling.mjs || status=1
else
  echo "SKIP: node not found"
fi

echo
echo "== 48/68  Wave 4A Graph Editor (Bezier F-Curve solver, handles, extrapolation, UI, Undo, JSON) =="
if command -v node >/dev/null 2>&1; then
  node --import ./tests/three-resolve-hooks.mjs tests/test_wave4a_graph_editor.mjs || status=1
else
  echo "SKIP: node not found"
fi

echo
echo "== 49/68  Wave 4B Actions, NLA Mixer & Sandboxed Drivers =="
if command -v node >/dev/null 2>&1; then
  node --import ./tests/three-resolve-hooks.mjs tests/test_wave4b_nla_drivers.mjs || status=1
else
  echo "SKIP: node not found"
fi

echo
echo "== 50/68  Wave 4C Automatic Weights (Bone Heat), Vertex Groups, Armature Pro & Render Subdiv =="
if command -v node >/dev/null 2>&1; then
  node --import ./tests/three-resolve-hooks.mjs tests/test_wave4c_rig_vertex.mjs || status=1
else
  echo "SKIP: node not found"
fi

echo
echo "== 51/68  Asset Library (CC0/CC-BY catalog integrity, Fab link-only, local scan, credits) =="
if command -v node >/dev/null 2>&1; then
  node --import ./tests/three-resolve-hooks.mjs tests/test_asset_library.mjs || status=1
else
  echo "SKIP: node not found"
fi

echo
echo "== 52/68  STEM live voice session (continuous listening, barge-in, wake word, auto-submit) =="
if command -v node >/dev/null 2>&1; then
  node tests/test_stem_voice_session.mjs || status=1
else
  echo "SKIP: node not found"
fi

echo
echo "== 53/68  AI live scene digest (hierarchy, poly, materials, clips, selection) =="
if command -v node >/dev/null 2>&1; then
  node tests/test_scene_digest.mjs || status=1
else
  echo "SKIP: node not found"
fi

echo
echo "== 54/68  Agent tool bridge (68-tool catalog, JSON tool protocol, confirm/timeout, runtime install) =="
if command -v node >/dev/null 2>&1; then
  node tests/test_agent_tool_bridge.mjs || status=1
else
  echo "SKIP: node not found"
fi

echo
echo "== 55/68  Copilot guard (chặn fetch/storage/API/DOM/eval + sandbox scope, share-dialog lazy) =="
if command -v node >/dev/null 2>&1; then
  node tests/test_copilot_guard.mjs || status=1
else
  echo "SKIP: node not found"
fi

echo
echo "== 56/68  Mode Resolver (Mesh/Group/Character/Bone/Armature mode switching) =="
if command -v node >/dev/null 2>&1; then
  node --import ./tests/three-resolve-hooks.mjs tests/test_mode_resolver.mjs || status=1
else
  echo "SKIP: node not found"
fi

echo
echo "== 57/68  Copilot + STEM Wake-Word Auto-Start & Multi-Step Guided Walkthrough =="
if command -v node >/dev/null 2>&1; then
  node --import ./tests/three-resolve-hooks.mjs tests/test_voice_wake_and_walkthrough.mjs || status=1
else
  echo "SKIP: node not found"
fi

echo
echo "== 58/68  WebGPU Cycles X GPU Suite (high-perf adapter, TDR chunks, Texture Atlas, HDRI MIS, SVGF, 720p MP4) =="
if command -v node >/dev/null 2>&1; then
  node tests/test_webgpu_cycles_x.mjs || status=1
else
  echo "SKIP: node not found"
fi

echo
echo "== 59/68  Concurrency, Cancellation & Face/Hand Solvers (latest-wins, AbortSignal, ARKit/21-pt) =="
if command -v node >/dev/null 2>&1; then
  node --import ./tests/three-resolve-hooks.mjs tests/test_concurrency_cancellation.mjs || status=1
else
  echo "SKIP: node not found"
fi

echo
echo "== 60/68  Rust WASM QEM Auto-LOD, Fast Orbit Governor & 50k Surface Scatter =="
if command -v node >/dev/null 2>&1; then
  node --import ./tests/three-resolve-hooks.mjs tests/test_rust_lod_scatter.mjs || status=1
else
  echo "SKIP: node not found"
fi

echo
echo "== 61/68  Rust WASM Multi-Format DCC/CAD/Studio Importers & Smart ZIP PBR Bundle =="
if command -v node >/dev/null 2>&1; then
  node --import ./tests/three-resolve-hooks.mjs tests/test_rust_dcc_importers.mjs || status=1
else
  echo "SKIP: node not found"
fi

echo
echo "== 62/68  Wave 1 Regression Suite (Security/XSS, Rig/Exporter Integrity, Memory/History, BVH) =="
if command -v node >/dev/null 2>&1; then
  node --import ./tests/three-resolve-hooks.mjs tests/test_wave1_bleeding_fixes.mjs || status=1
else
  echo "SKIP: node not found"
fi

echo
echo "== 63/68  Wave 2 Regression Suite (Look-Dev/HDRI, UV LSCM/Pins, Sculpt/WASM, Physics, Multi-Select, Outliner/UI) =="
if command -v node >/dev/null 2>&1; then
  node --import ./tests/three-resolve-hooks.mjs tests/test_wave2_fixes.mjs || status=1
else
  echo "SKIP: node not found"
fi

echo
echo "== 64/68  Wave 3 Regression Suite (Mocap/IK/Face/BVH, Render/Video, Embed/Assets, STEM/Copilot/MCP) =="
if command -v node >/dev/null 2>&1; then
  node --import ./tests/three-resolve-hooks.mjs tests/test_wave3_fixes.mjs || status=1
else
  echo "SKIP: node not found"
fi

echo
echo "== 65/68  Copilot Worker (scene mirror, serialization, asset adoption, capability isolation) =="
if command -v node >/dev/null 2>&1; then
  node --import ./tests/three-resolve-hooks.mjs tests/test_copilot_worker.mjs || status=1
else
  echo "SKIP: node not found"
fi

echo
echo "== 66/68  Agent exec isolation (DOM, storage, worker, navigation denial) =="
if command -v node >/dev/null 2>&1; then
  node tests/test_agent_exec_isolation.mjs || status=1
else
  echo "SKIP: node not found"
fi

echo
echo "== 66a/68  Cloudflare Worker, Parametric CAD, GLB Optimizer, Budget, Skills & Hardening =="
if command -v node >/dev/null 2>&1; then
  node tests/test_cloudflare_worker.mjs || status=1
  node tests/test_parametric_cad.mjs || status=1
  node --import ./tests/three-resolve-hooks.mjs tests/test_glb_optimizer.mjs || status=1
  node --import ./tests/three-resolve-hooks.mjs tests/test_phase2_cad_budget.mjs || status=1
  node --import ./tests/three-resolve-hooks.mjs tests/test_hunger_skills.mjs || status=1
  node --import ./tests/three-resolve-hooks.mjs tests/test_procedural_contract.mjs || status=1
  node --import ./tests/three-resolve-hooks.mjs tests/test_agent_shortcuts.mjs || status=1
  node --import ./tests/three-resolve-hooks.mjs tests/test_p1_hardening.mjs || status=1
  node --import ./tests/three-resolve-hooks.mjs tests/test_beta_motion_telemetry.mjs || status=1
  node --import ./tests/three-resolve-hooks.mjs tests/test_skeleton_templates_and_rig_pro.mjs || status=1
else
  echo "SKIP: node not found"
fi

if [ "$FAST_MODE" != "1" ]; then
  echo
  echo "== 67/68  All 14 Headless Browser, WebGL & Chaos UI Suites (0 failed, 0 COEP blocked, 0 uncaught) =="
  if command -v node >/dev/null 2>&1; then
    node tests/run_browser_suites.mjs || status=1
  else
    echo "SKIP: node not found"
  fi

  echo
  echo "== 68/68  Production Vite Bundle dist/ End-to-End Gate (build + Workers + WASM + Rapier + Embed) =="
  if command -v node >/dev/null 2>&1; then
    node tests/test_dist_production.mjs --build || status=1
  else
    echo "SKIP: node not found"
  fi
else
  echo
  echo "SKIP 67..68: --fast / STUDIO_FAST=1 enabled"
fi

echo
if [ "$status" -eq 0 ]; then
  echo "ALL AUTOMATED SUITES PASSED"
else
  echo "SOME SUITES FAILED (exit $status)"
fi
exit "$status"
