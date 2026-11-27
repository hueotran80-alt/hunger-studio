"""Shared harness: import server.py with light stubs and serve it on a random port."""
import importlib.util
import json
import os
import socket
import sys
import tempfile
import threading
import types
from http.client import HTTPConnection
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]

FAKE_GEMINI = "AIzaFAKE-gemini-key-0123456789abcdef"
FAKE_OPENAI = "sk-FAKE-openai-key-0123456789abcdef"
FAKE_CUSTOM = "sk-FAKE-motapis-key-0123456789abcdef"
FAKE_HF = "hf_FAKEhuggingfacetoken0123456789abcdef"


def load_server():
    """Import server.py with websockets/mocap/hunyuan stubbed out."""
    websockets_stub = types.ModuleType("websockets")
    websockets_stub.serve = lambda *a, **k: None
    mocap_stub = types.ModuleType("mocap_engine")
    mocap_stub.MEDIAPIPE_AVAILABLE = False
    mocap_stub.mocap_engine = None
    hunyuan_stub = types.ModuleType("hunyuan3d_engine")
    hunyuan_stub.hunyuan_engine = None

    with patch.dict(sys.modules, {
        "websockets": websockets_stub,
        "mocap_engine": mocap_stub,
        "hunyuan3d_engine": hunyuan_stub,
    }):
        spec = importlib.util.spec_from_file_location("studio_server_under_test", ROOT / "server.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    return module


class QuietHandlerMixin:
    def log_message(self, *args):
        pass


def make_server(server_module, directory=None, handler_extra=None):
    """Start a threaded server on 127.0.0.1:0 and return (httpd, thread, host)."""
    base = handler_extra or server_module.BlenderStudioHTTPRequestHandler

    if directory is None:
        handler_cls = type("QuietHandler", (QuietHandlerMixin, base), {})
    else:
        class QuietDirectoryHandler(QuietHandlerMixin, base):
            def __init__(self, *args, **kwargs):
                kwargs["directory"] = directory
                super().__init__(*args, **kwargs)
        handler_cls = QuietDirectoryHandler

    httpd = server_module.ThreadingHTTPServer(("127.0.0.1", 0), handler_cls)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    return httpd, thread, f"127.0.0.1:{httpd.server_port}"


def request(host, method, path, body=None, headers=None, raw_body=None):
    """Minimal HTTP helper returning (status, headers-dict, parsed-or-raw body)."""
    conn = HTTPConnection(host, timeout=15)
    payload = None
    hdrs = {"Content-Type": "application/json"} if body is not None else {}
    if body is not None:
        payload = json.dumps(body).encode("utf-8")
    if raw_body is not None:
        payload = raw_body
        hdrs = {"Content-Type": "application/json"}
    if headers:
        hdrs.update(headers)
    try:
        conn.request(method, path, body=payload, headers=hdrs)
        resp = conn.getresponse()
        data = resp.read()
        parsed = None
        if data:
            try:
                parsed = json.loads(data)
            except ValueError:
                parsed = data
        return resp.status, dict(resp.getheaders()), parsed
    finally:
        conn.close()


def wait_for_port(host, port, timeout=5.0):
    import time
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with socket.create_connection((host, port), timeout=0.2):
                return True
        except OSError:
            time.sleep(0.05)
    return False
