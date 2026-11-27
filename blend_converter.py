"""Headless Blender .blend -> .glb conversion service (Wave 1A).

Uses an installed Blender binary (`BLENDER_BIN` env or PATH/standard install)
rather than re-implementing SDNA parsing in JS/Python. Fails cleanly with a
clear `BlenderNotAvailableError` when Blender is absent instead of faking output.
"""

import json
import os
import shutil
import subprocess
import tempfile

MAX_BLEND_BYTES = 100 * 1024 * 1024
DEFAULT_TIMEOUT_SEC = 120
ROOT_DIR = os.path.dirname(os.path.abspath(__file__))
BLEND_TO_GLB_SCRIPT = os.path.join(ROOT_DIR, "scripts", "blend_to_glb.py")


class BlenderNotAvailableError(RuntimeError):
    """Raised when no working Blender executable is installed on the host."""


class BlendValidationError(ValueError):
    """Raised when uploaded data is not a valid .blend payload."""


class BlendConversionError(RuntimeError):
    """Raised when Blender fails during conversion."""


def is_valid_blend_bytes(raw_bytes: bytes) -> bool:
    """Checks raw BLENDER header, gzip-compressed (.blend), or zstd-compressed (.blend 3.x+)."""
    if not isinstance(raw_bytes, (bytes, bytearray)) or len(raw_bytes) < 12:
        return False
    head = bytes(raw_bytes[:7])
    if head == b"BLENDER":
        return True
    if raw_bytes[:2] == b"\x1f\x8b":
        return True
    if raw_bytes[:4] == b"\x28\xb5\x2f\xfd":
        return True
    return False


def _probe_blender_executable(candidate: str):
    if not candidate or not os.path.exists(candidate):
        return None
    try:
        proc = subprocess.run(
            [candidate, "--version"],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
        out = (proc.stdout or "") + "\n" + (proc.stderr or "")
        if proc.returncode == 0 and "Blender" in out:
            first_line = out.strip().splitlines()[0].strip()
            return {"available": True, "path": candidate, "version": first_line, "error": None}
        return {"available": False, "path": candidate, "version": None, "error": out.strip() or f"exit {proc.returncode}"}
    except Exception as exc:
        return {"available": False, "path": candidate, "version": None, "error": str(exc)}


DEFAULT_STANDARD_PATHS = (
    "/Applications/Blender.app/Contents/MacOS/Blender",
    "/usr/bin/blender",
    "/snap/bin/blender",
    r"C:\Program Files\Blender Foundation\Blender 4.2\blender.exe",
    r"C:\Program Files\Blender Foundation\Blender 4.0\blender.exe",
)


def find_blender_binary(env=None, standard_paths=None):
    """Locates a working Blender binary without trusting broken wrapper symlinks."""
    env = os.environ if env is None else env
    explicit = str(env.get("BLENDER_BIN", "") or "").strip()
    if explicit:
        probe = _probe_blender_executable(explicit)
        if probe and probe["available"]:
            return probe
        return {
            "available": False,
            "path": None,
            "version": None,
            "error": (probe and probe.get("error")) or f"Configured BLENDER_BIN is invalid: {explicit}",
        }

    candidates = []
    which_path = shutil.which("blender", path=env.get("PATH"))
    if which_path:
        candidates.append(which_path)

    for std in (DEFAULT_STANDARD_PATHS if standard_paths is None else standard_paths):
        if std not in candidates:
            candidates.append(std)

    last_error = None
    for cand in candidates:
        probe = _probe_blender_executable(cand)
        if probe and probe["available"]:
            return probe
        if probe and probe["error"]:
            last_error = probe["error"]

    return {
        "available": False,
        "path": None,
        "version": None,
        "error": last_error or "Blender executable not found. Install Blender 3.6+/4.x or set BLENDER_BIN.",
    }


def convert_blend_bytes_to_glb(
    raw_bytes: bytes,
    apply_modifiers: bool = False,
    timeout_sec: int = DEFAULT_TIMEOUT_SEC,
    blender_bin: str = None,
):
    """Converts raw .blend bytes into GLB bytes + report via headless Blender."""
    if not raw_bytes or len(raw_bytes) > MAX_BLEND_BYTES:
        raise BlendValidationError(f".blend payload must be between 1 byte and {MAX_BLEND_BYTES // (1024 * 1024)} MB.")
    if not is_valid_blend_bytes(raw_bytes):
        raise BlendValidationError("Invalid .blend file signature (expected BLENDER, gzip, or zstd header).")

    if blender_bin:
        probe = _probe_blender_executable(blender_bin)
        if not probe or not probe["available"]:
            raise BlenderNotAvailableError(probe["error"] if probe else f"Invalid BLENDER_BIN: {blender_bin}")
    else:
        probe = find_blender_binary()
        if not probe["available"]:
            raise BlenderNotAvailableError(probe["error"])

    blender_exe = probe["path"]
    if not os.path.isfile(BLEND_TO_GLB_SCRIPT):
        raise BlendConversionError(f"Missing conversion script: {BLEND_TO_GLB_SCRIPT}")

    with tempfile.TemporaryDirectory(prefix="wbs_blend_") as tmpdir:
        in_path = os.path.join(tmpdir, "input.blend")
        out_path = os.path.join(tmpdir, "output.glb")
        report_path = os.path.join(tmpdir, "report.json")

        with open(in_path, "wb") as f:
            f.write(raw_bytes)

        cmd = [
            blender_exe,
            "-b",
            in_path,
            "--factory-startup",
            "--python",
            BLEND_TO_GLB_SCRIPT,
            "--",
            out_path,
            report_path,
        ]
        if apply_modifiers:
            cmd.append("--apply-modifiers")

        try:
            proc = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=max(10, int(timeout_sec)),
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            raise BlendConversionError(f"Blender conversion timed out after {timeout_sec}s.") from exc

        if proc.returncode != 0 or not os.path.isfile(out_path):
            tail = ((proc.stderr or "") + "\n" + (proc.stdout or "")).strip()[-800:]
            raise BlendConversionError(f"Blender exited with code {proc.returncode}: {tail}")

        with open(out_path, "rb") as f:
            glb_bytes = f.read()

        report = {}
        if os.path.isfile(report_path):
            try:
                with open(report_path, "r", encoding="utf-8") as f:
                    report = json.load(f)
            except Exception:
                report = {}

        return {
            "glbBytes": glb_bytes,
            "report": report,
            "blenderVersion": probe.get("version"),
        }
