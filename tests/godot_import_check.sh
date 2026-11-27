#!/usr/bin/env bash
# Giai đoạn 1.3 — kiểm chứng file .glb xuất ra bằng một engine THẬT (Godot).
#
# 1. Sinh fixture bằng chính StudioExporter (Node).
# 2. Tạo project Godot tạm, copy .glb vào, chạy `godot --headless --import`.
# 3. Chạy tests/godot_import_check.gd để kiểm tra xương, track, animation thật sự chạy.
#
# Không có Godot trên máy thì in SKIP và thoát 0 (được ghi rõ, không tính là PASS).
# Chạy: bash tests/godot_import_check.sh [đường_dẫn_glb_tuỳ_chọn]
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1

GODOT_BIN="${GODOT_BIN:-$(command -v godot4 || command -v godot || true)}"
if [ -z "$GODOT_BIN" ] && [ -x "/Applications/Godot.app/Contents/MacOS/Godot" ]; then
  GODOT_BIN="/Applications/Godot.app/Contents/MacOS/Godot"
fi
if [ -z "$GODOT_BIN" ] || [ ! -x "$GODOT_BIN" ]; then
  echo "SKIP: không tìm thấy Godot (đặt GODOT_BIN=/đường/dẫn/godot để chạy thử)"
  exit 0
fi

GLB="${1:-}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/studio-godot.XXXXXX")"
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

PROJ="$WORK/project"
mkdir -p "$PROJ"
cp "$GLB" "$PROJ/model.glb"
cp tests/godot_import_check.gd "$PROJ/check.gd"
printf 'config_version=5\n\n[application]\nconfig/name="glb-import-check"\n' > "$PROJ/project.godot"

echo
echo "== Godot: $("$GODOT_BIN" --version 2>/dev/null | head -1)"
echo "== import $(basename "$GLB") ($(wc -c < "$GLB" | tr -d ' ') byte)"
IMPORT_LOG="$WORK/import.log"
"$GODOT_BIN" --headless --path "$PROJ" --import >"$IMPORT_LOG" 2>&1
import_status=$?
if [ "$import_status" -ne 0 ]; then
  echo "FAIL: godot --import thoát với mã $import_status"
  tail -30 "$IMPORT_LOG"
  exit 1
fi
if grep -qiE "error|failed to load" "$IMPORT_LOG"; then
  echo "FAIL: log import có lỗi"
  grep -iE "error|failed to load" "$IMPORT_LOG" | head -10
  exit 1
fi
echo "   import OK (không có lỗi)"

CHECK_LOG="$WORK/check.log"
GLB_MODEL="res://model.glb" "$GODOT_BIN" --headless --path "$PROJ" -s check.gd >"$CHECK_LOG" 2>&1
check_status=$?
grep -E "^(ok|FAIL|      |==|GODOT)" "$CHECK_LOG"
echo
if [ "$check_status" -eq 0 ]; then
  echo "GODOT IMPORT CHECK PASSED"
else
  echo "GODOT IMPORT CHECK FAILED (exit $check_status)"
fi
exit "$check_status"
