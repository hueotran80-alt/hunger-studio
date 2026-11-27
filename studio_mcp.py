#!/usr/bin/env python3
"""
Web Blender Studio - Model Context Protocol (MCP) Server
File: studio_mcp.py

Allows AI assistants (including Antigravity, Claude, ChatGPT) to directly
interact with, inspect, generate, and manipulate 3D scenes in the live
Web Blender Studio browser application.
"""

import sys
import os
import json
import base64
import urllib.request
import urllib.error

# Fix Windows stdout encoding
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

from mcp.server.mcpserver import MCPServer

DEFAULT_SERVER_URL = os.environ.get("STUDIO_SERVER_URL", "http://127.0.0.1:8080").rstrip("/")
DEFAULT_SESSION = os.environ.get("STUDIO_SESSION", "default").strip() or "default"
WORKSPACE_ROOT = os.path.realpath(os.path.dirname(os.path.abspath(__file__)))
mcp = MCPServer("hunger-studio")


def _get_studio_token() -> str:
    tok = os.environ.get("STUDIO_TOKEN", "").strip()
    if tok:
        return tok
    token_file = os.path.join(WORKSPACE_ROOT, ".studio_token")
    if os.path.isfile(token_file):
        try:
            with open(token_file, "r", encoding="utf-8") as f:
                return f.read().strip()
        except Exception:
            pass
    return ""


def _resolve_safe_save_path(save_path: str, default_name: str) -> str:
    exports_dir = os.path.realpath(os.path.join(WORKSPACE_ROOT, "exports"))
    if not save_path:
        os.makedirs(exports_dir, exist_ok=True)
        return os.path.join(exports_dir, os.path.basename(default_name))
    candidate = save_path if os.path.isabs(save_path) else os.path.join(WORKSPACE_ROOT, save_path)
    resolved = os.path.realpath(candidate)
    if resolved != WORKSPACE_ROOT and not resolved.startswith(WORKSPACE_ROOT + os.sep):
        raise ValueError(f"save_path must stay inside workspace root ({WORKSPACE_ROOT})")
    parent = os.path.dirname(resolved)
    if parent:
        os.makedirs(parent, exist_ok=True)
    return resolved


def _request(endpoint: str, data=None, method="GET") -> dict:
    url = f"{DEFAULT_SERVER_URL}{endpoint}"
    req_headers = {"Content-Type": "application/json", "User-Agent": "HungerMCP/2.0"}
    token = _get_studio_token()
    if token:
        req_headers["X-Studio-Token"] = token
    if DEFAULT_SESSION:
        req_headers["X-Studio-Session"] = DEFAULT_SESSION
    body = json.dumps(data).encode("utf-8") if data is not None else None
    if data is not None:
        method = "POST"

    req = urllib.request.Request(url, data=body, headers=req_headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        err_text = e.read().decode("utf-8")
        try:
            return json.loads(err_text)
        except Exception:
            return {"success": False, "error": f"HTTP {e.code}: {err_text}"}
    except Exception as e:
        return {"success": False, "error": f"Connection error: {e}"}

@mcp.tool()
def studio_agent_call(method: str, args: list = None) -> str:
    """Call a public window.agent method (e.g. scene.tree) with positional args.

    Returns the agent JSON {ok,data} / {ok:false,error} contract unchanged.
    The trusted agent.exec method uses the agent's isolated worker, not legacy DSL eval.
    """
    res = _request('/api/agent/call', {'method': method, 'args': [] if args is None else args})
    if not isinstance(res, dict) or not isinstance(res.get('ok'), bool):
        res = {'ok': False, 'error': {
            'code': 'E_DISABLED', 'message': 'Local agent backend is unavailable.',
            'hint': 'Run the local studio server and open the studio browser.', 'toolId': method,
        }}
    return json.dumps(res, ensure_ascii=False)


@mcp.tool()
def studio_execute_dsl(code: str) -> str:
    """
    Execute JavaScript 3D modeling code in the live Web Blender Studio browser viewport.
    Available globals:
    - studio: High-level parametric 3D DSL (studio.addCube, studio.addSphere, studio.addCylinder,
              studio.addCone, studio.addTorus, studio.addPlane, studio.addGroup, studio.addLight,
              studio.createStaircase, studio.createBuilding, studio.createTree, studio.repeatRadial,
              studio.repeatGrid, studio.animate, studio.clearScene).
    - THREE: Full Three.js namespace (math, vectors, materials, custom geometries).
    - scene: Active THREE.Scene.
    - sceneManager: Blender-style scene manager for undo/redo, selection, and outliner sync.
    - Modifiers: Window.Modifiers (Array, Mirror, Bevel, Wireframe, Subdivision).
    """
    res = _request("/api/execute", {"code": code, "timeout": 120})
    if res.get("success"):
        out = f"Successfully executed in Web Blender Studio: {res.get('message', 'OK')}"
        if res.get("result") is not None:
            out += f"\nResult: {json.dumps(res.get('result'), ensure_ascii=False)}"
        return out
    return f"Execution Error: {res.get('error')}"

@mcp.tool()
def studio_generate_3d(prompt: str) -> str:
    """
    Command the AI Copilot to reason and dynamically generate a 3D model in the Web Blender Studio
    from a natural language description (e.g., 'Thiết kế phi thuyền trinh sát không gian có động cơ phản lực').
    Supports multi-turn context (e.g., 'đổi màu cánh sang đỏ', 'thêm 2 tháp canh').
    """
    res = _request("/api/generate", {"prompt": prompt})
    if res.get("success"):
        out = f"AI Copilot Result:\n{res.get('explanation')}\n"
        if res.get("code"):
            out += f"\nGenerated Code:\n```javascript\n{res.get('code')}\n```\n"
        out += f"\nTotal scene objects: {res.get('objectsCount')}"
        return out
    return f"Generation Error: {res.get('error')}"

@mcp.tool()
def studio_get_scene() -> str:
    """
    Inspect all active 3D meshes, hierarchy, polygon/vertex counts, materials, transforms,
    and active selection in the current Web Blender Studio scene.
    """
    res = _request("/api/scene")
    if res.get("success"):
        scene = res.get("scene", {})
        objs = scene.get("objects", [])
        lines = [
            f"=== 3D Scene Overview ({scene.get('totalObjects', 0)} objects) ===",
            f"Active Object: {scene.get('activeObject') or 'None'}",
            ""
        ]
        for o in objs:
            pos = o.get("position", [0, 0, 0])
            g = o.get("geometry") or {}
            m = o.get("material") or {}
            sel = " [SELECTED]" if o.get("selected") else ""
            lines.append(f"- {o.get('name')} ({o.get('type')}){sel}: Pos={pos}, Verts={g.get('vertices', 0)}, Faces={g.get('faces', 0)}, Color={m.get('color', '-')}")
        return "\n".join(lines)
    return f"Error retrieving scene: {res.get('error')}"

@mcp.tool()
def studio_capture_viewport(save_path: str = "") -> str:
    """
    Capture a high-resolution screenshot of the current 3D viewport in Web Blender Studio.
    If save_path is provided, saves the image as PNG to disk and returns the file path.
    """
    res = _request("/api/screenshot")
    if res.get("success"):
        data_url = res.get("dataUrl", "")
        if "," in data_url:
            data_url = data_url.split(",", 1)[1]
        img_bytes = base64.b64decode(data_url)
        try:
            target_path = _resolve_safe_save_path(save_path, "viewport_capture.png")
        except ValueError as e:
            return f"Screenshot Error: {e}"
        with open(target_path, "wb") as f:
            f.write(img_bytes)
        return f"Screenshot successfully captured ({res.get('width')}x{res.get('height')}) and saved to: {target_path}"
    return f"Screenshot Error: {res.get('error')}"

@mcp.tool()
def studio_export_model(format: str = "glb", save_path: str = "") -> str:
    """
    Export the 3D scene in glTF 2.0 Binary (.glb), glTF (.gltf), Wavefront OBJ (.obj), STL (.stl for 3D printing), Stanford PLY (.ply), or JSON project (.json) format.
    If save_path is provided, saves the file to disk.
    """
    fmt = format.lower()
    valid_formats = ["glb", "gltf", "obj", "stl", "ply", "json"]
    if fmt not in valid_formats:
        fmt = "glb"
    try:
        target_path = _resolve_safe_save_path(save_path, f"model_export.{fmt}")
    except ValueError as e:
        return f"Export Error: {e}"
    res = _request("/api/export", {"format": fmt})
    if res.get("success"):
        content = res.get("content", "")
        if res.get("isBase64"):
            data = base64.b64decode(content)
            with open(target_path, "wb") as f:
                f.write(data)
            size_kb = len(data) / 1024
        else:
            with open(target_path, "w", encoding="utf-8") as f:
                f.write(content)
            size_kb = len(content.encode("utf-8")) / 1024
        return f"Successfully exported {fmt.upper()} model ({size_kb:.1f} KB) to: {target_path}"
    return f"Export Error: {res.get('error')}"

@mcp.tool()
def studio_select_object(name: str) -> str:
    """
    Select a specific 3D object by its name or ID in the Web Blender Studio viewport.
    """
    res = _request("/api/select", {"name": name})
    if res.get("success"):
        return f"Object '{res.get('selected')}' is now selected in 3D viewport."
    return f"Select Error: {res.get('error')}"

@mcp.tool()
def studio_clear_scene() -> str:
    """
    Clear all objects and reset the 3D scene in Web Blender Studio.
    """
    res = _request("/api/clear", {})
    if res.get("success"):
        return "Web Blender Studio 3D scene has been cleared."
    return f"Clear Error: {res.get('error')}"

def main():
    mcp.run("stdio")

if __name__ == "__main__":
    main()
