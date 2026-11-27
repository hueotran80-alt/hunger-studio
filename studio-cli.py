#!/usr/bin/env python3
"""
Web Blender Studio - Command Line Interface (CLI)
File: studio-cli.py

Allows humans, shell scripts, and AI agents to directly control the live
Web Blender Studio 3D environment from the terminal.

Usage:
    python studio-cli.py exec "studio.addCube({ x: 0, y: 1, z: 0, color: 0x3498db })"
    python studio-cli.py generate "Tạo một phi thuyền thám hiểm không gian với động cơ phản lực neon xanh"
    python studio-cli.py scene
    python studio-cli.py screenshot --out render.png
    python studio-cli.py export --format obj --out model.obj
    python studio-cli.py select "Cube"
    python studio-cli.py clear
    python studio-cli.py status
"""

import sys
import os
import json
import base64
import argparse
import urllib.request
import urllib.error

# Fix Windows stdout encoding
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

DEFAULT_SERVER_URL = os.environ.get("STUDIO_SERVER_URL", "http://127.0.0.1:8080").rstrip("/")
DEFAULT_SESSION = os.environ.get("STUDIO_SESSION", "default").strip() or "default"
WORKSPACE_ROOT = os.path.realpath(os.path.dirname(os.path.abspath(__file__)))


def _resolve_token(cli_token=""):
    tok = str(cli_token or os.environ.get("STUDIO_TOKEN") or "").strip()
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


def make_request(endpoint, data=None, method="GET", server_url=DEFAULT_SERVER_URL, token="", session=DEFAULT_SESSION):
    url = f"{server_url.rstrip('/')}{endpoint}"
    req_headers = {"Content-Type": "application/json", "User-Agent": "HungerCLI/2.0"}
    resolved_tok = _resolve_token(token)
    if resolved_tok:
        req_headers["X-Studio-Token"] = resolved_tok
    if session:
        req_headers["X-Studio-Session"] = session

    body = None
    if data is not None:
        body = json.dumps(data).encode("utf-8")
        method = "POST"

    req = urllib.request.Request(url, data=body, headers=req_headers, method=method)

    try:
        with urllib.request.urlopen(req, timeout=120) as response:
            res_body = response.read().decode("utf-8")
            return json.loads(res_body)
    except urllib.error.HTTPError as e:
        err_body = e.read().decode("utf-8")
        try:
            return json.loads(err_body)
        except Exception:
            return {"success": False, "error": f"HTTP {e.code}: {err_body}"}
    except urllib.error.URLError as e:
        return {"success": False, "error": f"Could not connect to Hunger Studio at {server_url}. ({e.reason})"}
    except Exception as e:
        return {"success": False, "error": str(e)}

def cmd_status(args):
    res = make_request("/api/status", server_url=args.server, token=args.token, session=args.session)
    if res.get("success"):
        print("=" * 60)
        print("🟢 Hunger 3D Studio Server: ONLINE")
        print(f"👉 Server URL:         {args.server}")
        if res.get("wsPath"):
            print(f"👉 Bridge WebSocket:   {args.server.replace('http', 'ws', 1)}{res.get('wsPath')} (session={args.session})")
            print(f"👉 Remote MCP URL:     {args.server}{res.get('mcpEndpoint', '/mcp')}")
        else:
            print(f"👉 Bridge WebSocket:   ws://127.0.0.1:{res.get('wsPort', 8082)}")
        print(f"👉 Connected Browsers: {res.get('connectedBrowsers', 0)}")
        print(f"👉 Active AI Provider: {res.get('provider', 'offline')}")
        print("=" * 60)
        if res.get("connectedBrowsers", 0) == 0:
            print("⚠️ Note: No active browser window currently connected to this session.")
            print(f"Open {args.server} in your browser and check the CLI/MCP badge.")
    else:
        print(f"❌ Error: {res.get('error')}")

def cmd_exec(args):
    code = args.code
    if os.path.isfile(code):
        with open(code, "r", encoding="utf-8") as f:
            code = f.read()

    print("🚀 Executing DSL script in Hunger 3D Studio...")
    res = make_request("/api/execute", {"code": code, "timeout": 120}, server_url=args.server, token=args.token, session=args.session)
    if res.get("success"):
        print("✅ Execution Succeeded!")
        if res.get("message"):
            print(f"   {res.get('message')}")
        if res.get("result") is not None:
            print(f"📦 Result: {json.dumps(res.get('result'), ensure_ascii=False)}")
    else:
        print(f"❌ Execution Failed: {res.get('error')}")

def cmd_agent(args):
    parsed_args = []
    if args.args:
        parsed_args = json.loads(args.args)
        if not isinstance(parsed_args, list):
            parsed_args = [parsed_args]
    res = make_request("/api/agent/call", {"method": args.method, "args": parsed_args}, server_url=args.server, token=args.token, session=args.session)
    print(json.dumps(res, indent=2, ensure_ascii=False))

def cmd_generate(args):
    prompt = args.prompt
    print(f"🤖 Sending prompt to AI Copilot: \"{prompt}\"...")
    res = make_request("/api/generate", {"prompt": prompt}, server_url=args.server, token=args.token, session=args.session)
    if res.get("success"):
        print("✅ 3D Generation Complete!")
        print(f"\n💬 {res.get('explanation')}\n")
        if res.get("code"):
            print("--- Generated 3D Code ---")
            print(res.get("code"))
            print("-------------------------")
        print(f"📊 Total objects in 3D scene: {res.get('objectsCount', 'N/A')}")
    else:
        print(f"❌ Generation Failed: {res.get('error')}")

def cmd_scene(args):
    res = make_request("/api/scene", server_url=args.server, token=args.token, session=args.session)
    if res.get("success"):
        scene = res.get("scene", {})
        objs = scene.get("objects", [])
        print("=" * 75)
        print(f"🏛️ 3D SCENE OUTLINER ({scene.get('totalObjects', 0)} total objects)")
        print(f"⭐ Active Selection: {scene.get('activeObject') or 'None'}")
        print("-" * 75)
        print(f"{'NAME':<24} {'TYPE':<12} {'VERTICES':<10} {'FACES':<10} {'COLOR':<10} {'SELECTED'}")
        print("-" * 75)
        for obj in objs:
            name = obj.get("name", "Unnamed")[:23]
            o_type = obj.get("type", "Mesh")
            geom = obj.get("geometry") or {}
            verts = str(geom.get("vertices", 0))
            faces = str(geom.get("faces", 0))
            mat = obj.get("material") or {}
            col = mat.get("color") or "-"
            sel = "★ YES" if obj.get("selected") else "  No"
            print(f"{name:<24} {o_type:<12} {verts:<10} {faces:<10} {col:<10} {sel}")
        print("=" * 75)
    else:
        print(f"❌ Error getting scene: {res.get('error')}")

def cmd_screenshot(args):
    out_path = args.out or "viewport_screenshot.png"
    print("📸 Capturing viewport screenshot...")
    res = make_request("/api/screenshot", server_url=args.server, token=args.token, session=args.session)
    if res.get("success"):
        data_url = res.get("dataUrl", "")
        if "," in data_url:
            data_url = data_url.split(",", 1)[1]
        img_bytes = base64.b64decode(data_url)
        with open(out_path, "wb") as f:
            f.write(img_bytes)
        print(f"✅ Viewport screenshot saved ({res.get('width', 0)}x{res.get('height', 0)}) -> {out_path}")
    else:
        print(f"❌ Screenshot failed: {res.get('error')}")

def cmd_export(args):
    fmt = args.format.lower()
    out_path = args.out or f"exported_model.{fmt}"
    print(f"📦 Exporting scene as {fmt.upper()}...")
    res = make_request("/api/export", {"format": fmt}, server_url=args.server, token=args.token, session=args.session)
    if res.get("success"):
        content = res.get("content", "")
        if res.get("isBase64"):
            data = base64.b64decode(content)
            with open(out_path, "wb") as f:
                f.write(data)
            size_kb = len(data) / 1024
        else:
            with open(out_path, "w", encoding="utf-8") as f:
                f.write(content)
            size_kb = len(content.encode("utf-8")) / 1024
        print(f"✅ Exported {fmt.upper()} model ({size_kb:.1f} KB) -> {out_path}")
    else:
        print(f"❌ Export failed: {res.get('error')}")

def cmd_select(args):
    name = args.name
    res = make_request("/api/select", {"name": name}, server_url=args.server, token=args.token, session=args.session)
    if res.get("success"):
        print(f"✅ Selected object: '{res.get('selected')}'")
    else:
        print(f"❌ Failed to select: {res.get('error')}")

def cmd_clear(args):
    res = make_request("/api/clear", {}, server_url=args.server, token=args.token, session=args.session)
    if res.get("success"):
        print("🧹 3D Scene cleared successfully.")
    else:
        print(f"❌ Failed to clear: {res.get('error')}")

def cmd_config(args):
    cfg_update = {}
    if args.gemini_key:
        cfg_update["geminiKey"] = args.gemini_key
    if args.openai_key:
        cfg_update["openAiKey"] = args.openai_key
    if args.provider:
        cfg_update["provider"] = args.provider

    if cfg_update:
        res = make_request("/api/config", cfg_update, server_url=args.server, token=args.token, session=args.session)
        print("✅ Config updated:", res.get("config"))
    else:
        res = make_request("/api/config", server_url=args.server, token=args.token, session=args.session)
        print("ℹ️ Current Config:", res)

def cmd_import_blend(args):
    src = args.file
    if not os.path.isfile(src):
        print(f"❌ File not found: {src}")
        sys.exit(1)
    with open(src, "rb") as f:
        raw = f.read()
    out_path = args.out or (os.path.splitext(src)[0] + ".glb")
    if args.local:
        import blend_converter
        res = blend_converter.convert_blend_bytes_to_glb(raw, apply_modifiers=args.apply_modifiers)
        with open(out_path, "wb") as f:
            f.write(res["glbBytes"])
        print(f"✅ Converted {src} -> {out_path} ({len(res['glbBytes']) / 1024:.1f} KB)")
        print("📋 Report:", json.dumps(res.get("report") or {}, ensure_ascii=False))
        return
    res = make_request("/api/import/blend", {
        "fileName": os.path.basename(src),
        "fileData": base64.b64encode(raw).decode("ascii"),
        "applyModifiers": bool(args.apply_modifiers),
    }, server_url=args.server)
    if not res.get("success"):
        print(f"❌ Conversion failed ({res.get('code', 'ERROR')}): {res.get('error')}")
        if res.get("hint"):
            print(f"💡 Hint: {res['hint']}")
        sys.exit(1)
    glb_bytes = base64.b64decode(res["glbBase64"])
    with open(out_path, "wb") as f:
        f.write(glb_bytes)
    print(f"✅ Converted {src} -> {out_path} ({len(glb_bytes) / 1024:.1f} KB) via {res.get('blenderVersion')}")
    if res.get("report"):
        print("📋 Report:", json.dumps(res["report"], ensure_ascii=False))

def main():
    parser = argparse.ArgumentParser(description="Hunger 3D Studio CLI Controller")
    parser.add_argument("--server", default=DEFAULT_SERVER_URL, help=f"Studio Server URL (default: {DEFAULT_SERVER_URL})")
    parser.add_argument("--token", default="", help="Bridge token (defaults to STUDIO_TOKEN env or .studio_token)")
    parser.add_argument("--session", default=DEFAULT_SESSION, help=f"Bridge session ID (default: {DEFAULT_SESSION})")

    subparsers = parser.add_subparsers(dest="command", help="Command to execute")

    # status
    p_status = subparsers.add_parser("status", help="Check Studio and bridge connectivity")
    p_status.set_defaults(func=cmd_status)

    # agent
    p_agent = subparsers.add_parser("agent", help="Call a public window.agent method (e.g. scene.tree)")
    p_agent.add_argument("method", help="Dotted agent method name")
    p_agent.add_argument("--args", default="[]", help="JSON array of positional arguments")
    p_agent.set_defaults(func=cmd_agent)

    # exec
    p_exec = subparsers.add_parser("exec", help="Execute 3D DSL script in browser")
    p_exec.add_argument("code", help="JavaScript code snippet or path to .js file")
    p_exec.set_defaults(func=cmd_exec)

    # generate
    p_gen = subparsers.add_parser("generate", help="Prompt AI Copilot to generate 3D model")
    p_gen.add_argument("prompt", help="Natural language prompt")
    p_gen.set_defaults(func=cmd_generate)

    # scene
    p_scene = subparsers.add_parser("scene", help="Inspect objects in 3D scene")
    p_scene.set_defaults(func=cmd_scene)

    # screenshot
    p_shot = subparsers.add_parser("screenshot", help="Capture high-res viewport screenshot")
    p_shot.add_argument("--out", "-o", default="viewport.png", help="Output file path (default: viewport.png)")
    p_shot.set_defaults(func=cmd_screenshot)

    # export
    p_exp = subparsers.add_parser("export", help="Export scene as GLB, GLTF, OBJ, STL, PLY, or JSON")
    p_exp.add_argument("--format", "-f", default="glb", choices=["glb", "gltf", "obj", "stl", "ply", "json"], help="Export format")
    p_exp.add_argument("--out", "-o", help="Output file path")
    p_exp.set_defaults(func=cmd_export)

    # select
    p_sel = subparsers.add_parser("select", help="Select object in scene by name or id")
    p_sel.add_argument("name", help="Object name or id")
    p_sel.set_defaults(func=cmd_select)

    # clear
    p_clr = subparsers.add_parser("clear", help="Clear current 3D scene")
    p_clr.set_defaults(func=cmd_clear)

    # config
    p_cfg = subparsers.add_parser("config", help="Query or update Gemini/OpenAI API keys")
    p_cfg.add_argument("--gemini-key", help="Gemini API Key")
    p_cfg.add_argument("--openai-key", help="OpenAI API Key")
    p_cfg.add_argument("--provider", choices=["gemini", "openai", "offline"], help="Default AI Provider")
    p_cfg.set_defaults(func=cmd_config)

    # import-blend
    p_blend = subparsers.add_parser("import-blend", help="Convert a .blend file to .glb via headless Blender")
    p_blend.add_argument("file", help="Path to .blend file")
    p_blend.add_argument("--out", "-o", help="Output .glb file path")
    p_blend.add_argument("--apply-modifiers", action="store_true", help="Apply Blender modifiers on export")
    p_blend.add_argument("--local", action="store_true", help="Run local Blender directly without server.py")
    p_blend.set_defaults(func=cmd_import_blend)

    args = parser.parse_args()
    if hasattr(args, "func"):
        args.func(args)
    else:
        parser.print_help()

if __name__ == "__main__":
    main()
