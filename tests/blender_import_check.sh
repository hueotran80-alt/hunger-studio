#!/usr/bin/env bash
# Kiểm chứng file .glb xuất ra & asset CC0 bằng Blender thật ở chế độ headless CLI (--background).
# Chạy: bash tests/blender_import_check.sh [đường_dẫn_glb_tuỳ_chọn]
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1

BLENDER_BIN="${BLENDER_BIN:-$(command -v blender || true)}"
if [ -z "$BLENDER_BIN" ] && [ -x "/Applications/Blender.app/Contents/MacOS/Blender" ]; then
  BLENDER_BIN="/Applications/Blender.app/Contents/MacOS/Blender"
fi
if [ -z "$BLENDER_BIN" ] || [ ! -x "$BLENDER_BIN" ]; then
  echo "SKIP: không tìm thấy Blender CLI (đặt BLENDER_BIN=/đường/dẫn/blender để chạy thử)"
  exit 0
fi

GLB="${1:-}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/studio-blender.XXXXXX")"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

if [ -z "$GLB" ]; then
  echo "== sinh fixture bằng StudioExporter"
  GLB="$WORK/fixture.glb"
  node --import ./tests/three-resolve-hooks.mjs tests/make_glb_fixture.mjs "$GLB" || {
    echo "FAIL: không sinh được fixture GLB"
    exit 1
  }
fi

if [ ! -f "$GLB" ]; then
  echo "FAIL: không thấy file $GLB"
  exit 1
fi

CHECK_PY="$WORK/blender_check.py"
cat > "$CHECK_PY" << 'PYEOF'
import os
import sys
import bpy

def verify_glb(path, label, min_bones=1, min_fcurves=1):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    res = bpy.ops.import_scene.gltf(filepath=path)
    if 'FINISHED' not in res:
        raise RuntimeError(f"[{label}] import_scene.gltf failed: {res}")

    meshes = [o for o in bpy.data.objects if o.type == 'MESH']
    armatures = [o for o in bpy.data.objects if o.type == 'ARMATURE']
    actions = list(bpy.data.actions)

    if not meshes:
        raise RuntimeError(f"[{label}] No MESH objects imported")
    if not armatures:
        raise RuntimeError(f"[{label}] No ARMATURE objects imported")

    bone_count = max(len(a.data.bones) for a in armatures)
    if bone_count < min_bones:
        raise RuntimeError(f"[{label}] Expected >= {min_bones} bones, got {bone_count}")

    fcurves = sum(len(act.fcurves) for act in actions)
    if not actions or fcurves < min_fcurves:
        raise RuntimeError(f"[{label}] Expected animated actions/fcurves >= {min_fcurves}, got actions={len(actions)} fcurves={fcurves}")

    # Verify non-degenerate mesh geometry
    vert_count = sum(len(m.data.vertices) for m in meshes)
    if vert_count < 8:
        raise RuntimeError(f"[{label}] Suspiciously small vertex count: {vert_count}")

    # Evaluate two frames to ensure scene depsgraph steps cleanly
    scene = bpy.context.scene
    scene.frame_set(1)
    deps1 = bpy.context.evaluated_depsgraph_get()
    arm_eval = armatures[0].evaluated_get(deps1)
    p1 = arm_eval.pose.bones[min(1, len(arm_eval.pose.bones) - 1)].matrix.copy()
    scene.frame_set(15)
    deps2 = bpy.context.evaluated_depsgraph_get()
    arm_eval2 = armatures[0].evaluated_get(deps2)
    p2 = arm_eval2.pose.bones[min(1, len(arm_eval2.pose.bones) - 1)].matrix.copy()

    print(f"ok  [{label}] meshes={len(meshes)} verts={vert_count} armatures={len(armatures)} bones={bone_count} actions={len(actions)} fcurves={fcurves} poseChanged={p1 != p2}")

fixture_path = os.environ["BLENDER_FIXTURE_GLB"]
bot_path = os.environ["BLENDER_BOT_GLB"]
verify_glb(fixture_path, "StudioExporter fixture.glb", min_bones=20, min_fcurves=10)
verify_glb(bot_path, "models/Bot_CC0.glb", min_bones=10, min_fcurves=5)
print("BLENDER IMPORT CHECK PASSED")
PYEOF

echo
echo "== Blender: $("$BLENDER_BIN" --version 2>/dev/null | head -1)"
CHECK_LOG="$WORK/blender.log"
BLENDER_FIXTURE_GLB="$GLB" BLENDER_BOT_GLB="$PWD/models/Bot_CC0.glb" \
  "$BLENDER_BIN" --background --factory-startup --python-exit-code 1 --python "$CHECK_PY" >"$CHECK_LOG" 2>&1
rc=$?
grep -E "^(ok  |BLENDER IMPORT|RuntimeError|Error|Traceback)" "$CHECK_LOG" || tail -25 "$CHECK_LOG"
if [ "$rc" -ne 0 ]; then
  echo "BLENDER IMPORT CHECK FAILED (exit $rc)"
  tail -30 "$CHECK_LOG"
fi
exit "$rc"
