#!/usr/bin/env python3
"""
Web Blender Studio - Dual HTTP Static & Live CLI/MCP Bridge Server
File: server.py

Features:
- Threaded HTTP server on port 8080 serving 3D assets with accurate MIME types & CORS
- Real-time WebSocket server on port 8082 connecting the live browser studio
- REST API endpoints for CLI, MCP, and AI agents:
    * POST /api/execute     - Execute Three.js / studio.* DSL code in browser
    * POST /api/generate    - Ask AI Copilot to generate 3D model
    * GET  /api/scene       - Retrieve live 3D objects hierarchy, vertices, faces
    * GET  /api/screenshot  - Capture live viewport PNG screenshot
    * POST /api/export      - Export scene as OBJ, STL, or JSON
    * POST /api/select      - Select object by name/id
    * POST /api/clear       - Clear current 3D scene
    * GET  /api/status      - Check connected studio status
    * GET/POST /api/config  - Query or update Gemini/OpenAI API keys
"""

import sys
import os
import stat as _stat
import errno
import time
import json
import gzip
import shutil
import socket
import threading
import concurrent.futures
import asyncio
import uuid
import base64
import binascii
import ipaddress
import re
import ssl
import math
import hmac
import hashlib
import secrets
import posixpath
import traceback
from collections import OrderedDict, deque
from functools import partial
from http import HTTPStatus
from http.client import HTTPConnection
from urllib.parse import urlsplit, urljoin, parse_qs, quote, unquote
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# Fix Windows stdout encoding
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")


def _safe_log(*args, err=False):
    """Best-effort logging that never aborts HTTP/WS handlers if stdout/stderr PTY breaks."""
    stream = sys.stderr if err else sys.stdout
    if stream is None:
        return
    try:
        print(*args, file=stream, flush=True)
    except (OSError, ValueError):
        pass


def _safe_traceback():
    try:
        traceback.print_exc()
    except (OSError, ValueError):
        pass

try:
    import websockets
except ImportError:
    print(
        "[Server] Missing dependency: websockets\n"
        "         Install with:  pip install -r requirements.txt\n"
        "         (or)          python3 -m venv .venv && .venv/bin/pip install -r requirements.txt",
        file=sys.stderr,
        flush=True,
    )
    sys.exit(1)

mocap_engine = None

_TELEMETRY_LOCK = threading.Lock()
_TELEMETRY_EVENTS = deque(maxlen=500)
_FEEDBACK_ITEMS = deque(maxlen=500)
_FEEDBACK_SEQ = 0
_TELEMETRY_SYNTHETIC_RE = re.compile(r'^(?:sentry-smoke|smoke-|ci-smoke|test-smoke)', re.IGNORECASE)
_FEEDBACK_CATEGORIES = frozenset(('bug', 'mocap', 'export', 'performance', 'feature', 'other'))
_PII_EMAIL_RE = re.compile(r'[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}')
_PII_TOKEN_RE = re.compile(r'(?:Bearer\s+|eyJ)[A-Za-z0-9._-]{12,}', re.IGNORECASE)
_PII_PATH_RE = re.compile(r'(?:/Users/[^/\s]+|/home/[^/\s]+|[A-Za-z]:\\Users\\[^\\\s]+)')


def _sanitize_feedback_text(raw, max_len=1500):
    text = str(raw or '').strip()
    text = _PII_EMAIL_RE.sub('[redacted-email]', text)
    text = _PII_TOKEN_RE.sub('[redacted-token]', text)
    text = _PII_PATH_RE.sub('[redacted-path]', text)
    return text[:max_len]


def _record_feedback_item(payload, user_agent=''):
    global _FEEDBACK_SEQ
    if not isinstance(payload, dict):
        return None
    message = _sanitize_feedback_text(payload.get('message', ''), 1500)
    if len(message) < 3:
        return None
    category = str(payload.get('category') or 'bug').strip().lower()
    if category not in _FEEDBACK_CATEGORIES:
        category = 'other'
    raw_rating = payload.get('rating')
    rating = None
    if raw_rating is not None and raw_rating != '':
        try:
            r = int(raw_rating)
            if 1 <= r <= 5:
                rating = r
        except (TypeError, ValueError):
            rating = None
    with _TELEMETRY_LOCK:
        _FEEDBACK_SEQ += 1
        item = {
            'id': _FEEDBACK_SEQ,
            'ts': str(payload.get('ts') or time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()))[:40],
            'sessionId': str(payload.get('sessionId') or '')[:64],
            'release': str(payload.get('release') or 'hunger-motion@0.9.0-beta.2')[:64],
            'environment': 'development',
            'workspace': str(payload.get('workspace') or 'unknown')[:32],
            'templateId': str(payload.get('templateId') or '')[:48] or None,
            'category': category,
            'rating': rating,
            'message': message,
            'userAgent': str(user_agent or '')[:180],
        }
        _FEEDBACK_ITEMS.append(item)
        return item


def _list_feedback_items(limit=50, category=''):
    cat = str(category or '').strip().lower()
    with _TELEMETRY_LOCK:
        items = list(_FEEDBACK_ITEMS)
    if cat:
        items = [it for it in items if it.get('category') == cat]
    items.reverse()
    items = items[:max(1, min(200, int(limit or 50)))]
    return {
        'ok': True,
        'storage': 'dev-memory',
        'count': len(items),
        'items': items,
    }


def _check_telemetry_admin_header(headers):
    import hmac
    expected = (os.environ.get('TELEMETRY_ADMIN_TOKEN') or '').strip()
    if not expected:
        return True
    provided = (headers.get('X-Telemetry-Admin-Token') or '').strip()
    if not provided:
        auth = (headers.get('Authorization') or '').strip()
        if auth.lower().startswith('bearer '):
            provided = auth[7:].strip()
    return bool(provided) and hmac.compare_digest(provided, expected)


def _record_telemetry_events(events, batch_session_id=''):
    if not isinstance(events, list):
        return 0
    accepted = 0
    with _TELEMETRY_LOCK:
        for ev in events[:25]:
            if not isinstance(ev, dict):
                continue
            kind = 'error' if ev.get('kind') == 'error' else 'analytics'
            sid = str(ev.get('sessionId') or batch_session_id or '')[:64]
            props = ev.get('props') if isinstance(ev.get('props'), dict) else {}
            is_synth = bool(_TELEMETRY_SYNTHETIC_RE.match(sid) or props.get('synthetic') is True)
            _TELEMETRY_EVENTS.append({
                'kind': kind,
                'name': str(ev.get('name') or ('error_captured' if kind == 'error' else 'unknown'))[:64],
                'ts': str(ev.get('ts') or '')[:40],
                'sessionId': sid,
                'release': str(ev.get('release') or 'hunger-motion@0.9.0-beta.2')[:64],
                'workspace': str(ev.get('workspace') or 'unknown')[:32],
                'fatal': bool((ev.get('sentry') or {}).get('level') == 'fatal') if kind == 'error' else False,
                'isSynthetic': is_synth,
                'props': props,
            })
            accepted += 1
    return accepted


def _telemetry_summary():
    with _TELEMETRY_LOCK:
        rows = [r for r in _TELEMETRY_EVENTS if not r.get('isSynthetic')]
        fb_count = len(_FEEDBACK_ITEMS)
    sessions = set()
    crashed = set()
    fatal_errors = 0
    errors = 0
    v2g_attempts = 0
    v2g_ok = 0
    interactive = []
    ttfa = []
    funnel = {
        'landingVisits': 0, 'motionSessions': 0, 'templateSelections': 0,
        'firstAnimations': 0, 'glbExportsOk': 0, 'glbExportsFailed': 0,
        'authSignIns': 0, 'oauthStarts': 0, 'passwordResets': 0,
        'checkoutsStarted': 0, 'paymentsCompleted': 0,
    }
    motion_sessions = set()
    for r in rows:
        sid = r['sessionId']
        props = r['props']
        if r['kind'] == 'error':
            errors += 1
            if r['fatal']:
                fatal_errors += 1
                if sid:
                    crashed.add(sid)
            continue
        name = r['name']
        if name == 'session_interactive':
            if sid:
                sessions.add(sid)
                if r['workspace'] == 'motion':
                    motion_sessions.add(sid)
            ms = props.get('initialInteractiveMs')
            if isinstance(ms, (int, float)) and 0 <= ms < 120000:
                interactive.append(float(ms))
        elif name == 'session_end':
            if sid:
                sessions.add(sid)
            if props.get('crashFree') is False and sid:
                crashed.add(sid)
        elif name in ('landing_view', 'motion_landing_view'):
            funnel['landingVisits'] += 1
        elif name == 'template_selected':
            funnel['templateSelections'] += 1
        elif name == 'first_animation_achieved':
            funnel['firstAnimations'] += 1
            sec = props.get('timeToFirstAnimationSec')
            if isinstance(sec, (int, float)) and 0 <= sec < 86400:
                ttfa.append(float(sec))
        elif name == 'mocap_export_glb':
            v2g_attempts += 1
            if props.get('ok') is True:
                v2g_ok += 1
                funnel['glbExportsOk'] += 1
            else:
                funnel['glbExportsFailed'] += 1
        elif name == 'auth_signed_in':
            funnel['authSignIns'] += 1
        elif name == 'auth_oauth_started':
            funnel['oauthStarts'] += 1
        elif name == 'auth_password_reset_requested':
            funnel['passwordResets'] += 1
        elif name == 'checkout_started':
            funnel['checkoutsStarted'] += 1
        elif name == 'payment_completed':
            funnel['paymentsCompleted'] += 1

    funnel['motionSessions'] = len(motion_sessions)
    interactive.sort()
    ttfa.sort()
    med = lambda arr: None if not arr else (round(arr[len(arr) // 2], 2) if len(arr) % 2 else round((arr[len(arr) // 2 - 1] + arr[len(arr) // 2]) / 2, 2))
    sess_count = len(sessions)
    crashed_count = len(crashed & sessions) if sessions else len(crashed)
    crash_free = round(max(0, sess_count - crashed_count) / sess_count * 100, 2) if sess_count else 100.0
    v2g_pct = round(v2g_ok / v2g_attempts * 100, 2) if v2g_attempts else None
    return {
        "ok": True,
        "storage": "dev-memory",
        "environment": "development",
        "sentryConfigured": bool(os.environ.get("SENTRY_DSN")),
        "feedbackCount": fb_count,
        "kpi": {
            "sessions": sess_count,
            "crashedSessions": crashed_count,
            "crashFreePct": crash_free,
            "fatalErrors": fatal_errors,
            "errors": errors,
            "videoToGlbAttempts": v2g_attempts,
            "videoToGlbSuccesses": v2g_ok,
            "videoToGlbSuccessPct": v2g_pct,
            "medianInteractiveMs": med(interactive),
            "medianTimeToFirstAnimationSec": med(ttfa),
        },
        "funnel": {**funnel, "feedbackSubmitted": fb_count},
    }
mocap_engine_error = None
_mocap_load_attempted = False


def ensure_mocap_engine():
    """Nạp MediaPipe/mocap_engine ở lần dùng đầu tiên thay vì lúc khởi động.

    Import này tốn ~2 s (MediaPipe + model ~29 MB) nên trì hoãn giúp server
    lên ngay; endpoint /api/mocap/* vẫn hoạt động y như trước.
    """
    global mocap_engine, mocap_engine_error, _mocap_load_attempted
    if _mocap_load_attempted:
        return mocap_engine
    _mocap_load_attempted = True
    try:
        import mocap_engine as _module
        mocap_engine = _module
    except Exception as e:
        mocap_engine = None
        mocap_engine_error = str(e)
        print(
            "[Server] Warning: mocap_engine not loaded: "
            f"{e}\n"
            "         Mocap tracking needs Python 3.11 with mediapipe + opencv:\n"
            "         python3.11 -m venv .venv && .venv/bin/pip install mediapipe opencv-python-headless\n"
            "         then restart with: .venv/bin/python server.py",
            file=sys.stderr,
            flush=True,
        )
    return mocap_engine

hunyuan_engine_error = None
try:
    import hunyuan3d_engine
except Exception as e:
    hunyuan3d_engine = None
    hunyuan_engine_error = str(e)
    print(f"[Server] Warning: hunyuan3d_engine not loaded: {e}", flush=True)

try:
    import blend_converter
except Exception as e:
    blend_converter = None
    print(f"[Server] Warning: blend_converter not loaded: {e}", flush=True)

cloud_error = None
try:
    from cloud.config import load_cloud_config
    from cloud.errors import CloudError
    from cloud.service import CloudService
    CLOUD = CloudService(load_cloud_config())
    if CLOUD.init_error:
        print(f"[Cloud] Warning: {CLOUD.init_error}", flush=True)
    elif CLOUD.config.enabled:
        print(f"[Cloud] Provider: {CLOUD.config.provider} · storage {CLOUD.config.storage}", flush=True)
except Exception as e:
    CLOUD = None
    class CloudError(Exception):
        status = 500
        def to_dict(self):
            return {"success": False, "error": {"code": "E_CLOUD_DISABLED", "message": str(self)}}
    cloud_error = str(e)
    print(f"[Cloud] Warning: cloud layer not loaded: {e}", flush=True)

# =============================================================================
# PATHS, LIMITS & HARDENING CONSTANTS
# =============================================================================

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
MODELS_DIR = os.path.join(SCRIPT_DIR, "models")

# JSON endpoints stay small; uploads are base64 so the body is ~4/3 of the file.
MAX_JSON_BODY_BYTES = int(os.environ.get("STUDIO_MAX_JSON_BYTES", 2 * 1024 * 1024))
MAX_UPLOAD_BYTES = int(os.environ.get("STUDIO_MAX_UPLOAD_BYTES", 50 * 1024 * 1024))
MAX_UPLOAD_BODY_BYTES = 4 * ((MAX_UPLOAD_BYTES + 2) // 3) + 8192

MOCAP_VIDEO_EXTENSIONS = frozenset(('.mp4', '.webm', '.mov', '.mkv', '.m4v', '.avi'))
HUNYUAN_IMAGE_EXTENSIONS = frozenset(('.png', '.jpg', '.jpeg', '.webp', '.bmp'))
MOCAP_UPLOAD_TTL_SECONDS = max(60, int(os.environ.get("STUDIO_MOCAP_UPLOAD_TTL_SEC", "3600")))


def _cleanup_old_mocap_uploads(models_dir, ttl_seconds=None, now=None):
    """Delete expired temporary `uploaded_mocap_*` files inside `models_dir`."""
    ttl = MOCAP_UPLOAD_TTL_SECONDS if ttl_seconds is None else max(0, float(ttl_seconds))
    if not models_dir or not os.path.isdir(models_dir) or os.path.islink(models_dir):
        return 0
    cutoff = (time.time() if now is None else float(now)) - ttl
    removed = 0
    try:
        for entry in os.scandir(models_dir):
            if not entry.name.startswith("uploaded_mocap_"):
                continue
            try:
                if entry.is_symlink() or not entry.is_file(follow_symlinks=False):
                    continue
                if entry.stat(follow_symlinks=False).st_mtime < cutoff:
                    os.unlink(entry.path)
                    removed += 1
            except OSError:
                continue
    except OSError:
        return removed
    return removed

# Script-capable documents must never be served from user-controlled asset folders.
BLOCKED_ASSET_EXTENSIONS = frozenset((
    '.html', '.htm', '.xhtml', '.svg', '.js', '.mjs', '.xml', '.xsl', '.xslx',
    '.php', '.phtml', '.py', '.sh', '.bat', '.cmd', '.ps1',
))
PROTECTED_ASSET_PREFIXES = ('/models/', '/agent_assets/', '/uploads/')
SENSITIVE_TOP_DIRS = ('/cloud_data', '/cloud', '/supabase', '/scripts', '/crates', '/audit', '/temp', '/tmp')
SENSITIVE_EXACT_PATHS = frozenset((
    '/ai_config.json', '/cloud_config.json', '/cloud_config.example.json',
    '/server.py', '/mocap_engine.py', '/hunyuan3d_engine.py', '/blend_converter.py',
    '/studio_mcp.py', '/studio-cli.py', '/package.json', '/package-lock.json',
    '/vite.config.js', '/cargo.toml', '/cargo.lock',
    '/dockerfile', '/requirements.txt', '/agents.md', '/roadmap_web_saas.md', '/audit.md',
))
SENSITIVE_EXTENSIONS = frozenset((
    '.py', '.pyc', '.pyo', '.sqlite', '.sqlite3', '.db', '.db-wal', '.db-shm',
    '.env', '.pem', '.key', '.rs', '.toml', '.lock',
))

# Empty token = loopback-only trust (bind 127.0.0.1). Any non-loopback bind
# refuses to start without a token; see run_server().
STUDIO_TOKEN = (os.environ.get("STUDIO_TOKEN") or "").strip()
BIND_HOST = os.environ.get("STUDIO_HOST", "127.0.0.1").strip() or "127.0.0.1"
_ACTIVE_HTTP_PORTS = {8080}


def _env_csv_set(name):
    raw = os.environ.get(name, "") or ""
    return frozenset(part.strip().lower() for part in raw.split(",") if part.strip())

AI_PROVIDER_ENDPOINTS = {
    'openai': 'https://api.openai.com/v1',
    'gemini': 'https://generativelanguage.googleapis.com/v1beta/openai',
}
AI_FORBIDDEN_HOSTS = frozenset((
    '169.254.169.254', 'metadata.google.internal', 'metadata.goog', '100.100.100.200',
))


# Custom MIME types mapping
CUSTOM_MIME_TYPES = {
    '.js': 'application/javascript; charset=utf-8',
    '.mjs': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.htm': 'text/html; charset=utf-8',
    '.obj': 'text/plain; charset=utf-8',
    '.mtl': 'text/plain; charset=utf-8',
    '.stl': 'model/stl',
    '.gltf': 'model/gltf+json',
    '.glb': 'model/gltf-binary',
    '.bin': 'application/octet-stream',
    '.wasm': 'application/wasm',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
    '.hdr': 'image/vnd.radiance',
    '.blend.json': 'application/json; charset=utf-8',
    '.web3d': 'application/json; charset=utf-8',
}

# =============================================================================
# BRIDGE STATE & WEBSOCKET HUB (PORT 8082)
# =============================================================================

class StudioBridgeHub:
    def __init__(self):
        # Ordered: the last registered client is the active studio tab.
        self.connected_clients = []
        self._clients_lock = threading.Lock()
        self.pending_futures = {}
        self.loop = None
        self._config_lock = threading.RLock()
        self._config_file_stat = None
        self.config_file = os.path.join(BASE_DIR, "ai_config.json")
        self.config = {
            "geminiKey": os.environ.get("GEMINI_API_KEY", ""),
            "geminiModel": os.environ.get("GEMINI_MODEL", "gemini-3.5-flash-lite"),
            "openAiKey": os.environ.get("OPENAI_API_KEY", ""),
            "openAiModel": os.environ.get("OPENAI_MODEL", "gpt-4o-mini"),
            "customKey": os.environ.get("MOTAPIS_API_KEY", os.environ.get("CUSTOM_API_KEY", "")),
            "customEndpoint": os.environ.get("MOTAPIS_ENDPOINT", os.environ.get("CUSTOM_API_ENDPOINT", "https://motapis.com/v1")),
            "customModel": os.environ.get("MOTAPIS_MODEL", os.environ.get("CUSTOM_MODEL", "claude-sonnet-4-6")),
            "provider": "motapis" if (os.environ.get("MOTAPIS_API_KEY") or os.environ.get("CUSTOM_API_KEY")) else ("gemini" if os.environ.get("GEMINI_API_KEY") else ("openai" if os.environ.get("OPENAI_API_KEY") else "gemini"))
        }
        self._deprioritized_keys = set()
        self._reload_config_if_changed(force=True)
        if str(self.config.get("provider") or "").strip().lower() in ("", "offline"):
            self.config["provider"] = "motapis" if self.get_motapis_keys() else "gemini"

    def _reload_config_if_changed(self, force=False):
        with self._config_lock:
            try:
                st = os.stat(self.config_file)
                sig = (self.config_file, st.st_mtime_ns, st.st_size)
            except OSError:
                self._config_file_stat = None
                return
            if not force and sig == self._config_file_stat:
                return
            try:
                with open(self.config_file, "r", encoding="utf-8") as f:
                    saved = json.load(f)
                if isinstance(saved, dict):
                    self.config.update(saved)
                self._config_file_stat = sig
            except Exception as e:
                if force:
                    _safe_log(f"[BridgeHub] Warning loading ai_config.json: {e}")

    def save_config(self):
        with self._config_lock:
            try:
                # 0600: the file can hold provider API keys.
                fd = os.open(self.config_file, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
                with os.fdopen(fd, "w", encoding="utf-8") as f:
                    json.dump(self.config, f, indent=2, ensure_ascii=False)
                try:
                    st = os.stat(self.config_file)
                    self._config_file_stat = (self.config_file, st.st_mtime_ns, st.st_size)
                except OSError:
                    self._config_file_stat = None
            except Exception as e:
                _safe_log(f"[BridgeHub] Warning saving ai_config.json: {e}")

    def _lock(self):
        return self.__dict__.setdefault('_clients_lock', threading.Lock())

    @staticmethod
    def _is_ws_closed(ws):
        if ws is None:
            return True
        if getattr(ws, 'close_code', None) is not None:
            return True
        state = getattr(ws, 'state', None)
        state_name = getattr(state, 'name', '')
        return bool(state_name and state_name.upper() in ('CLOSING', 'CLOSED'))

    def _prune_closed_locked(self):
        if isinstance(self.connected_clients, list):
            self.connected_clients[:] = [c for c in self.connected_clients if not self._is_ws_closed(c)]
        else:
            for c in list(self.connected_clients):
                if self._is_ws_closed(c):
                    self.connected_clients.discard(c)

    def register_client(self, ws):
        # Ordered list: "most recently connected" must be deterministic, a set is not.
        with self._lock():
            self._prune_closed_locked()
            if ws in self.connected_clients:
                return
            if isinstance(self.connected_clients, list):
                self.connected_clients.append(ws)
            else:  # tolerate external/test code swapping in a set
                self.connected_clients.add(ws)

    def unregister_client(self, ws):
        with self._lock():
            if ws in self.connected_clients:
                self.connected_clients.remove(ws)

    def target_client(self):
        """The studio tab that receives bridge commands (last registered, still open)."""
        with self._lock():
            self._prune_closed_locked()
            clients = list(self.connected_clients)
        return clients[-1] if clients else None

    def client_count(self):
        with self._lock():
            self._prune_closed_locked()
            return len(self.connected_clients)

    def get_motapis_keys(self):
        self._reload_config_if_changed()
        with self._config_lock:
            keys = []
            custom_keys = self.config.get("customKeys")
            if isinstance(custom_keys, list):
                for k in custom_keys:
                    k_str = str(k).strip()
                    if k_str and not k_str.startswith("sk-DIEN_") and not k_str.startswith("sk-YOUR_"):
                        keys.append(k_str)
            single_key = str(self.config.get("customKey", "")).strip()
            if single_key and single_key not in keys and not single_key.startswith("sk-DIEN_") and not single_key.startswith("sk-YOUR_"):
                keys.append(single_key)
            return keys

    async def _dispatch_to_browser(self, action_data, timeout=30.0):
        if not self.connected_clients:
            return {
                "success": False,
                "error": "No active Web Blender Studio browser window connected. Open http://127.0.0.1:8080 in your browser."
            }

        req_id = str(uuid.uuid4())
        action_data["id"] = req_id

        # Target the most recently connected client (deterministic order)
        target_ws = self.target_client()
        if target_ws is None:
            return {
                "success": False,
                "error": "No active Web Blender Studio browser window connected. Open http://127.0.0.1:8080 in your browser."
            }
        loop = asyncio.get_running_loop()
        future = loop.create_future()
        self.pending_futures[req_id] = future

        try:
            async def dispatch():
                try:
                    await target_ws.send(json.dumps(action_data))
                except Exception:
                    self.unregister_client(target_ws)
                    raise
                return await future
            return await asyncio.wait_for(dispatch(), timeout=timeout)
        except asyncio.TimeoutError:
            return {"success": False, "error": f"Browser response timeout ({timeout:g}s)"}
        except Exception as e:
            return {"success": False, "error": str(e)}
        finally:
            self.pending_futures.pop(req_id, None)
            if not future.done():
                future.cancel()

    def send_and_wait(self, action_data, timeout=30.0):
        if not self.loop or not self.loop.is_running():
            return {"success": False, "error": "WebSocket bridge event loop not running."}

        coro = self._dispatch_to_browser(action_data, timeout=timeout)
        future = asyncio.run_coroutine_threadsafe(coro, self.loop)
        try:
            return future.result(timeout=timeout)
        except TimeoutError:
            future.cancel()
            return {"success": False, "error": "Browser response timeout"}
        except Exception as e:
            future.cancel()
            return {"success": False, "error": f"Bridge request failed: {e}"}

bridge_hub = StudioBridgeHub()

def _ws_origin_allowed(origin, host_header):
    """Only the studio page (loopback/localhost) may open the bridge socket.

    Browser pages always send Origin; CLI/MCP clients don't and stay allowed.
    """
    if origin is None:
        return True
    try:
        parsed = urlsplit(origin)
        host = urlsplit('//' + (host_header or ''))
    except ValueError:
        return False
    if (parsed.scheme not in ('http', 'https') or parsed.username is not None or
            parsed.password is not None or parsed.path not in ('', '/') or
            parsed.query or parsed.fragment or not parsed.hostname or not host.hostname):
        return False
    origin_host = parsed.hostname.lower().rstrip('.')
    request_host = host.hostname.lower().rstrip('.')
    origin_default_port = 443 if parsed.scheme == 'https' else 80
    origin_port = parsed.port or origin_default_port
    host_port = host.port or origin_default_port
    allowed_ports = set(_ACTIVE_HTTP_PORTS)
    allowed_ports.add(host_port)
    for raw_port in _env_csv_set('STUDIO_WS_ALLOWED_PORTS'):
        if raw_port.isdigit():
            allowed_ports.add(int(raw_port))
    if origin_port not in allowed_ports:
        return False
    if origin_host == request_host:
        return True
    allowed = {'127.0.0.1', 'localhost', '::1'}
    if BIND_HOST not in ('0.0.0.0', '::', ''):
        allowed.add(BIND_HOST.lower())
    allowed.update(_env_csv_set('STUDIO_ALLOWED_HOSTS'))
    return origin_host in allowed and request_host in allowed


def _cookie_value(headers, name):
    raw = headers.get('Cookie', '') or ''
    for part in raw.split(';'):
        key, _, value = part.strip().partition('=')
        if key == name:
            return unquote(value)
    return ''


def _ws_token_allowed(request):
    if not STUDIO_TOKEN:
        return True
    headers = request.headers
    provided = headers.get('X-Studio-Token') or _cookie_value(headers, 'studio_token')
    if not provided and request.path:
        query = parse_qs(urlsplit(request.path).query)
        values = query.get('token') or []
        provided = values[0] if len(values) == 1 else ''
    return hmac.compare_digest(str(provided or ''), STUDIO_TOKEN)


async def _ws_process_request(connection, request):
    if not _ws_origin_allowed(request.headers.get('Origin'), request.headers.get('Host')):
        return connection.respond(HTTPStatus.FORBIDDEN, 'Forbidden origin\n')
    if not _ws_token_allowed(request):
        return connection.respond(HTTPStatus.UNAUTHORIZED, 'Unauthorized\n')
    return None


async def ws_handler(websocket):
    bridge_hub.register_client(websocket)
    try:
        _safe_log(f"[Bridge WS] Studio browser connected: {websocket.remote_address}")
        async for message in websocket:
            try:
                data = json.loads(message)
                msg_id = data.get("id")
                if msg_id and msg_id in bridge_hub.pending_futures:
                    fut = bridge_hub.pending_futures.pop(msg_id)
                    if not fut.done():
                        fut.set_result(data)
            except Exception as e:
                _safe_log(f"[Bridge WS] Error parsing browser response: {e}")
    except Exception:
        pass
    finally:
        bridge_hub.unregister_client(websocket)
        _safe_log(f"[Bridge WS] Studio browser disconnected: {websocket.remote_address}")

def start_ws_server(port=8082):
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    bridge_hub.loop = loop

    async def main():
        async with websockets.serve(
            ws_handler, BIND_HOST, port, max_size=64 * 1024 * 1024,
            process_request=_ws_process_request,
        ):
            _safe_log(f"[Bridge WS] Listening for Studio browser connections on ws://{BIND_HOST}:{port}")
            await asyncio.Future() # run forever

    loop.run_until_complete(main())

# =============================================================================
# LOCAL AGENT BACKEND
# =============================================================================

AGENT_ALLOWLIST = (
    'cdn.jsdelivr.net', 'raw.githubusercontent.com', 'assets.mixamo.com',
    'models.readyplayer.me', 'raw.githack.com',
)
AGENT_MAX_BYTES = 50 * 1024 * 1024
AGENT_TIMEOUT = 20.0
AGENT_ASSET_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'agent_assets')
AGENT_ASSET_EXTENSIONS = frozenset((
    '.glb', '.gltf', '.obj', '.mtl', '.stl', '.fbx', '.ply', '.bvh', '.dae', '.bin',
    '.json', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.bmp', '.tga',
    '.hdr', '.exr', '.ktx', '.ktx2', '.dds', '.mp3', '.wav', '.ogg', '.flac',
    '.m4a', '.aac', '.mp4', '.webm', '.mov', '.mkv',
))
AGENT_ASSET_NAME = re.compile(r'[A-Za-z0-9][A-Za-z0-9_-]*_[0-9a-f]{32}\.[a-z0-9]+\Z')
_agent_rate_lock = threading.Lock()
_agent_rate_windows = {}


class AgentRequestError(Exception):
    def __init__(self, code, message, status=400, hint=''):
        super().__init__(message)
        self.code, self.status, self.hint = code, status, hint


def _agent_error(code, message, hint='', tool_id=None):
    return {'ok': False, 'error': {
        'code': code, 'message': message, 'hint': hint, 'toolId': tool_id,
    }}


def _agent_remaining(deadline):
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise AgentRequestError('E_TIMEOUT', 'Agent request exceeded its 20s deadline.', 504)
    return remaining


def _agent_take_rate(ip):
    now = time.monotonic()
    with _agent_rate_lock:
        for key in list(_agent_rate_windows):
            if not _agent_rate_windows[key] or now - _agent_rate_windows[key][-1] >= 60:
                del _agent_rate_windows[key]
        window = _agent_rate_windows.setdefault(ip, deque())
        while window and now - window[0] >= 60:
            window.popleft()
        if len(window) >= 60:
            raise AgentRequestError('E_PERMISSION', 'Proxy/upload rate limit reached.', 429,
                                    'Wait one minute before retrying (60 requests/minute per IP).')
        window.append(now)


def _agent_public_ip(address):
    ip = ipaddress.ip_address(address)
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped:
        return _agent_public_ip(str(ip.ipv4_mapped))
    return ip.is_global and not (ip.is_private or ip.is_loopback or ip.is_link_local
                                or ip.is_reserved or ip.is_multicast or ip.is_unspecified)


def _agent_target(url, deadline):
    if not isinstance(url, str) or not url or len(url) > 8192:
        raise AgentRequestError('E_INVALID_ARG', 'Provide an HTTP(S) asset URL (up to 8192 characters).')
    if re.search(r'[\x00-\x20\x7f\\]', url):
        raise AgentRequestError('E_INVALID_ARG', 'URL contains unsafe characters.')
    try:
        parsed = urlsplit(url)
        host = (parsed.hostname or '').encode('idna').decode('ascii').lower().rstrip('.')
        port = parsed.port or (443 if parsed.scheme == 'https' else 80)
    except (ValueError, UnicodeError):
        raise AgentRequestError('E_INVALID_ARG', 'Invalid asset URL.') from None
    if parsed.scheme not in ('http', 'https') or not host:
        raise AgentRequestError('E_PERMISSION', 'Only HTTP(S) asset URLs are allowed.', 403)
    if parsed.username is not None or parsed.password is not None:
        raise AgentRequestError('E_PERMISSION', 'Credentials in asset URLs are forbidden.', 403)
    if host not in AGENT_ALLOWLIST or port != (443 if parsed.scheme == 'https' else 80):
        raise AgentRequestError('E_PERMISSION', 'Asset host/port is not allowlisted.', 403,
                                'Use GET /api/agent/allowlist to inspect allowed domains.')

    # getaddrinfo has no timeout API. Bound the caller's wait without changing global DNS.
    ready = threading.Event()
    result = []
    def resolve():
        try:
            result.append(socket.getaddrinfo(host, port, type=socket.SOCK_STREAM))
        except OSError:
            result.append(None)
        finally:
            ready.set()
    threading.Thread(target=resolve, daemon=True).start()
    if not ready.wait(_agent_remaining(deadline)):
        raise AgentRequestError('E_TIMEOUT', 'Asset DNS lookup timed out.', 504)
    answers = result[0]
    if not answers:
        raise AgentRequestError('E_NOT_FOUND', 'Asset host could not be resolved.', 502)
    for family, _, _, _, address in answers:
        if family not in (socket.AF_INET, socket.AF_INET6) or not _agent_public_ip(address[0]):
            raise AgentRequestError('E_PERMISSION', 'Asset DNS contains a non-public address.', 403)
    _agent_remaining(deadline)
    return parsed, host, port, answers[0]


class _AgentPinnedConnection(HTTPConnection):
    """Connect directly to one validated sockaddr; TLS/Host retain the original name."""
    def __init__(self, host, port, answer, secure, deadline):
        super().__init__(host, port, timeout=_agent_remaining(deadline))
        self.answer, self.secure, self.deadline = answer, secure, deadline
        self._active_socket = None

    def connect(self):
        family, socktype, proto, _, address = self.answer
        sock = socket.socket(family, socktype, proto)
        self.sock = self._active_socket = sock
        sock.settimeout(_agent_remaining(self.deadline))
        sock.connect(address)  # No second hostname lookup, even for HTTP.
        if self.secure:
            context = ssl.create_default_context()
            self.sock = self._active_socket = context.wrap_socket(
                sock, server_hostname=self.host, do_handshake_on_connect=False)
            self.sock.settimeout(_agent_remaining(self.deadline))
            self.sock.do_handshake()

    def abort(self):
        sock = self._active_socket
        if sock is not None:
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            sock.close()


def _agent_content_type(content_type, path):
    mime = content_type.split(';', 1)[0].strip().lower()
    if mime.startswith(('model/', 'audio/', 'video/')):
        return mime
    # SVG is executable document content, not a safe texture for this same-origin API.
    if mime.startswith('image/') and mime != 'image/svg+xml':
        return mime
    if mime in ('application/json', 'application/octet-stream', 'application/gltf-buffer',
                'application/ktx', 'application/ktx2', 'application/x-fbx'):
        return mime
    if mime == 'text/plain' and os.path.splitext(path)[1].lower() in (
            '.obj', '.mtl', '.stl', '.ply', '.bvh', '.gltf'):
        return mime
    raise AgentRequestError('E_UNSUPPORTED', 'Upstream content type is not an allowed asset type.', 415)


def _agent_proxy(url, deadline):
    for hop in range(6):
        parsed, host, port, answer = _agent_target(url, deadline)
        conn = _AgentPinnedConnection(host, port, answer, parsed.scheme == 'https', deadline)
        # Closing the socket at the absolute deadline also stops slow-drip headers/body.
        timer = threading.Timer(_agent_remaining(deadline), conn.abort)
        timer.daemon = True
        timer.start()
        try:
            target = parsed.path or '/'
            if parsed.query:
                target += '?' + parsed.query
            conn.request('GET', target, headers={
                'User-Agent': 'WebBlenderStudio-Agent/1.0',
                'Accept-Encoding': 'identity', 'Connection': 'close',
            })  # Never forward client cookies, authorization, Origin or other credentials.
            with conn.getresponse() as response:
                _agent_remaining(deadline)
                if response.status in (301, 302, 303, 307, 308):
                    location = response.getheader('Location')
                    if hop == 5 or not location:
                        raise AgentRequestError('E_PERMISSION', 'Invalid or excessive asset redirects.', 403)
                    url = urljoin(url, location)
                    continue  # Every redirect gets fresh allowlist/DNS validation and pinning.
                if not 200 <= response.status < 300:
                    raise AgentRequestError('E_NOT_FOUND', 'Upstream asset request failed.', 502)
                mime = _agent_content_type(response.getheader('Content-Type', ''), parsed.path)
                if response.getheader('Content-Encoding', 'identity').lower() != 'identity':
                    raise AgentRequestError('E_UNSUPPORTED', 'Compressed upstream responses are not supported.', 415)
                length = response.getheader('Content-Length')
                if length is not None:
                    if not length.isdigit():
                        raise AgentRequestError('E_INVALID_ARG', 'Invalid upstream content length.', 502)
                    if int(length) > AGENT_MAX_BYTES:
                        raise AgentRequestError('E_TOO_LARGE', 'Asset exceeds the 50MB limit.', 413)
                chunks, size = [], 0
                while True:
                    # HTTPResponse closes its file/socket immediately after consuming
                    # Content-Length; do not touch that closed descriptor on the next turn.
                    if length is not None and size == int(length):
                        break
                    conn._active_socket.settimeout(_agent_remaining(deadline))
                    chunk = response.read1(min(65536, AGENT_MAX_BYTES + 1 - size))
                    _agent_remaining(deadline)
                    if not chunk:
                        break
                    size += len(chunk)
                    if size > AGENT_MAX_BYTES:
                        raise AgentRequestError('E_TOO_LARGE', 'Asset exceeds the 50MB limit.', 413)
                    chunks.append(chunk)
                if length is not None and size != int(length):
                    raise AgentRequestError('E_NOT_FOUND', 'Upstream asset response was incomplete.', 502)
                _agent_remaining(deadline)
                return {'body': b''.join(chunks), 'contentType': mime, 'size': size}
        except AgentRequestError:
            raise
        except Exception:
            _agent_remaining(deadline)
            raise AgentRequestError('E_NOT_FOUND', 'Unable to fetch the upstream asset.', 502) from None
        finally:
            timer.cancel()
            conn.abort()
            conn.close()


def _agent_upload(body, deadline):
    name, encoded = body.get('fileName'), body.get('fileData')
    if not isinstance(name, str) or not name or len(name) > 255 or not isinstance(encoded, str):
        raise AgentRequestError('E_INVALID_ARG', 'fileName and base64 fileData must be strings.')
    # Optional data URL is accepted only when explicitly base64 encoded.
    if encoded.startswith('data:'):
        header, sep, encoded = encoded.partition(',')
        if not sep or len(header) > 256 or not header.endswith(';base64'):
            raise AgentRequestError('E_INVALID_ARG', 'fileData must use strict base64 encoding.')
    if len(encoded) > 4 * ((AGENT_MAX_BYTES + 2) // 3):
        raise AgentRequestError('E_TOO_LARGE', 'Upload exceeds the 50MB limit.', 413)
    try:
        raw = base64.b64decode(encoded, validate=True)
        if base64.b64encode(raw).decode('ascii') != encoded:
            raise ValueError('Non-canonical base64')
    except (ValueError, binascii.Error):
        raise AgentRequestError('E_INVALID_ARG', 'fileData is not valid strict base64.') from None
    if len(raw) > AGENT_MAX_BYTES:
        raise AgentRequestError('E_TOO_LARGE', 'Upload exceeds the 50MB limit.', 413)
    basename = name.replace('\\', '/').rsplit('/', 1)[-1]
    stem, ext = os.path.splitext(basename)
    ext = ext.lower()
    if ext not in AGENT_ASSET_EXTENSIONS:
        raise AgentRequestError('E_UNSUPPORTED', 'Unsupported upload asset extension.', 415,
                                'Upload a model, texture, audio, video, JSON or binary asset.')
    stem = re.sub(r'[^A-Za-z0-9_-]', '_', stem).strip('_-')[:80] or 'asset'
    safe_name = f'{stem}_{uuid.uuid4().hex}{ext}'
    _agent_remaining(deadline)
    os.makedirs(AGENT_ASSET_DIR, exist_ok=True)
    # Refuse symlink directories; exclusive creation also refuses collisions/file symlinks.
    if os.path.islink(AGENT_ASSET_DIR):
        raise AgentRequestError('E_PERMISSION', 'Unsafe asset storage directory.', 403)
    target = os.path.join(AGENT_ASSET_DIR, safe_name)
    created = False
    try:
        with open(target, 'xb') as output:
            created = True
            for offset in range(0, len(raw), 65536):
                _agent_remaining(deadline)
                output.write(raw[offset:offset + 65536])
        _agent_remaining(deadline)
    except Exception:
        if created:
            os.unlink(target)
        raise
    return {'fileName': safe_name, 'url': '/agent_assets/' + quote(safe_name), 'size': len(raw)}


def _agent_assets(deadline):
    assets = []
    if not os.path.isdir(AGENT_ASSET_DIR) or os.path.islink(AGENT_ASSET_DIR):
        return assets
    with os.scandir(AGENT_ASSET_DIR) as entries:
        for entry in entries:
            _agent_remaining(deadline)
            if (AGENT_ASSET_NAME.fullmatch(entry.name) and
                    os.path.splitext(entry.name)[1] in AGENT_ASSET_EXTENSIONS and
                    entry.is_file(follow_symlinks=False)):
                assets.append({'fileName': entry.name, 'url': '/agent_assets/' + quote(entry.name),
                               'size': entry.stat(follow_symlinks=False).st_size})
    return sorted(assets, key=lambda asset: asset['fileName'])


# =============================================================================
# PUBLIC CONFIG (never secrets)
# =============================================================================

def _mask_secret(value):
    text = str(value or "")
    if not text:
        return ""
    if len(text) <= 12:
        return "***"
    return f"{text[:4]}...{text[-4:]}"


FREE_TIER_MODELS = {
    "motapis": [
        "claude-sonnet-4-6",
        "claude-sonnet-5-5",
        "gpt-6-luna",
        "gpt-6-astra",
        "gpt-5.6-sol",
        "deepseek-v4-flash",
        "DeepSeek-V4-Flash-0731",
        "deepseek-v4.1-flash-1017",
        "gemini-4-hydrogen",
        "grok-4.5",
        "glm-5.3-flash",
        "minimax-m3",
        "minimax-m2.7",
        "kimi-k3.1-pro",
        "hy4-preview",
    ],
    "gemini": [
        "gemini-3.5-flash-lite",
        "gemini-3-flash-preview",
        "gemini-3.1-flash-lite",
        "gemini-3.1-flash-lite-preview",
        "gemini-3.8-flash",
        "gemma-4-31b-it",
    ],
}


def public_config(cfg=None):
    """A browser-safe view of the AI configuration. Never includes key material."""
    cfg = bridge_hub.config if cfg is None else cfg
    keys = bridge_hub.get_motapis_keys()
    provider = str(cfg.get("provider") or "motapis").strip().lower()
    if provider == "offline" or provider not in ("motapis", "custom", "gemini", "openai"):
        provider = "motapis" if keys else "gemini"
    return {
        "provider": provider,
        "geminiModel": cfg.get("geminiModel") or "gemini-3.5-flash-lite",
        "customModel": cfg.get("customModel") or "claude-sonnet-4-6",
        "openAiModel": cfg.get("openAiModel") or "gpt-4o-mini",
        "geminiConfigured": bool(str(cfg.get("geminiKey") or "").strip()),
        "openAiConfigured": bool(str(cfg.get("openAiKey") or "").strip()),
        "hasCustomKeys": bool(keys),
        "customKeysCount": len(keys),
        "maskedKeys": [_mask_secret(k) for k in keys],
        "freeModels": FREE_TIER_MODELS,
    }


def _ai_endpoint_for(provider):
    """Resolve the upstream base URL from trusted server config only."""
    cfg = bridge_hub.config
    if provider == "openai":
        return AI_PROVIDER_ENDPOINTS["openai"], [str(cfg.get("openAiKey") or "").strip()], cfg.get("openAiModel") or "gpt-4o-mini"
    if provider == "gemini":
        return AI_PROVIDER_ENDPOINTS["gemini"], [str(cfg.get("geminiKey") or "").strip()], cfg.get("geminiModel") or "gemini-3.5-flash-lite"
    base = str(cfg.get("customEndpoint") or "https://motapis.com/v1").strip().rstrip("/")
    return base, bridge_hub.get_motapis_keys(), cfg.get("customModel") or "claude-sonnet-4-6"


def _validated_ai_url(base):
    try:
        parsed = urlsplit(base if "://" in base else "https://" + base)
    except ValueError:
        raise AgentRequestError('E_INVALID_ARG', 'Configured AI endpoint is invalid.', 400) from None
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise AgentRequestError('E_INVALID_ARG', 'Configured AI endpoint must be HTTP(S).', 400)
    if parsed.username is not None or parsed.password is not None or parsed.query or parsed.fragment:
        raise AgentRequestError('E_INVALID_ARG', 'Configured AI endpoint contains unsupported parts.', 400)
    host = parsed.hostname.lower()
    if host in AI_FORBIDDEN_HOSTS:
        raise AgentRequestError('E_PERMISSION', 'Configured AI endpoint host is not allowed.', 403)
    path = parsed.path.rstrip('/')
    if not path.endswith('/chat/completions'):
        path += '/chat/completions'
    port = f":{parsed.port}" if parsed.port else ""
    return f"{parsed.scheme}://{host}{port}{path}"


def _validate_messages(messages):
    if not isinstance(messages, list) or not messages or len(messages) > 40:
        raise AgentRequestError('E_INVALID_ARG', 'messages must be a non-empty array (max 40).', 400)
    cleaned = []
    for message in messages:
        if not isinstance(message, dict):
            raise AgentRequestError('E_INVALID_ARG', 'Each message must be an object.', 400)
        role = message.get("role")
        content = message.get("content")
        if role not in ("system", "user", "assistant"):
            raise AgentRequestError('E_INVALID_ARG', 'Unsupported message role.', 400)
        if not isinstance(content, (str, list)):
            raise AgentRequestError('E_INVALID_ARG', 'Message content must be text or parts.', 400)
        cleaned.append({"role": role, "content": content})
    return cleaned


# =============================================================================
# HTTP STATIC & REST API HANDLER (PORT 8080)
# =============================================================================

# =============================================================================
# CONCURRENCY, STATIC CACHE, GZIP, RATE LIMITING & BACKPRESSURE
# =============================================================================

_BaseThreadingHTTPServer = ThreadingHTTPServer


def _write_all_resilient(wfile, data, chunk_size=65536):
    """Write bytes to socket/stream in bounded chunks, retrying transient ENOBUFS."""
    if not data:
        return
    sock = getattr(wfile, '_sock', None)
    if sock is None:
        wfile.write(data)
        return
    mv = memoryview(data)
    total = len(mv)
    pos = 0
    enobufs_retries = 0
    while pos < total:
        end = min(total, pos + chunk_size)
        try:
            sent = sock.send(mv[pos:end])
            if sent <= 0:
                raise BrokenPipeError('Socket closed during write')
            pos += sent
            enobufs_retries = 0
        except OSError as exc:
            err = getattr(exc, 'errno', None)
            if err == errno.EINTR:
                continue
            if err in (errno.ENOBUFS, errno.EAGAIN, errno.EWOULDBLOCK) and enobufs_retries < 60:
                enobufs_retries += 1
                time.sleep(min(0.05, 0.002 * enobufs_retries))
                continue
            raise


class StudioHTTPServer(_BaseThreadingHTTPServer):
    """High-concurrency HTTP server backed by a bounded thread pool + large listen backlog."""
    request_queue_size = max(
        1024, int(os.environ.get('STUDIO_LISTEN_BACKLOG', '1024') or 1024)
    )
    daemon_threads = True
    allow_reuse_address = True
    block_on_close = False

    def __init__(self, server_address, RequestHandlerClass, bind_and_activate=True):
        default_workers = max(64, min(96, (os.cpu_count() or 4) * 16))
        try:
            self.max_workers = max(8, int(os.environ.get('STUDIO_HTTP_WORKERS', str(default_workers))))
        except (TypeError, ValueError):
            self.max_workers = default_workers
        try:
            ka_thresh = int(os.environ.get('STUDIO_KEEPALIVE_THRESHOLD', str(max(16, self.max_workers // 2))))
        except (TypeError, ValueError):
            ka_thresh = max(16, self.max_workers // 2)
        self.keepalive_threshold = max(4, ka_thresh)
        self._inflight_lock = threading.Lock()
        self._inflight_conns = 0
        self._pool = concurrent.futures.ThreadPoolExecutor(
            max_workers=self.max_workers,
            thread_name_prefix='studio-http',
        )
        super().__init__(server_address, RequestHandlerClass, bind_and_activate=bind_and_activate)

    def _run_pooled_request(self, request, client_address):
        try:
            self.process_request_thread(request, client_address)
        finally:
            with self._inflight_lock:
                self._inflight_conns = max(0, self._inflight_conns - 1)

    def process_request(self, request, client_address):
        with self._inflight_lock:
            self._inflight_conns += 1
        try:
            self._pool.submit(self._run_pooled_request, request, client_address)
        except RuntimeError:
            with self._inflight_lock:
                self._inflight_conns = max(0, self._inflight_conns - 1)
            self.shutdown_request(request)

    def server_close(self):
        try:
            super().server_close()
        finally:
            pool = getattr(self, '_pool', None)
            if pool is not None:
                pool.shutdown(wait=False, cancel_futures=True)

    def server_bind(self):
        super().server_bind()
        try:
            self.socket.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        except OSError:
            pass

    def handle_error(self, request, client_address):
        exc_type, exc_val = sys.exc_info()[:2]
        if exc_type is not None and issubclass(
            exc_type, (BrokenPipeError, ConnectionResetError, TimeoutError)
        ):
            return
        if isinstance(exc_val, OSError) and getattr(exc_val, 'errno', None) in (
            errno.EPIPE, errno.ECONNRESET, errno.ENOTCONN, errno.ENOBUFS,
        ):
            return
        super().handle_error(request, client_address)


# Ensure tests or callers instantiating server_module.ThreadingHTTPServer
# inherit the raised SYN backlog and daemon thread lifecycle.
ThreadingHTTPServer = StudioHTTPServer

_COMPRESSIBLE_EXTENSIONS = frozenset({
    '.html', '.htm', '.js', '.mjs', '.css', '.json', '.svg', '.wasm',
    '.glb', '.gltf', '.txt', '.xml', '.map', '.obj', '.stl', '.task',
    '.webmanifest', '.web3d',
})
_HASHED_ASSET_RE = re.compile(r'-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$')


def _accepts_gzip(headers):
    if not headers:
        return False
    raw = str(headers.get('Accept-Encoding', '') or '').lower()
    if 'gzip' not in raw:
        return False
    for part in raw.split(','):
        token = part.strip()
        if token == 'gzip' or token.startswith('gzip;'):
            return 'q=0' not in token.replace(' ', '') or 'q=0.' in token and not token.endswith(('q=0.0', 'q=0.00', 'q=0.000'))
    return False


def _etag_matches(if_none_match, etag):
    if not if_none_match or not etag:
        return False
    target = etag.strip()
    for part in str(if_none_match).split(','):
        candidate = part.strip()
        if candidate == '*':
            return True
        if candidate.startswith('W/'):
            candidate = candidate[2:].strip()
        if candidate == target:
            return True
    return False


def _is_compressible_static(fs_path, ctype, size):
    if size < 512:
        return False
    lower = fs_path.lower()
    for ext in _COMPRESSIBLE_EXTENSIONS:
        if lower.endswith(ext):
            return True
    mime = (ctype or '').split(';', 1)[0].strip().lower()
    return mime.startswith(('text/', 'application/javascript', 'application/json', 'application/wasm', 'image/svg+xml'))


def _static_cache_control(req_path):
    clean = str(req_path or '').split('?', 1)[0]
    if clean.startswith('/assets/') and _HASHED_ASSET_RE.search(clean):
        return 'public, max-age=31536000, immutable'
    if clean.startswith(('/assets/', '/vendor/', '/models/')):
        return 'public, max-age=3600'
    return 'no-cache'


class _StaticAssetCache:
    """Thread-safe bounded LRU cache for static files and their gzip payloads."""

    def __init__(self, max_total_bytes=64 * 1024 * 1024, max_entry_bytes=6 * 1024 * 1024):
        self.max_total_bytes = max(1024 * 1024, int(max_total_bytes))
        self.max_entry_bytes = max(64 * 1024, int(max_entry_bytes))
        self._lock = threading.Lock()
        self._entries = OrderedDict()  # fs_path -> dict
        self._total_bytes = 0

    def clear(self):
        with self._lock:
            self._entries.clear()
            self._total_bytes = 0

    def _entry_bytes(self, entry):
        gz = entry.get('gz')
        return len(entry['raw']) + (len(gz) if gz is not None else 0)

    def _evict_if_needed(self):
        while self._total_bytes > self.max_total_bytes and self._entries:
            _, evicted = self._entries.popitem(last=False)
            self._total_bytes = max(0, self._total_bytes - self._entry_bytes(evicted))

    def get(self, fs_path, st, ctype, want_gzip):
        if st.st_size > self.max_entry_bytes:
            return None
        sig = (st.st_mtime_ns, st.st_size)
        compressible = _is_compressible_static(fs_path, ctype, st.st_size)
        with self._lock:
            entry = self._entries.get(fs_path)
            if entry is not None and entry['sig'] == sig:
                self._entries.move_to_end(fs_path)
                if not want_gzip or not compressible or entry['gz_checked']:
                    return entry
                raw_copy = entry['raw']
            else:
                raw_copy = None

        if raw_copy is None:
            with open(fs_path, 'rb') as f:
                raw_copy = f.read()
        gz_bytes = None
        gz_checked = False
        if want_gzip and compressible:
            compressed = gzip.compress(raw_copy, compresslevel=5)
            gz_bytes = compressed if len(compressed) < len(raw_copy) else None
            gz_checked = True

        with self._lock:
            existing = self._entries.get(fs_path)
            if existing is not None and existing['sig'] == sig:
                if gz_checked and not existing['gz_checked']:
                    if gz_bytes is not None:
                        self._total_bytes += len(gz_bytes)
                    existing['gz'] = gz_bytes
                    existing['gz_checked'] = True
                    self._evict_if_needed()
                self._entries.move_to_end(fs_path)
                return existing
            if existing is not None:
                self._total_bytes = max(0, self._total_bytes - self._entry_bytes(existing))
                del self._entries[fs_path]
            new_entry = {
                'sig': sig,
                'ctype': ctype,
                'raw': raw_copy,
                'gz': gz_bytes,
                'gz_checked': gz_checked,
            }
            self._entries[fs_path] = new_entry
            self._total_bytes += self._entry_bytes(new_entry)
            self._evict_if_needed()
            return new_entry


_STATIC_CACHE = _StaticAssetCache(
    max_total_bytes=int(os.environ.get('STUDIO_STATIC_CACHE_BYTES', str(64 * 1024 * 1024))),
    max_entry_bytes=int(os.environ.get('STUDIO_STATIC_MAX_ENTRY_BYTES', str(6 * 1024 * 1024))),
)


class _TTSMemoryCache:
    """Bounded in-memory LRU cache for synthesized TTS MP3 responses."""

    def __init__(self, max_total_bytes=16 * 1024 * 1024):
        self.max_total_bytes = max(256 * 1024, int(max_total_bytes))
        self._lock = threading.Lock()
        self._entries = OrderedDict()
        self._total_bytes = 0

    def get(self, key):
        with self._lock:
            val = self._entries.get(key)
            if val is not None:
                self._entries.move_to_end(key)
            return val

    def put(self, key, audio_bytes):
        if not audio_bytes or len(audio_bytes) > self.max_total_bytes // 2:
            return
        with self._lock:
            old = self._entries.pop(key, None)
            if old is not None:
                self._total_bytes = max(0, self._total_bytes - len(old))
            self._entries[key] = audio_bytes
            self._total_bytes += len(audio_bytes)
            while self._total_bytes > self.max_total_bytes and self._entries:
                _, dropped = self._entries.popitem(last=False)
                self._total_bytes = max(0, self._total_bytes - len(dropped))

    def clear(self):
        with self._lock:
            self._entries.clear()
            self._total_bytes = 0


_TTS_MEM_CACHE = _TTSMemoryCache()
_TTS_INFLIGHT_LOCK = threading.Lock()
_TTS_INFLIGHT = {}


class SlidingWindowLimiter:
    """Thread-safe per-(bucket, IP) sliding-window rate limiter with bounded state."""

    def __init__(self, max_keys=4096):
        self.max_keys = max(128, int(max_keys))
        self._lock = threading.Lock()
        self._buckets = OrderedDict()

    def reset(self):
        with self._lock:
            self._buckets.clear()

    def allow(self, bucket, client_ip, limit, window_sec=60.0):
        if limit is None or limit <= 0:
            return True, 0
        now = time.monotonic()
        cutoff = now - float(window_sec)
        key = (bucket, str(client_ip or 'unknown'))
        with self._lock:
            dq = self._buckets.get(key)
            if dq is None:
                while len(self._buckets) >= self.max_keys:
                    self._buckets.popitem(last=False)
                dq = deque()
                self._buckets[key] = dq
            else:
                self._buckets.move_to_end(key)
            while dq and dq[0] <= cutoff:
                dq.popleft()
            if len(dq) >= limit:
                retry_after = max(1, math.ceil(dq[0] + window_sec - now))
                return False, retry_after
            dq.append(now)
            return True, 0


_RATE_LIMITER = SlidingWindowLimiter()
_HEAVY_JOB_SEMAPHORE = threading.BoundedSemaphore(
    max(1, int(os.environ.get('STUDIO_MAX_CONCURRENT_JOBS', '4') or 4))
)
_AI_CHAT_SEMAPHORE = threading.BoundedSemaphore(
    max(1, int(os.environ.get('STUDIO_MAX_AI_CONCURRENT', '32') or 32))
)
_TTS_SEMAPHORE = threading.BoundedSemaphore(
    max(1, int(os.environ.get('STUDIO_MAX_TTS_CONCURRENT', '16') or 16))
)


def _env_int(name, default):
    try:
        return int(os.environ.get(name, str(default)))
    except (TypeError, ValueError):
        return default


class BlenderStudioHTTPRequestHandler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def setup(self):
        super().setup()
        self._requests_handled = 0
        self._awaiting_keepalive_next = False
        self._skip_default_cache = False
        try:
            self.connection.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        except OSError:
            pass

    def handle_one_request(self):
        self._skip_default_cache = False
        if getattr(self, '_requests_handled', 0) > 0:
            self._awaiting_keepalive_next = True
            try:
                self.connection.settimeout(float(os.environ.get('STUDIO_KEEPALIVE_TIMEOUT', '5')))
            except OSError:
                pass
        else:
            self._awaiting_keepalive_next = False
        super().handle_one_request()

    def parse_request(self):
        self._awaiting_keepalive_next = False
        self._requests_handled = getattr(self, '_requests_handled', 0) + 1
        try:
            self.connection.settimeout(float(os.environ.get('STUDIO_REQUEST_TIMEOUT', '120')))
        except OSError:
            pass
        return super().parse_request()

    def send_error(self, code, message=None, explain=None):
        if code >= 500 or code in (400, 408, 413, 429):
            self.close_connection = True
        return super().send_error(code, message, explain)

    def guess_type(self, path):
        for ext, mime in CUSTOM_MIME_TYPES.items():
            if path.lower().endswith(ext):
                return mime
        return super().guess_type(path)

    def flush_headers(self):
        if hasattr(self, '_headers_buffer'):
            buf = b"".join(self._headers_buffer)
            self._headers_buffer = []
            if buf:
                _write_all_resilient(self.wfile, buf, chunk_size=16384)

    def end_headers(self):
        # No wildcard CORS: the studio is same-origin. Agent endpoints keep nosniff.
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'strict-origin-when-cross-origin')
        self.send_header('Permissions-Policy', 'camera=(), geolocation=()')
        self.send_header('Accept-Ranges', 'bytes')
        req_path = (getattr(self, 'path', '') or '').split('?', 1)[0]
        if req_path == '/embed.html':
            # Allow embedding embed.html inside both COEP-isolated parents (Studio Share preview,
            # test suites) and external third-party websites without COOP popup/opener conflicts.
            self.send_header('Cross-Origin-Embedder-Policy', 'credentialless')
            self.send_header('Cross-Origin-Resource-Policy', 'cross-origin')
        elif not req_path.startswith('/api/'):
            # Unlock SharedArrayBuffer for multi-threaded Rust WASM video/path-trace rendering
            # while allowing cross-origin textures/HDRIs via credentialless COEP.
            self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
            self.send_header('Cross-Origin-Embedder-Policy', 'credentialless')
            self.send_header('X-Frame-Options', 'SAMEORIGIN')
        skip_csp = getattr(self, '_skip_default_csp', False)
        self._skip_default_csp = False
        if not skip_csp and not req_path.startswith('/api/'):
            is_html = req_path in ('', '/') or req_path.endswith(('.html', '.htm'))
            if is_html:
                sb_origin = ''
                if CLOUD and CLOUD.config and CLOUD.config.supabase_url:
                    cand = CLOUD.config.supabase_url.strip()
                    if re.match(r'^https?://[A-Za-z0-9.-]+(?::\d+)?$', cand):
                        sb_origin += ' ' + cand
                r2_cdn = (os.environ.get('STUDIO_R2_PUBLIC_URL') or '').strip().rstrip('/')
                if r2_cdn and re.match(r'^https://[A-Za-z0-9.-]+(?::\d+)?$', r2_cdn):
                    sb_origin += ' ' + r2_cdn
                if req_path == '/embed.html':
                    csp = (
                        "default-src 'self'; "
                        "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:; "
                        "style-src 'self' 'unsafe-inline'; "
                        "img-src 'self' data: blob: https:; "
                        "font-src 'self' data:; "
                        "media-src 'self' blob: data: https:; "
                        "worker-src 'self' blob:; "
                        f"connect-src 'self' blob: data: https:{sb_origin}; "
                        "object-src 'none'; base-uri 'self'; frame-ancestors *"
                    )
                else:
                    csp = (
                        "default-src 'self'; "
                        "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:; "
                        "style-src 'self' 'unsafe-inline'; "
                        f"img-src 'self' data: blob: https://*.supabase.co https://img.vietqr.io https://dl.polyhaven.org https://cdn.polyhaven.com https://cdn.polyhaven.org https://raw.githubusercontent.com{sb_origin}; "
                        "font-src 'self' data:; "
                        "media-src 'self' blob: data:; "
                        "worker-src 'self' blob:; "
                        f"connect-src 'self' ws: wss: blob: data: https://*.supabase.co https://api.polyhaven.com https://dl.polyhaven.org https://cdn.polyhaven.com https://cdn.polyhaven.org https://raw.githubusercontent.com{sb_origin}; "
                        "object-src 'none'; base-uri 'self'; frame-ancestors 'self'"
                    )
                self.send_header('Content-Security-Policy', csp)
        skip_default = getattr(self, '_skip_default_cache', False)
        self._skip_default_cache = False
        if not skip_default:
            self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
            self.send_header('Pragma', 'no-cache')
            self.send_header('Expires', '0')
        # Shed idle keep-alive sockets under surge so pooled workers recycle in milliseconds.
        srv = getattr(self, 'server', None)
        inflight = getattr(srv, '_inflight_conns', 0)
        ka_threshold = getattr(srv, 'keepalive_threshold', 48)
        if not getattr(self, 'close_connection', False) and (
            inflight > ka_threshold or getattr(self, '_requests_handled', 0) >= 100
        ):
            self.close_connection = True
            has_conn = any(
                line.lower().startswith(b'connection:')
                for line in getattr(self, '_headers_buffer', ())
            )
            if not has_conn:
                self.send_header('Connection', 'close')
        super().end_headers()

    def _try_serve_range(self, head_only=False):
        range_hdr = self.headers.get('Range')
        if not range_hdr:
            return False
        fs_path = self.translate_path(self.path)
        if not os.path.isfile(fs_path):
            return False
        m = re.match(r'^bytes=(\d*)-(\d*)$', range_hdr.strip())
        if not m or (m.group(1) == '' and m.group(2) == ''):
            return False
        try:
            st = os.stat(fs_path)
            size = st.st_size
            if size <= 0:
                return False
            if m.group(1) == '':
                suffix = int(m.group(2))
                if suffix <= 0:
                    raise ValueError('empty suffix')
                start = max(0, size - suffix)
                end = size - 1
            elif m.group(2) == '':
                start = int(m.group(1))
                end = size - 1
            else:
                start = int(m.group(1))
                end = min(size - 1, int(m.group(2)))
            if start < 0 or start > end or start >= size:
                self.send_response(416)
                self.send_header('Content-Range', f'bytes */{size}')
                self.send_header('Content-Length', '0')
                self.end_headers()
                return True
            length = end - start + 1
            ctype = self.guess_type(fs_path) or 'application/octet-stream'
            self.send_response(206)
            self.send_header('Content-Type', ctype)
            self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
            self.send_header('Content-Length', str(length))
            self.send_header('Last-Modified', self.date_time_string(st.st_mtime))
            self.end_headers()
            if head_only:
                return True
            with open(fs_path, 'rb') as fp:
                fp.seek(start)
                remaining = length
                while remaining > 0:
                    chunk = fp.read(min(65536, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
            return True
        except (BrokenPipeError, ConnectionResetError):
            return True
        except (OSError, ValueError):
            return False

    def do_OPTIONS(self):
        if self._is_agent_path():
            return self._handle_agent('OPTIONS')
        req_path = self.path.split('?', 1)[0]
        is_api = req_path.startswith('/api/')
        try:
            if is_api:
                self._api_guard(check_token=False)
        except AgentRequestError as error:
            return self._send_json(error.status, {"success": False, "error": str(error)})
        self.send_response(204)
        origin = self.headers.get('Origin')
        if origin and is_api:
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Vary', 'Origin')
            self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, HEAD')
            self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Studio-Token')
        self.send_header('Content-Length', '0')
        self.end_headers()

    def _serve_cached_static(self, head_only=False):
        req_path = urlsplit(self.path).path
        fs_path = self.translate_path(self.path)
        if os.path.isdir(fs_path):
            if not req_path.endswith('/'):
                return False
            for index_name in ('index.html', 'index.htm'):
                candidate = os.path.join(fs_path, index_name)
                if os.path.isfile(candidate):
                    fs_path = candidate
                    req_path = req_path + index_name
                    break
            else:
                return False
        try:
            st = os.stat(fs_path)
        except OSError:
            return False
        if not _stat.S_ISREG(st.st_mode):
            return False

        ctype = self.guess_type(fs_path)
        etag = f'"{st.st_mtime_ns:x}-{st.st_size:x}"'
        cache_ctrl = _static_cache_control(req_path)

        if _etag_matches(self.headers.get('If-None-Match'), etag):
            self.send_response(304)
            self.send_header('ETag', etag)
            self.send_header('Cache-Control', cache_ctrl)
            self.send_header('Vary', 'Accept-Encoding')
            self._skip_default_cache = True
            self.end_headers()
            return True

        want_gzip = _accepts_gzip(self.headers)
        entry = _STATIC_CACHE.get(fs_path, st, ctype, want_gzip)
        try:
            if entry is not None:
                gz = entry['gz'] if want_gzip else None
                payload = gz if gz is not None else entry['raw']
                self.send_response(200)
                self.send_header('Content-Type', entry['ctype'])
                self.send_header('ETag', etag)
                self.send_header('Cache-Control', cache_ctrl)
                self.send_header('Vary', 'Accept-Encoding')
                if gz is not None:
                    self.send_header('Content-Encoding', 'gzip')
                self.send_header('Content-Length', str(len(payload)))
                self.send_header('Last-Modified', self.date_time_string(st.st_mtime))
                self._skip_default_cache = True
                self.end_headers()
                if not head_only and payload:
                    _write_all_resilient(self.wfile, payload)
                return True

            # Large file (> max_entry_bytes): stream directly from disk without buffering in RAM.
            self.send_response(200)
            self.send_header('Content-Type', ctype)
            self.send_header('ETag', etag)
            self.send_header('Cache-Control', cache_ctrl)
            self.send_header('Vary', 'Accept-Encoding')
            self.send_header('Content-Length', str(st.st_size))
            self.send_header('Last-Modified', self.date_time_string(st.st_mtime))
            self._skip_default_cache = True
            self.end_headers()
            if not head_only and st.st_size > 0:
                with open(fs_path, 'rb') as f:
                    while True:
                        chunk = f.read(65536)
                        if not chunk:
                            break
                        _write_all_resilient(self.wfile, chunk)
            return True
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True
            return True

    def do_HEAD(self):
        if self._is_agent_path():
            return self._handle_agent('HEAD')
        if self._static_blocked():
            return self._send_json(404, {"success": False, "error": "Not found."})
        if self._try_serve_range(head_only=True):
            return
        if self._serve_cached_static(head_only=True):
            return
        return super().do_HEAD()

    def _is_agent_path(self):
        path = self.path.split('?', 1)[0]
        return path == '/api/agent' or path.startswith('/api/agent/')

    def _static_blocked(self):
        """Never serve secrets, DBs, source code, dotfiles, or script-capable asset uploads."""
        path = unquote(self.path.split('?', 1)[0]).replace('\\', '/')
        normalized = posixpath.normpath(path)
        parts = [p for p in normalized.split('/') if p]
        if '..' in parts or any(p.startswith('.') for p in parts):
            return True
        lower = normalized.lower()
        if lower in SENSITIVE_EXACT_PATHS or lower.startswith('/cloud_config'):
            return True
        if any(lower == d or lower.startswith(d + '/') for d in SENSITIVE_TOP_DIRS):
            return True
        ext = os.path.splitext(lower)[1]
        if ext in SENSITIVE_EXTENSIONS:
            return True
        if not any(lower.startswith(prefix) for prefix in PROTECTED_ASSET_PREFIXES):
            return False
        return ext in BLOCKED_ASSET_EXTENSIONS

    def _host_header(self):
        hosts = self.headers.get_all('Host', [])
        if len(hosts) != 1:
            raise AgentRequestError('E_PERMISSION', 'Invalid Host header.', 403)
        parsed = urlsplit('//' + hosts[0])
        if (not parsed.hostname or parsed.username is not None or parsed.password is not None or
                parsed.path or parsed.query or parsed.fragment):
            raise AgentRequestError('E_PERMISSION', 'Invalid Host header.', 403)
        return parsed

    @staticmethod
    def _loopback_name(hostname):
        name = (hostname or '').lower().rstrip('.')
        if name == 'localhost':
            return True
        try:
            ip = ipaddress.ip_address(name)
        except ValueError:
            return False
        if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped:
            ip = ip.ipv4_mapped
        return ip.is_loopback

    def _is_trusted_proxy(self):
        proxies = _env_csv_set('STUDIO_TRUSTED_PROXIES')
        if not proxies or not getattr(self, 'client_address', None):
            return False
        peer_raw = str(self.client_address[0] or '').strip()
        if peer_raw.lower() in proxies:
            return True
        try:
            peer_ip = ipaddress.ip_address(peer_raw)
            if isinstance(peer_ip, ipaddress.IPv6Address) and peer_ip.ipv4_mapped:
                peer_ip = peer_ip.ipv4_mapped
        except ValueError:
            return False
        for entry in proxies:
            try:
                if '/' in entry:
                    if peer_ip in ipaddress.ip_network(entry, strict=False):
                        return True
                else:
                    cand = ipaddress.ip_address(entry)
                    if isinstance(cand, ipaddress.IPv6Address) and cand.ipv4_mapped:
                        cand = cand.ipv4_mapped
                    if peer_ip == cand:
                        return True
            except ValueError:
                continue
        return False

    def _api_guard(self, check_token=True):
        """Host + Origin + optional token checks for every non-agent /api route."""
        host = self._host_header()
        trusted_proxy = self._is_trusted_proxy()
        allowed_hosts = _env_csv_set('STUDIO_ALLOWED_HOSTS')
        host_name = (host.hostname or '').lower().rstrip('.')
        if BIND_HOST in ('127.0.0.1', 'localhost', '::1'):
            host_allowed = self._loopback_name(host_name) or (
                trusted_proxy and (not allowed_hosts or host_name in allowed_hosts)
            )
            if not host_allowed:
                raise AgentRequestError('E_PERMISSION', 'Host must be local.', 403)
        elif allowed_hosts and host_name not in allowed_hosts and not self._loopback_name(host_name):
            raise AgentRequestError('E_PERMISSION', 'Host not allowed.', 403)
        origins = self.headers.get_all('Origin', [])
        if len(origins) > 1:
            raise AgentRequestError('E_CORS', 'Multiple Origin headers are not allowed.', 403)
        if origins:
            try:
                origin = urlsplit(origins[0])
            except ValueError:
                raise AgentRequestError('E_CORS', 'Invalid Origin header.', 403) from None
            default_port = 443 if origin.scheme == 'https' else 80
            host_default_port = 80
            if trusted_proxy:
                xf_proto = (self.headers.get('X-Forwarded-Proto') or '').split(',')[0].strip().lower()
                if xf_proto == 'https':
                    host_default_port = 443
                elif xf_proto == 'http':
                    host_default_port = 80
            elif allowed_hosts and host_name in allowed_hosts and origin.scheme == 'https':
                host_default_port = 443
            if (origin.scheme not in ('http', 'https') or origin.username is not None or
                    origin.password is not None or origin.path not in ('', '/') or
                    origin.query or origin.fragment or
                    (origin.hostname or '').lower().rstrip('.') != host_name or
                    (origin.port or default_port) != (host.port or host_default_port)):
                raise AgentRequestError('E_CORS', 'Origin must match this server host and port.', 403)
        if STUDIO_TOKEN and check_token:
            provided = self.headers.get('X-Studio-Token') or _cookie_value(self.headers, 'studio_token')
            if not hmac.compare_digest(str(provided or ''), STUDIO_TOKEN):
                raise AgentRequestError('E_PERMISSION', 'Unauthorized: missing or invalid studio token.', 401)
        elif (
            check_token
            and not STUDIO_TOKEN
            and trusted_proxy
            and not self._loopback_name(host_name)
            and CLOUD is not None
            and CLOUD.config.enabled
            and (self.path.split('?', 1)[0] != '/api/config')
        ):
            raise AgentRequestError(
                'E_PERMISSION',
                'Public reverse-proxy access to admin/local AI endpoints requires STUDIO_TOKEN (use /api/cloud/* with user auth).',
                401,
            )

    @staticmethod
    def _agent_local_host(host):
        if host == 'localhost':
            return True
        try:
            ip = ipaddress.ip_address(host)
            if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped:
                ip = ip.ipv4_mapped
            return ip.is_loopback
        except ValueError:
            return False

    def _agent_guard(self, check_origin):
        if not self._agent_local_host(self.client_address[0]):
            raise AgentRequestError('E_PERMISSION', 'Agent endpoints are localhost-client only.', 403)
        # Reject forwarded proxy traffic unless explicitly from a trusted local proxy
        if self.headers.get('X-Forwarded-For') or self.headers.get('Forwarded'):
            raise AgentRequestError('E_PERMISSION', 'Forwarded requests are not allowed on localhost agent endpoints.', 403)
        # Enforce STUDIO_TOKEN authentication on /api/agent/* whenever configured via CLI --token or env var
        configured_token = (STUDIO_TOKEN or os.environ.get('STUDIO_TOKEN') or '').strip()
        if configured_token:
            auth_hdr = (self.headers.get('Authorization') or '').strip()
            bearer = auth_hdr[7:].strip() if auth_hdr.lower().startswith('bearer ') else ''
            x_tok = (self.headers.get('X-Studio-Token') or '').strip()
            supplied = bearer or x_tok
            if not supplied or not hmac.compare_digest(supplied, configured_token):
                raise AgentRequestError('E_PERMISSION', 'Valid STUDIO_TOKEN required for agent endpoints.', 401)
        try:
            if len(self.headers.get_all('Host', [])) != 1:
                raise ValueError('Host')
            host = urlsplit('//' + self.headers['Host'])
            if (not host.hostname or host.username is not None or host.password is not None or
                    host.path or host.query or host.fragment or
                    not self._agent_local_host(host.hostname.lower()) or
                    (host.port or 80) != self.server.server_port):
                raise ValueError('Host')
            if check_origin and self.headers.get('Origin') is not None:
                if len(self.headers.get_all('Origin', [])) != 1:
                    raise ValueError('Origin')
                origin = urlsplit(self.headers['Origin'])
                if (origin.scheme != 'http' or origin.username is not None or
                        origin.password is not None or origin.path or origin.query or origin.fragment or
                        origin.hostname != host.hostname or (origin.port or 80) != (host.port or 80)):
                    raise AgentRequestError('E_CORS', 'Origin must match this server host and port.', 403)
        except ValueError:
            raise AgentRequestError('E_PERMISSION', 'Invalid or non-local request host/origin.', 403) from None

    def _read_agent_body(self, limit, deadline):
        self.close_connection = True  # Never leave rejected/unread request bytes on keep-alive.
        lengths = self.headers.get_all('Content-Length', [])
        if self.headers.get('Transfer-Encoding') or len(lengths) != 1 or not lengths[0].isdigit():
            raise AgentRequestError('E_INVALID_ARG', 'Provide one valid Content-Length; chunked bodies are unsupported.')
        length = int(lengths[0])
        if length > limit:
            raise AgentRequestError('E_TOO_LARGE', 'Agent request body exceeds its size limit.', 413)
        if self.headers.get('Content-Type', '').split(';', 1)[0].strip().lower() != 'application/json':
            raise AgentRequestError('E_INVALID_ARG', 'Agent requests require application/json.', 415)
        chunks, remaining = [], length
        while remaining:
            self.connection.settimeout(_agent_remaining(deadline))
            chunk = self.rfile.read1(min(65536, remaining))
            if not chunk:
                raise AgentRequestError('E_INVALID_ARG', 'Incomplete JSON body.')
            remaining -= len(chunk)
            chunks.append(chunk)
        _agent_remaining(deadline)
        try:
            def reject_constant(value):
                raise ValueError('Non-finite JSON')
            body = json.loads(b''.join(chunks), parse_constant=reject_constant)
        except (ValueError, UnicodeError, RecursionError):
            raise AgentRequestError('E_INVALID_ARG', 'Invalid JSON body.') from None
        if not isinstance(body, dict):
            raise AgentRequestError('E_INVALID_ARG', 'Agent request body must be a JSON object.')
        return body

    def _handle_agent(self, verb):
        path = self.path.split('?', 1)[0]
        deadline = time.monotonic() + AGENT_TIMEOUT
        tool_id = {
            '/api/agent/proxy': 'assets.importURL', '/api/agent/upload': 'assets.upload',
            '/api/agent/assets': 'assets.list', '/api/agent/allowlist': 'assets.allowlist',
        }.get(path)
        old_timeout = self.connection.gettimeout()
        try:
            self._agent_guard(verb != 'GET' or path == '/api/agent/proxy')
            if verb == 'OPTIONS':
                return self._send_json(200, {'ok': True, 'data': None})
            if path in ('/api/agent/proxy', '/api/agent/upload') and verb in ('GET', 'POST'):
                _agent_take_rate(self.client_address[0])
            allowed = {
                '/api/agent/proxy': ('GET', 'POST'), '/api/agent/allowlist': ('GET',),
                '/api/agent/assets': ('GET',), '/api/agent/upload': ('POST',),
                '/api/agent/call': ('POST',),
            }
            if path not in allowed:
                raise AgentRequestError('E_NOT_FOUND', 'Unknown agent endpoint.', 404)
            if verb not in allowed[path]:
                raise AgentRequestError('E_UNSUPPORTED', 'Unsupported agent HTTP method.', 405)
            body = {}
            if verb == 'POST':
                limit = (4 * ((AGENT_MAX_BYTES + 2) // 3) + 4096
                         if path == '/api/agent/upload' else AGENT_MAX_BYTES)
                body = self._read_agent_body(limit, deadline)
            if path == '/api/agent/allowlist':
                data = list(AGENT_ALLOWLIST)
            elif path == '/api/agent/assets':
                data = _agent_assets(deadline)
            elif path == '/api/agent/upload':
                data = _agent_upload(body, deadline)
            elif path == '/api/agent/proxy':
                url = body.get('url')
                if verb == 'GET':
                    try:
                        urls = parse_qs(urlsplit(self.path).query, max_num_fields=16).get('url', [])
                    except ValueError:
                        raise AgentRequestError('E_INVALID_ARG', 'Invalid proxy query.') from None
                    if len(urls) != 1:
                        raise AgentRequestError('E_INVALID_ARG', 'Provide exactly one url query parameter.')
                    url = urls[0]
                asset = _agent_proxy(url, deadline)
                self.send_response(200)
                self.send_header('Content-Type', asset['contentType'])
                self.send_header('Content-Length', str(asset['size']))
                self.send_header('Content-Disposition', 'inline')
                self.send_header('Cross-Origin-Resource-Policy', 'same-origin')
                self.send_header('X-Content-Type-Options', 'nosniff')
                self.end_headers()
                self.wfile.write(asset['body'])
                return
            else:
                method, args = body.get('method'), body.get('args', [])
                if not isinstance(method, str) or len(method) > 256 or not isinstance(args, list):
                    raise AgentRequestError('E_INVALID_ARG', 'Provide a public method path and an args array.')
                method = method.removeprefix('agent.')
                parts = method.split('.')
                if any(not re.fullmatch(r'[A-Za-z][A-Za-z0-9_]*', part) or
                       part.lower() in ('prototype', 'constructor', 'token', 'private', 'caller', 'callee', 'arguments')
                       for part in parts):
                    raise AgentRequestError('E_PERMISSION', 'Only public agent method paths are callable.', 403)
                tool_id = method
                remaining = _agent_remaining(deadline)
                response = bridge_hub.send_and_wait({
                    'action': 'agent', 'method': method, 'args': args,
                    'timeoutMs': max(1, int(remaining * 1000)),
                }, timeout=remaining)
                _agent_remaining(deadline)
                if not isinstance(response, dict) or not isinstance(response.get('ok'), bool):
                    if isinstance(response, dict) and 'timeout' in str(response.get('error', '')).lower():
                        raise AgentRequestError('E_TIMEOUT', 'Agent browser call timed out.', 504)
                    raise AgentRequestError('E_DISABLED', 'Agent browser bridge is unavailable.', 503,
                                            'Open the local studio with window.agent initialized.')
                if response['ok']:
                    result = {'ok': True, 'data': response.get('data')}
                else:
                    error = response.get('error')
                    if not isinstance(error, dict) or not all(
                            isinstance(error.get(key), str) for key in ('code', 'message', 'hint')):
                        raise AgentRequestError('E_INVALID_ARG', 'Agent returned an invalid error contract.', 502)
                    result = {'ok': False, 'error': {key: error.get(key) for key in
                                                   ('code', 'message', 'hint', 'toolId')}}
                self.connection.settimeout(_agent_remaining(deadline))
                return self._send_json(200, result)
            self.connection.settimeout(_agent_remaining(deadline))
            return self._send_json(200, {'ok': True, 'data': data})
        except AgentRequestError as error:
            return self._send_json(error.status, _agent_error(error.code, str(error), error.hint, tool_id))
        except (TimeoutError, socket.timeout):
            return self._send_json(504, _agent_error('E_TIMEOUT', 'Agent request timed out.', tool_id=tool_id))
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True
        except Exception:
            # Do not disclose filesystem paths, upstream responses, API keys or exception details.
            return self._send_json(500, _agent_error('E_DISABLED', 'Agent request could not be completed.', tool_id=tool_id))
        finally:
            try:
                self.connection.settimeout(old_timeout)
            except OSError:
                pass

    def _send_json(self, status_code, data, cache_control=None, extra_headers=None, compress=True):
        payload = json.dumps(data, ensure_ascii=False).encode('utf-8')
        use_gzip = bool(compress and len(payload) >= 1024 and _accepts_gzip(self.headers))
        if use_gzip:
            compressed = gzip.compress(payload, compresslevel=5)
            if len(compressed) < len(payload):
                payload = compressed
            else:
                use_gzip = False
        self.send_response(status_code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        if use_gzip:
            self.send_header('Content-Encoding', 'gzip')
            self.send_header('Vary', 'Accept-Encoding')
        if cache_control:
            self.send_header('Cache-Control', cache_control)
            self._skip_default_cache = True
        if extra_headers:
            for hk, hv in extra_headers.items():
                self.send_header(hk, str(hv))
                if hk.lower() == 'cache-control':
                    self._skip_default_cache = True
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        if self.command != 'HEAD':
            _write_all_resilient(self.wfile, payload)

    def _read_raw_body(self, limit=None):
        limit = MAX_JSON_BODY_BYTES if limit is None else limit
        if self.headers.get('Transfer-Encoding'):
            self.close_connection = True
            raise AgentRequestError('E_INVALID_ARG', 'Chunked Transfer-Encoding is unsupported.', 411)
        raw_length = str(self.headers.get('Content-Length', '0') or '0').strip()
        if not raw_length.isdigit():
            raise AgentRequestError('E_INVALID_ARG', 'Invalid Content-Length.', 400)
        length = int(raw_length)
        if length > limit:
            self.close_connection = True
            # Drain only a small oversize margin in bounded 64KB chunks (never buffer
            # megabytes in RAM) so small oversized probes receive 413 cleanly.
            drain_cap = min(limit + 256 * 1024, 4 * 1024 * 1024)
            if length <= drain_cap:
                try:
                    remaining = length
                    while remaining > 0:
                        chunk = self.rfile.read(min(65536, remaining))
                        if not chunk:
                            break
                        remaining -= len(chunk)
                except OSError:
                    pass
            raise AgentRequestError('E_TOO_LARGE', 'Request body exceeds its size limit.', 413)
        if length == 0:
            return b''
        payload = self.rfile.read(length)
        if len(payload) != length:
            raise AgentRequestError('E_INVALID_ARG', 'Incomplete request body.', 400)
        return payload

    def _read_json_body(self, limit=None):
        payload = self._read_raw_body(limit)
        if not payload:
            return {}
        try:
            data = json.loads(payload.decode('utf-8'))
        except (ValueError, UnicodeError):
            raise AgentRequestError('E_INVALID_ARG', 'Invalid JSON body.', 400) from None
        if not isinstance(data, dict):
            raise AgentRequestError('E_INVALID_ARG', 'Request body must be a JSON object.', 400)
        return data

    def _handle_cloud_ai_chat(self):
        if CLOUD is None or not CLOUD.config.enabled:
            return self._send_json(503, {"success": False, "error": {
                "code": "E_CLOUD_DISABLED",
                "message": "Cloud chưa được cấu hình.",
                "hint": "Tạo cloud_config.json từ cloud_config.example.json.",
            }})
        try:
            user = CLOUD.authenticate_request(dict(self.headers.items()), method='POST')
        except Exception as err:
            if isinstance(err, CloudError) or (hasattr(err, 'status') and callable(getattr(err, 'to_dict', None))):
                return self._send_json(int(err.status), err.to_dict())
            raise

        if not self._enforce_rate_limit('ai_chat', 'STUDIO_RL_AI_CHAT_PER_MIN', 30):
            return

        body = self._read_json_body(MAX_JSON_BODY_BYTES)
        byok_key = str(self.headers.get('X-AI-Provider-Key') or '').strip()
        ai_cost = 0 if byok_key else int(CLOUD.config.costs.get('ai_chat', 0))
        charge_key = ''
        model_ref = str(body.get('model') or 'ai').strip()[:80]
        try:
            if ai_cost > 0:
                charge_key = f"ai_chat:{uuid.uuid4().hex}"
                remaining = CLOUD.store.charge(
                    user['id'], ai_cost, 'ai_chat', model_ref, idempotency_key=charge_key
                )
            else:
                remaining = CLOUD.store.balance(user['id'])
        except Exception as err:
            if isinstance(err, CloudError) or (hasattr(err, 'status') and callable(getattr(err, 'to_dict', None))):
                return self._send_json(int(err.status), err.to_dict())
            raise

        ok, status_code, payload_dict = self._execute_ai_proxy(body, byok_key=byok_key)
        if not ok:
            if ai_cost > 0 and charge_key:
                try:
                    CLOUD.store.credit(
                        user['id'], ai_cost, 'refund', model_ref, idempotency_key=f'refund:{charge_key}'
                    )
                except Exception:
                    pass
            return self._send_json(status_code, payload_dict)

        if isinstance(payload_dict, dict):
            payload_dict['cloudCredits'] = remaining
        return self._send_json(200, payload_dict)

    def _handle_cloud(self, method, path):
        try:
            self._api_guard(check_token=False)
        except AgentRequestError as error:
            return self._send_json(error.status, {"success": False, "error": str(error)})

        if method == 'POST' and path == '/api/cloud/ai/chat':
            return self._handle_cloud_ai_chat()

        if CLOUD is None:
            if path == '/api/cloud/status':
                return self._send_json(200, {
                    "success": True, "enabled": False, "provider": "disabled",
                    "error": cloud_error or "Cloud layer unavailable.",
                })
            return self._send_json(503, {"success": False, "error": {
                "code": "E_CLOUD_DISABLED",
                "message": "Cloud chưa được cấu hình.",
                "hint": "Tạo cloud_config.json từ cloud_config.example.json.",
            }})

        raw_body = b''
        if method == 'POST':
            try:
                raw_body = self._read_raw_body(CLOUD.max_body_bytes(path))
            except AgentRequestError as error:
                return self._send_json(error.status, {"success": False, "error": str(error)})

        query = self.path.split('?', 1)[1] if '?' in self.path else ''
        status, out_headers, payload = CLOUD.handle(
            method, path, query, dict(self.headers.items()), raw_body,
            client_ip=self._client_ip(),
        )
        ctype = str(out_headers.get('Content-Type', '') or '').lower()
        already_encoded = any(k.lower() == 'content-encoding' for k in out_headers)
        use_gzip = (
            payload and len(payload) >= 1024 and not already_encoded
            and 'application/json' in ctype and _accepts_gzip(self.headers)
        )
        if use_gzip:
            compressed = gzip.compress(payload, compresslevel=5)
            if len(compressed) < len(payload):
                payload = compressed
            else:
                use_gzip = False
        self.send_response(status)
        for key, value in out_headers.items():
            self.send_header(key, value)
            if key.lower() == 'cache-control':
                self._skip_default_cache = True
        if use_gzip:
            self.send_header('Content-Encoding', 'gzip')
            self.send_header('Vary', 'Accept-Encoding')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        if self.command != 'HEAD' and payload:
            _write_all_resilient(self.wfile, payload)

    @staticmethod
    def _num(body, key, default, minimum=None, maximum=None, integer=False):
        raw = body.get(key, default)
        if raw is None or raw == '':
            raw = default
        if isinstance(raw, bool) or not isinstance(raw, (int, float, str)):
            raise AgentRequestError('E_INVALID_ARG', f'{key} must be a number.', 400)
        try:
            value = float(raw)
        except (TypeError, ValueError):
            raise AgentRequestError('E_INVALID_ARG', f'{key} must be a number.', 400) from None
        if not math.isfinite(value):
            raise AgentRequestError('E_INVALID_ARG', f'{key} must be finite.', 400)
        if integer:
            value = int(value)
        if minimum is not None:
            value = max(minimum, value)
        if maximum is not None:
            value = min(maximum, value)
        return value

    def do_GET(self):
        if self._is_agent_path():
            return self._handle_agent('GET')
        path = self.path.split('?')[0]

        if path == '/healthz':
            return self._send_json(200, {
                "ok": True,
                "status": "healthy",
                "service": "hunger-studio",
                "release": "hunger-motion@0.9.0-beta.2",
                "cloudEnabled": bool(CLOUD and CLOUD.config.enabled),
                "telemetry": True,
                "dist": os.path.basename(os.path.abspath(self.directory)) == 'dist',
            })

        if path in ('/motion', '/motion/', '/landing', '/landing/'):
            self.path = '/motion.html'
            return super().do_GET()

        if path == '/api/telemetry/summary':
            if not _check_telemetry_admin_header(self.headers):
                return self._send_json(401, {"ok": False, "error": "Telemetry admin token required."})
            return self._send_json(200, _telemetry_summary())

        if path == '/api/telemetry/feedback':
            if not _check_telemetry_admin_header(self.headers):
                return self._send_json(401, {"ok": False, "error": "Telemetry admin token required."})
            qs = parse_qs(urlparse(self.path).query)
            limit = int((qs.get('limit') or ['50'])[0]) if str((qs.get('limit') or ['50'])[0]).isdigit() else 50
            category = (qs.get('category') or [''])[0]
            return self._send_json(200, _list_feedback_items(limit=limit, category=category))

        if path.startswith('/api/cloud/'):
            return self._handle_cloud('GET', path)

        if path.startswith('/api/'):
            try:
                self._api_guard()
            except AgentRequestError as error:
                return self._send_json(error.status, {"success": False, "error": str(error)})

        if self._static_blocked():
            return self._send_json(404, {"success": False, "error": "Not found."})

        is_dev_exec_worker = path in {
            '/js/agent/agent-exec-worker.js',
            '/js/ai/copilot-exec-worker.js',
        }
        is_dist_exec_worker = bool(re.fullmatch(
            r'/assets/(?:agent|copilot)-exec-worker-[A-Za-z0-9_-]+\.js', path
        ))
        if is_dev_exec_worker or is_dist_exec_worker:
            if is_dist_exec_worker:
                worker_name = posixpath.basename(path)
                worker_path = os.path.join(self.directory, 'assets', worker_name)
                if not os.path.isfile(worker_path):
                    worker_path = os.path.join(BASE_DIR, 'dist', 'assets', worker_name)
            else:
                worker_subdir = 'ai' if is_dev_exec_worker and path.startswith('/js/ai/') else 'agent'
                worker_name = 'copilot-exec-worker.js' if worker_subdir == 'ai' else 'agent-exec-worker.js'
                worker_path = os.path.join(self.directory, 'js', worker_subdir, worker_name)
                if not os.path.isfile(worker_path):
                    worker_path = os.path.join(BASE_DIR, 'js', worker_subdir, worker_name)
            try:
                with open(worker_path, 'rb') as asset:
                    payload = asset.read()
            except OSError:
                return self._send_json(404, {'ok': False, 'error': {
                    'code': 'E_NOT_FOUND', 'message': 'Exec worker is unavailable.', 'hint': ''}})
            self.send_response(200)
            self.send_header('Content-Type', 'text/javascript; charset=utf-8')
            self.send_header('Content-Security-Policy',
                             "default-src 'none'; script-src 'self' 'unsafe-eval'; connect-src 'none'; "
                             "worker-src 'none'; child-src 'none'; object-src 'none'; "
                             "base-uri 'none'; form-action 'none'")
            self._skip_default_csp = True
            self.send_header('Cross-Origin-Resource-Policy', 'same-origin')
            self.send_header('Cache-Control', 'no-cache')
            self._skip_default_cache = True
            self.send_header('Content-Length', str(len(payload)))
            self.end_headers()
            if self.command != 'HEAD':
                self.wfile.write(payload)
            return

        # REST API: Status
        if path == '/api/status':
            cloud = CLOUD.status() if CLOUD else {"enabled": False, "error": cloud_error}
            return self._send_json(200, {
                "success": True,
                "server": "Web Blender Studio 2.0",
                "connectedBrowsers": bridge_hub.client_count(),
                "wsPort": getattr(self.server, "ws_port", 8082),
                "httpPort": getattr(self.server, "server_port", 8080),
                "provider": bridge_hub.config.get("provider", "offline"),
                "cloud": {
                    "enabled": bool(cloud.get("enabled")),
                    "provider": cloud.get("provider"),
                    "storage": cloud.get("storage"),
                },
            })

        # REST API: Config (browser-safe view only)
        if path == '/api/config':
            return self._send_json(200, public_config())

        # REST API: Get Scene
        if path == '/api/scene':
            res = bridge_hub.send_and_wait({"action": "get_scene"})
            return self._send_json(200 if res.get("success") else 503, res)

        # REST API: Mocap engine health (used by the Mocap panel)
        if path == '/api/mocap/health':
            _mocap_module = ensure_mocap_engine()
            engine = getattr(_mocap_module, 'mocap_engine', None) if _mocap_module else None
            available = bool(_mocap_module and getattr(_mocap_module, 'MEDIAPIPE_AVAILABLE', False))
            model = getattr(engine, 'model_path', '') if engine else ''
            return self._send_json(200, {
                "success": True,
                "available": available,
                "model": os.path.basename(model) if model else "",
                "error": None if available else (mocap_engine_error or "mediapipe/opencv not installed"),
                "hint": "Chạy server bằng .venv Python 3.11: .venv/bin/python server.py (đã cài mediapipe + opencv-python-headless)."
            })

        # REST API: Mocap live tracking progress
        if path == '/api/mocap/progress':
            _mocap_module = ensure_mocap_engine()
            engine = getattr(_mocap_module, 'mocap_engine', None) if _mocap_module else None
            prog = engine.get_progress() if (engine and hasattr(engine, 'get_progress')) else {
                "active": False, "stage": "idle", "processed": 0, "total": 0, "percent": 0.0, "fps": 0.0, "etaSec": 0.0
            }
            return self._send_json(200, {"success": True, **prog})

        # REST API: Available Mocap Sample & Uploaded Videos
        if path == '/api/mocap/samples':
            samples = [
                {"id": "shuffle", "name": "Shuffle Dance (shuffle_dance.mp4)", "file": "models/shuffle_dance.mp4", "desc": "Full-body shuffle dance routine (20s)"},
                {"id": "guitarist", "name": "Guitarist Motion (sample_human_motion.webm)", "file": "models/sample_human_motion.webm", "desc": "Upper body & guitar strumming motion (56s)"},
                {"id": "aerobics", "name": "Aerobics Workout (aerobics_exercise.webm)", "file": "models/aerobics_exercise.webm", "desc": "Full-body fitness squats and jumps (12s)"},

            ]
            models_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models")
            if os.path.isdir(models_dir):
                known = {s["file"] for s in samples}
                for fn in sorted(os.listdir(models_dir)):
                    if fn.lower().endswith((".mp4", ".webm", ".mov")) and f"models/{fn}" not in known:
                        full_path = os.path.join(models_dir, fn)
                        if not os.path.isfile(full_path):
                            continue
                        samples.append({
                            "id": os.path.splitext(fn)[0],
                            "name": f"Uploaded: {fn}",
                            "file": f"models/{fn}",
                            "desc": "Custom uploaded video"
                        })
            return self._send_json(200, {"success": True, "samples": samples})

        # REST API: Hunyuan3D Status & Health
        if path == '/api/hunyuan3d/status':
            if hunyuan3d_engine:
                status = hunyuan3d_engine.hunyuan_engine.get_status()
                cfg = dict(status.get("config") or {})
                token = str(cfg.pop("hfToken", "") or "")
                cfg.pop("providerKey", None)
                cfg.pop("endpoint", None)
                cfg.pop("localRepoPath", None)
                cfg.pop("colabUrl", None)
                cfg["hfTokenConfigured"] = bool(token) or bool(cfg.get("hfTokenConfigured"))
                status["config"] = cfg
                return self._send_json(200, status)
            return self._send_json(500, {"success": False, "maintenance": True, "error": "Image-to-3D engine is unavailable."})

        # REST API: Hunyuan3D Reference Samples
        if path == '/api/hunyuan3d/samples':
            if hunyuan3d_engine:
                return self._send_json(200, {"success": True, "samples": hunyuan3d_engine.hunyuan_engine.get_samples()})
            return self._send_json(500, {"success": False, "error": "Hunyuan3D engine not loaded"})

        # REST API: Hunyuan3D Generation Progress
        if path == '/api/hunyuan3d/progress':
            if hunyuan3d_engine:
                return self._send_json(200, {"success": True, **hunyuan3d_engine.hunyuan_engine.get_progress()})
            return self._send_json(500, {"success": False, "error": "Hunyuan3D engine not loaded"})

        if path == '/api/screenshot':
            res = bridge_hub.send_and_wait({"action": "screenshot"})
            return self._send_json(200 if res.get("success") else 503, res)

        if path == '/api/import/blend/status':
            if not blend_converter:
                return self._send_json(500, {"success": False, "available": False, "error": "blend_converter module missing"})
            probe = blend_converter.find_blender_binary()
            return self._send_json(200, {
                "success": True,
                "available": bool(probe.get("available")),
                "version": probe.get("version"),
                "error": probe.get("error"),
            })

        if path == '/api/tts':
            from urllib.parse import parse_qs
            qs = parse_qs(self.path.split('?', 1)[1] if '?' in self.path else '')
            text = (qs.get('text', [''])[0] or '').strip()
            lang = (qs.get('lang', ['vi'])[0] or 'vi').strip()[:10]
            try:
                return self._handle_tts(text, lang)
            except AgentRequestError as error:
                return self._send_json(error.status, {"success": False, "error": str(error)})

        # Fallback to static file serving (with byte-range support, then cached+gzip static)
        if self._try_serve_range(head_only=False):
            return
        if self._serve_cached_static(head_only=False):
            return
        return super().do_GET()

    def _client_ip(self):
        if self._is_trusted_proxy():
            xff = str(self.headers.get('X-Forwarded-For') or '').strip()
            if xff:
                first_ip = xff.split(',')[0].strip()
                try:
                    ipaddress.ip_address(first_ip)
                    return first_ip
                except ValueError:
                    pass
        return self.client_address[0] if self.client_address else 'unknown'

    def _enforce_rate_limit(self, bucket, env_name, default_limit, window_sec=60.0):
        limit = _env_int(env_name, default_limit)
        allowed, retry_after = _RATE_LIMITER.allow(bucket, self._client_ip(), limit, window_sec)
        if not allowed:
            self._send_json(
                429,
                {
                    "success": False,
                    "error": "Quá nhiều yêu cầu trong thời gian ngắn. Vui lòng thử lại sau.",
                    "retryAfter": retry_after,
                },
                extra_headers={"Retry-After": str(retry_after)},
            )
            return False
        return True

    def _synthesize_tts_clauses(self, clauses, safe_lang):
        """Synthesize TTS via officially configured STUDIO_TTS_ENDPOINT (no scraping)."""
        endpoint = str(os.environ.get('STUDIO_TTS_ENDPOINT') or '').strip()
        if not endpoint:
            return None
        try:
            parsed = urlsplit(endpoint)
        except ValueError:
            return None
        host = (parsed.hostname or '').lower()
        if parsed.scheme not in ('http', 'https') or not host or host in AI_FORBIDDEN_HOSTS:
            return None

        import urllib.request

        api_key = str(os.environ.get('STUDIO_TTS_API_KEY') or '').strip()
        voice = str(os.environ.get('STUDIO_TTS_VOICE') or 'alloy').strip()[:40]
        chunks = []
        for clause in clauses:
            headers = {
                'Content-Type': 'application/json',
                'User-Agent': 'WebBlenderStudio/2.0',
            }
            if api_key:
                headers['Authorization'] = f'Bearer {api_key}'
            body = json.dumps({
                'input': clause,
                'language': safe_lang,
                'voice': voice,
            }).encode('utf-8')
            req = urllib.request.Request(endpoint, data=body, headers=headers, method='POST')
            with urllib.request.urlopen(req, timeout=8) as resp:
                chunk = resp.read()
                if chunk:
                    chunks.append(chunk)
        return b''.join(chunks) if chunks else None

    def _handle_tts(self, raw_text, lang='vi'):
        text = str(raw_text or '').strip()
        # Strip markdown formatting for clean natural reading
        text = re.sub(r'`([^`]+)`', r'\1', text)
        text = re.sub(r'\*\*([^*]+)\*\*', r'\1', text)
        text = re.sub(r'\*([^*]+)\*', r'\1', text)
        text = text.replace('->', ' vào ').replace('→', ' vào ')
        text = re.sub(r'\s+', ' ', text).strip()

        if not text:
            raise AgentRequestError('E_INVALID_ARG', 'text is required for TTS.', 400)
        if len(text) > 1200:
            text = text[:1200]

        if not self._enforce_rate_limit('tts', 'STUDIO_RL_TTS_PER_MIN', 120):
            return

        safe_lang = 'vi' if not lang or not re.match(r'^[a-zA-Z-]{2,8}$', lang) else lang
        cache_key = hashlib.sha256(f"{safe_lang}:{text}".encode('utf-8')).hexdigest()[:32]
        cache_dir = os.path.join(BASE_DIR, 'cloud_data', 'tts_cache')
        os.makedirs(cache_dir, exist_ok=True)
        cache_path = os.path.join(cache_dir, f"{cache_key}.mp3")

        def _read_disk_cache():
            try:
                if os.path.isfile(cache_path) and os.path.getsize(cache_path) > 128:
                    with open(cache_path, 'rb') as f:
                        data = f.read()
                    if data:
                        _TTS_MEM_CACHE.put(cache_key, data)
                        return data
            except OSError:
                pass
            return None

        audio_bytes = _TTS_MEM_CACHE.get(cache_key) or _read_disk_cache()

        if not audio_bytes:
            with _TTS_INFLIGHT_LOCK:
                inflight = _TTS_INFLIGHT.get(cache_key)
                is_leader = inflight is None
                if is_leader:
                    inflight = {"event": threading.Event(), "audio": None}
                    _TTS_INFLIGHT[cache_key] = inflight

            if not is_leader:
                inflight["event"].wait(timeout=15.0)
                audio_bytes = inflight.get("audio") or _TTS_MEM_CACHE.get(cache_key) or _read_disk_cache()
            else:
                try:
                    audio_bytes = _TTS_MEM_CACHE.get(cache_key) or _read_disk_cache()
                    if not audio_bytes:
                        # Split text into natural clauses <= 180 chars for fast neural synthesis
                        clauses = []
                        for part in re.split(r'(?<=[.!?।;:\n])\s+', text):
                            part = part.strip()
                            if not part:
                                continue
                            while len(part) > 180:
                                cut = part.rfind(',', 0, 180)
                                if cut < 40:
                                    cut = part.rfind(' ', 0, 180)
                                if cut < 20:
                                    cut = 180
                                clauses.append(part[:cut].strip())
                                part = part[cut:].lstrip(' ,')
                            if part:
                                clauses.append(part)

                        if not _TTS_SEMAPHORE.acquire(timeout=2.0):
                            return self._send_json(
                                503,
                                {
                                    "success": False,
                                    "error": "TTS service busy; use client fallback.",
                                },
                                extra_headers={"Retry-After": "2"},
                            )
                        try:
                            audio_bytes = self._synthesize_tts_clauses(
                                clauses or [text[:180]], safe_lang
                            )
                        except Exception as exc:
                            _safe_log(f"[TTS] Neural stream fallback notice: {exc}")
                            audio_bytes = None
                        finally:
                            _TTS_SEMAPHORE.release()

                        if audio_bytes:
                            _TTS_MEM_CACHE.put(cache_key, audio_bytes)
                            tmp_path = f"{cache_path}.{threading.get_ident()}.tmp"
                            try:
                                with open(tmp_path, 'wb') as f:
                                    f.write(audio_bytes)
                                os.replace(tmp_path, cache_path)
                            except OSError:
                                try:
                                    if os.path.exists(tmp_path):
                                        os.remove(tmp_path)
                                except OSError:
                                    pass
                    inflight["audio"] = audio_bytes
                finally:
                    with _TTS_INFLIGHT_LOCK:
                        if _TTS_INFLIGHT.get(cache_key) is inflight:
                            del _TTS_INFLIGHT[cache_key]
                    inflight["event"].set()

        if not audio_bytes:
            return self._send_json(503, {
                "success": False,
                "error": "Neural TTS stream unavailable; use client fallback.",
            })

        self.send_response(200)
        self.send_header('Content-Type', 'audio/mpeg')
        self.send_header('Cache-Control', 'public, max-age=86400')
        self.send_header('X-TTS-Cache', cache_key)
        self.send_header('Content-Length', str(len(audio_bytes)))
        self._skip_default_cache = True
        self.end_headers()
        if self.command != 'HEAD':
            _write_all_resilient(self.wfile, audio_bytes)
        return

    def do_POST(self):
        if self._is_agent_path():
            return self._handle_agent('POST')
        try:
            return self._do_post()
        except AgentRequestError as error:
            try:
                return self._send_json(error.status, {"success": False, "error": str(error)})
            except (BrokenPipeError, ConnectionResetError):
                self.close_connection = True
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True
        except Exception:
            _safe_traceback()
            try:
                return self._send_json(500, {"success": False, "error": "Request failed."})
            except (BrokenPipeError, ConnectionResetError):
                self.close_connection = True

    def _do_post(self):
        path = self.path.split('?')[0]
        if path.startswith('/api/cloud/'):
            return self._handle_cloud('POST', path)
        self._api_guard()
        upload_paths = ('/api/mocap/upload', '/api/hunyuan3d/upload', '/api/import/blend')
        body = self._read_json_body(MAX_UPLOAD_BODY_BYTES if path in upload_paths else MAX_JSON_BODY_BYTES)

        if path == '/api/telemetry/event':
            events = body.get('events', []) if isinstance(body, dict) else []
            accepted = _record_telemetry_events(events, body.get('sessionId', '') if isinstance(body, dict) else '')
            return self._send_json(202, {
                "ok": True,
                "accepted": accepted,
            })

        if path == '/api/telemetry/feedback':
            item = _record_feedback_item(body if isinstance(body, dict) else {}, self.headers.get('User-Agent', ''))
            if not item:
                return self._send_json(400, {"ok": False, "error": "Please provide at least 3 characters of feedback."})
            return self._send_json(201, {"ok": True, "id": item['id'], "persisted": True})

        # REST API: Headless Blender .blend -> .glb conversion
        if path == '/api/import/blend':
            if not self._enforce_rate_limit('heavy', 'STUDIO_RL_HEAVY_PER_MIN', 12):
                return
            if not blend_converter:
                return self._send_json(500, {"success": False, "error": "blend_converter not loaded"})
            file_data = body.get("fileData", "")
            file_name = str(body.get("fileName", "model.blend") or "model.blend")
            apply_mods = bool(body.get("applyModifiers", False))
            if not isinstance(file_data, str) or not file_data:
                raise AgentRequestError('E_INVALID_ARG', 'No fileData provided.', 400)
            if "," in file_data:
                file_data = file_data.split(",", 1)[1]
            if not file_name.lower().endswith(".blend"):
                raise AgentRequestError('E_UNSUPPORTED', 'Expected a .blend file.', 415)
            try:
                raw_bytes = base64.b64decode(file_data, validate=True)
            except (ValueError, binascii.Error):
                raise AgentRequestError('E_INVALID_ARG', 'fileData is not valid base64.', 400) from None
            if len(raw_bytes) > MAX_UPLOAD_BYTES:
                raise AgentRequestError('E_TOO_LARGE', '.blend exceeds the upload limit.', 413)
            if not _HEAVY_JOB_SEMAPHORE.acquire(timeout=0.05):
                return self._send_json(
                    503,
                    {"success": False, "error": "Server đang xử lý tác vụ nặng khác. Vui lòng thử lại sau ít giây."},
                    extra_headers={"Retry-After": "5"},
                )
            try:
                res = blend_converter.convert_blend_bytes_to_glb(raw_bytes, apply_modifiers=apply_mods)
            except blend_converter.BlenderNotAvailableError as exc:
                return self._send_json(503, {
                    "success": False,
                    "code": "BLENDER_NOT_INSTALLED",
                    "error": str(exc),
                    "hint": "Install Blender 3.6+/4.x or set BLENDER_BIN=/path/to/blender before restarting server.py.",
                })
            except blend_converter.BlendValidationError as exc:
                return self._send_json(415, {"success": False, "code": "INVALID_BLEND", "error": str(exc)})
            except blend_converter.BlendConversionError as exc:
                return self._send_json(422, {"success": False, "code": "CONVERSION_FAILED", "error": str(exc)})
            finally:
                _HEAVY_JOB_SEMAPHORE.release()
            glb_b64 = base64.b64encode(res["glbBytes"]).decode("ascii")
            return self._send_json(200, {
                "success": True,
                "fileName": os.path.splitext(os.path.basename(file_name))[0] + ".glb",
                "size": len(res["glbBytes"]),
                "glbBase64": glb_b64,
                "report": res.get("report") or {},
                "blenderVersion": res.get("blenderVersion"),
            })

        # REST API: Video Mocap Tracking
        if path == '/api/mocap/track':
            if not self._enforce_rate_limit('heavy', 'STUDIO_RL_HEAVY_PER_MIN', 12):
                return
            video_rel = body.get("videoPath", "models/sample_human_motion.webm")
            if not isinstance(video_rel, str) or not video_rel.strip():
                raise AgentRequestError('E_INVALID_ARG', 'videoPath must be a non-empty string.', 400)
            video_rel_norm = video_rel.strip().replace('\\', '/')
            if os.path.isabs(video_rel) or video_rel_norm.startswith('/') or '..' in video_rel_norm.split('/'):
                raise AgentRequestError('E_PERMISSION', 'videoPath must stay within models/.', 403)
            rel_inside = video_rel_norm[len('models/'):] if video_rel_norm.startswith('models/') else video_rel_norm
            if not rel_inside or '/' in rel_inside:
                raise AgentRequestError('E_PERMISSION', 'videoPath must reference a file directly inside models/.', 403)
            ext = os.path.splitext(rel_inside)[1].lower()
            if ext not in MOCAP_VIDEO_EXTENSIONS:
                raise AgentRequestError(
                    'E_UNSUPPORTED', 'Unsupported video extension.', 415,
                    'Allowed: ' + ', '.join(sorted(MOCAP_VIDEO_EXTENSIONS)))
            models_root = os.path.realpath(MODELS_DIR)
            candidate_path = os.path.join(MODELS_DIR, rel_inside)
            video_full = os.path.realpath(candidate_path)
            if os.path.islink(candidate_path) or os.path.commonpath([models_root, video_full]) != models_root:
                raise AgentRequestError('E_PERMISSION', 'Unsafe videoPath outside models/.', 403)
            if not os.path.isfile(video_full):
                return self._send_json(404, {"success": False, "error": f"Video file not found: models/{rel_inside}"})

            _mocap_module = ensure_mocap_engine()
            if not _mocap_module:
                return self._send_json(500, {
                    "success": False,
                    "error": f"MediaPipe chưa sẵn sàng: {mocap_engine_error or 'mocap_engine không khởi tạo được'}",
                    "hint": "Cài đặt: python3.11 -m venv .venv && .venv/bin/pip install mediapipe opencv-python-headless, sau đó chạy .venv/bin/python server.py"
                })
            
            raw_max = body.get("maxFrames", 0)
            if raw_max in (None, "", "all", "full"):
                max_frames = 0
            else:
                max_frames = int(self._num(body, "maxFrames", 0, 0, 100000, integer=True))
            frame_step = int(self._num(body, "frameStep", 1, 1, 30, integer=True))
            min_cutoff = self._num(body, "minCutoff", 1.35, 0.01, 100.0)
            beta = self._num(body, "beta", 0.04, 0.0, 10.0)
            
            if not _HEAVY_JOB_SEMAPHORE.acquire(timeout=0.05):
                return self._send_json(
                    503,
                    {"success": False, "error": "Server đang xử lý video Mocap khác. Vui lòng thử lại sau ít giây."},
                    extra_headers={"Retry-After": "5"},
                )
            mode_label = "FULL VIDEO" if max_frames <= 0 else f"maxFrames={max_frames}"
            _safe_log(f"[Server Mocap] Starting pose tracking on {video_rel} ({mode_label}, frameStep={frame_step})...")
            try:
                res = _mocap_module.mocap_engine.process_video(
                    video_full,
                    max_frames=max_frames,
                    frame_step=frame_step,
                    min_cutoff=min_cutoff,
                    beta=beta,
                )
            except Exception as e:
                _safe_log(f"[Server Mocap] Tracking crashed: {e}")
                return self._send_json(500, {"success": False, "error": f"Lỗi xử lý video: {e}"})
            finally:
                _HEAVY_JOB_SEMAPHORE.release()
            _safe_log(f"[Server Mocap] Pose tracking completed. Success={res.get('success')}")
            return self._send_json(200 if res.get("success") else 400, res)

        # REST API: Mocap Video Upload (allowlisted video types, generated safe name)
        if path == '/api/mocap/upload':
            file_data = body.get("fileData", "")
            file_name = body.get("fileName", "uploaded_mocap.webm")
            if not isinstance(file_data, str) or not file_data:
                raise AgentRequestError('E_INVALID_ARG', 'No fileData provided.', 400)
            if "," in file_data:
                file_data = file_data.split(",", 1)[1]
            ext = os.path.splitext(str(file_name))[1].lower() or ".webm"
            if ext not in MOCAP_VIDEO_EXTENSIONS:
                raise AgentRequestError(
                    'E_UNSUPPORTED', 'Unsupported video extension.', 415,
                    'Allowed: ' + ', '.join(sorted(MOCAP_VIDEO_EXTENSIONS)))
            try:
                raw_bytes = base64.b64decode(file_data, validate=True)
            except (ValueError, binascii.Error):
                raise AgentRequestError('E_INVALID_ARG', 'fileData is not valid base64.', 400) from None
            if len(raw_bytes) > MAX_UPLOAD_BYTES:
                raise AgentRequestError('E_TOO_LARGE', 'Video exceeds the upload limit.', 413)
            os.makedirs(MODELS_DIR, exist_ok=True)
            if os.path.islink(MODELS_DIR):
                raise AgentRequestError('E_PERMISSION', 'Unsafe asset storage directory.', 403)
            _cleanup_old_mocap_uploads(MODELS_DIR)
            safe_name = f"uploaded_mocap_{uuid.uuid4().hex[:12]}{ext}"
            target_rel = f"models/{safe_name}"
            target_full = os.path.join(MODELS_DIR, safe_name)
            with open(target_full, "wb") as f:
                f.write(raw_bytes)
            _safe_log(f"[Server Mocap] Uploaded video saved to {target_rel} ({len(raw_bytes)} bytes)")
            return self._send_json(200, {
                "success": True, "videoPath": target_rel, "fileName": safe_name, "size": len(raw_bytes),
            })

        # REST API: Hunyuan3D Upload Input Image
        if path == '/api/hunyuan3d/upload':
            if not hunyuan3d_engine:
                return self._send_json(500, {"success": False, "error": "Hunyuan3D engine not loaded"})
            file_data = body.get("fileData", "")
            file_name = body.get("fileName", "input_image.png")
            slot = body.get("slot", None)
            if not file_data:
                return self._send_json(400, {"success": False, "error": "No fileData provided"})
            try:
                res = hunyuan3d_engine.hunyuan_engine.save_uploaded_image(file_data, file_name, slot=slot)
                return self._send_json(200, res)
            except ValueError as e:
                return self._send_json(getattr(e, 'status', 415), {"success": False, "error": str(e)})
            except Exception:
                _safe_traceback()
                return self._send_json(500, {"success": False, "error": "Failed to save uploaded image."})

        # REST API: Hunyuan3D Synthesize 4-View Orthographics (Spatial Reasoning)
        if path == '/api/hunyuan3d/synthesize-multiview':
            if not hunyuan3d_engine:
                return self._send_json(500, {"success": False, "error": "Hunyuan3D engine not loaded"})
            image_path = body.get("imagePath", "")
            if not image_path:
                return self._send_json(400, {"success": False, "error": "imagePath is required"})
            try:
                res = hunyuan3d_engine.hunyuan_engine.reason_and_synthesize_multiview(image_path)
                return self._send_json(200 if res.get("success") else 500, res)
            except ValueError as e:
                return self._send_json(getattr(e, 'status', 400), {"success": False, "error": str(e)})
            except FileNotFoundError as e:
                return self._send_json(404, {"success": False, "error": str(e)})
            except Exception as e:
                return self._send_json(500, {"success": False, "error": str(e)})

        # REST API: Hunyuan3D Generate 3D Model
        if path == '/api/hunyuan3d/generate':
            if not hunyuan3d_engine:
                return self._send_json(500, {"success": False, "maintenance": True, "error": "Image-to-3D engine is unavailable."})
            image_path = body.get("imagePath", "")
            if not image_path:
                return self._send_json(400, {"success": False, "error": "imagePath is required"})
            options = body.get("options", {})
            res = hunyuan3d_engine.hunyuan_engine.start_generation(image_path, options)
            code = 200 if res.get("success") else (503 if res.get("maintenance") else int(res.get("status") or 400))
            return self._send_json(code, res)

        # REST API: Hunyuan3D Update Config
        if path == '/api/hunyuan3d/config':
            if not hunyuan3d_engine:
                return self._send_json(500, {"success": False, "error": "Image-to-3D engine is unavailable."})
            ok = hunyuan3d_engine.hunyuan_engine.save_config(body)
            cfg = hunyuan3d_engine.hunyuan_engine._public_config()
            return self._send_json(200 if ok else 500, {"success": ok, "config": cfg})

        if path == '/api/execute':
            code = body.get("code", "")
            timeout = self._num(body, "timeout", 120.0, 1.0, 600.0)
            timeout_ms = int(max(1000, min(120000, round(timeout * 1000))))
            payload = {"action": "execute", "code": code, "timeout": timeout_ms, "timeoutMs": timeout_ms}
            if body.get("privileged") is True:
                payload["privileged"] = True
            res = bridge_hub.send_and_wait(payload, timeout=timeout)
            return self._send_json(200 if res.get("success") else 500, res)

        # REST API: Generate 3D Model via Copilot
        if path == '/api/generate':
            prompt = body.get("prompt", "")
            res = bridge_hub.send_and_wait({"action": "generate", "prompt": prompt})
            return self._send_json(200 if res.get("success") else 500, res)

        # REST API: Export Scene (OBJ, STL, JSON)
        if path == '/api/export':
            fmt = body.get("format", "obj")
            res = bridge_hub.send_and_wait({"action": "export", "format": fmt})
            return self._send_json(200 if res.get("success") else 500, res)

        # REST API: Select Object
        if path == '/api/select':
            name = body.get("name", "")
            res = bridge_hub.send_and_wait({"action": "select", "name": name})
            return self._send_json(200 if res.get("success") else 404, res)

        # REST API: Clear Scene
        if path == '/api/clear':
            res = bridge_hub.send_and_wait({"action": "clear"})
            return self._send_json(200 if res.get("success") else 500, res)

        # REST API: Update Config
        if path == '/api/config':
            secret_fields = {"geminiKey", "openAiKey", "customKey"}
            for k in ["geminiKey", "geminiModel", "openAiKey", "openAiModel", "customKey", "customModel", "provider"]:
                if k in body:
                    value = str(body[k]).strip()
                    if k in secret_fields and not value:
                        continue  # empty means "keep the stored secret"
                    bridge_hub.config[k] = value
            if "customKeys" in body:
                raw_keys = body["customKeys"]
                if isinstance(raw_keys, str):
                    raw_keys = [k.strip() for k in raw_keys.replace(',', '\n').split('\n')]
                if isinstance(raw_keys, list):
                    clean_keys = [str(k).strip() for k in raw_keys if str(k).strip() and not str(k).strip().startswith("sk-DIEN_")]
                    if clean_keys:
                        existing = bridge_hub.get_motapis_keys()
                        for ck in clean_keys:
                            if ck not in existing:
                                existing.append(ck)
                        bridge_hub.config["customKeys"] = existing
            provider = str(bridge_hub.config.get("provider") or "motapis").strip().lower()
            if provider == "offline" or provider not in ("motapis", "custom", "gemini", "openai"):
                bridge_hub.config["provider"] = "motapis" if bridge_hub.get_motapis_keys() else "gemini"
            bridge_hub.save_config()
            return self._send_json(200, {"success": True, "config": public_config()})

        if path == '/api/ai/chat':
            if not self._enforce_rate_limit('ai_chat', 'STUDIO_RL_AI_CHAT_PER_MIN', 30):
                return
            byok_key = str(self.headers.get('X-AI-Provider-Key') or '').strip()
            ok, status_code, payload_dict = self._execute_ai_proxy(body, byok_key=byok_key)
            if not ok and status_code == 503 and isinstance(payload_dict, dict):
                return self._send_json(503, payload_dict, extra_headers={"Retry-After": "3"})
            return self._send_json(status_code, payload_dict)

        if path == '/api/tts':
            text = str(body.get("text") or "").strip()
            lang = str(body.get("lang") or "vi").strip()[:10]
            return self._handle_tts(text, lang)

        return self._send_json(404, {"success": False, "error": f"Endpoint not found: {path}"})

    def _execute_ai_proxy(self, body, byok_key=''):
        if 'endpoint' in body:
            raise AgentRequestError(
                'E_INVALID_ARG',
                'endpoint cannot be overridden; configure it server-side (ai_config.json).', 400)

        provider = str(body.get("provider") or bridge_hub.config.get("provider") or "motapis").strip().lower()
        if provider == "custom":
            provider = "motapis"
        if provider not in ("motapis", "openai", "gemini"):
            raise AgentRequestError('E_INVALID_ARG', 'Unknown AI provider.', 400)

        messages = _validate_messages(body.get("messages"))
        temperature = self._num(body, "temperature", 0.35, 0.0, 2.0)
        max_tokens = int(self._num(body, "max_tokens", 12288, 256, 16384))

        base, raw_keys, default_model = _ai_endpoint_for(provider)
        byok_clean = str(byok_key or '').strip()
        keys = [byok_clean] if byok_clean else [str(k).strip() for k in raw_keys if str(k).strip()]
        if not keys:
            raise AgentRequestError(
                'E_INVALID_ARG',
                'Nguồn AI đã chọn hiện chưa sẵn sàng trên máy chủ. Vui lòng chọn nguồn AI khác trong Cài đặt hoặc nhập BYOK key.', 400)

        endpoint = _validated_ai_url(base)
        model = str(body.get("model") or default_model).strip()[:120] or default_model
        payload = json.dumps({
            "model": model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
        }).encode('utf-8')

        if not _AI_CHAT_SEMAPHORE.acquire(timeout=0.5):
            return False, 503, {
                "success": False,
                "error": "Máy chủ AI đang quá tải kết nối đồng thời. Vui lòng thử lại sau vài giây.",
            }

        import urllib.request
        import urllib.error

        now_mono = time.monotonic()
        if not hasattr(bridge_hub, "_key_cooldowns") or not isinstance(bridge_hub._key_cooldowns, dict):
            bridge_hub._key_cooldowns = {}
        cooldowns = bridge_hub._key_cooldowns
        deprioritized = set() if byok_clean else getattr(bridge_hub, "_deprioritized_keys", set())

        if byok_clean:
            ordered_keys = keys
        else:
            # Prune expired cooldowns and always try healthy keys first.
            for k in list(cooldowns.keys()):
                if cooldowns[k] <= now_mono:
                    del cooldowns[k]
            ordered_keys = [
                k for _, k in sorted(
                    enumerate(keys),
                    key=lambda item: (
                        1 if (item[1] in deprioritized or cooldowns.get(item[1], 0.0) > now_mono) else 0,
                        cooldowns.get(item[1], 0.0),
                        item[0],
                    ),
                )
            ]

        req_timeout = 95 if len(ordered_keys) > 1 else 135
        primary_code = None
        primary_detail = ""
        last_code = 502
        last_detail = "Unknown error"

        try:
            for idx, key in enumerate(ordered_keys):
                key_label = "BYOK" if byok_clean else f"key #{idx + 1}"
                _safe_log(f"[AI Proxy] {provider} {key_label} -> {endpoint} (model {model})")
                req = urllib.request.Request(
                    endpoint,
                    data=payload,
                    headers={
                        "Content-Type": "application/json",
                        "Authorization": f"Bearer {key}",
                        "User-Agent": "WebBlenderStudio/2.0",
                    },
                )
                try:
                    with urllib.request.urlopen(req, timeout=req_timeout) as resp:
                        resp_data = json.loads(resp.read().decode('utf-8'))
                    if not byok_clean:
                        deprioritized.discard(key)
                        cooldowns.pop(key, None)
                    return True, 200, resp_data
                except urllib.error.HTTPError as err:
                    last_code = err.code
                    try:
                        detail = err.read().decode('utf-8', errors='replace')[:400]
                    except Exception:
                        detail = ''
                    last_detail = f"HTTP {err.code}: {detail}"
                    if primary_code is None:
                        primary_code = err.code
                        primary_detail = detail
                    low = detail.lower()
                    if not byok_clean:
                        if err.code in (401, 403) or "insufficient_user_quota" in low or "remaining $0.000000" in low:
                            deprioritized.add(key)
                            cooldowns[key] = time.monotonic() + 1800.0
                        elif err.code == 429 or "rate" in low:
                            cooldowns[key] = time.monotonic() + 90.0
                        elif err.code >= 500:
                            cooldowns[key] = time.monotonic() + 30.0
                    _safe_log(f"[AI Proxy] {key_label} failed: {last_detail}")
                except Exception as error:
                    last_code = 502
                    last_detail = str(error)[:300]
                    if primary_code is None:
                        primary_code = 502
                        primary_detail = last_detail
                    if not byok_clean and len(ordered_keys) > 1:
                        cooldowns[key] = time.monotonic() + 30.0
                    _safe_log(f"[AI Proxy] {key_label} failed: {last_detail}")
        finally:
            _AI_CHAT_SEMAPHORE.release()

        rep_code = primary_code if primary_code is not None else last_code
        rep_low = (primary_detail or last_detail).lower()
        if rep_code == 404:
            friendly = f"Model '{model}' không còn khả dụng. Vui lòng chọn model khác trong Cài đặt AI."
        elif rep_code == 429 or "quota" in rep_low or "rate" in rep_low or "insufficient" in rep_low:
            friendly = f"Model '{model}' đang chạm giới hạn gói miễn phí hoặc hết hạn mức. Vui lòng thử lại sau hoặc đổi sang Gemini 3.5 Flash-Lite / Claude Sonnet 4.6."
        elif rep_code in (401, 403):
            friendly = f"Nguồn AI hiện tại không hỗ trợ hoặc chưa cấp quyền cho model '{model}'. Vui lòng đổi sang model hoặc nguồn AI khác."
        else:
            friendly = f"Máy chủ AI đang bận hoặc phản hồi chậm cho model '{model}'. Vui lòng thử lại sau hoặc chọn model nhanh hơn."

        out_status = rep_code if rep_code in (400, 401, 403, 404, 429) else 502
        return False, out_status, {"success": False, "error": friendly}

    def log_error(self, format, *args):
        if getattr(self, '_awaiting_keepalive_next', False) and 'timed out' in str(format).lower():
            return
        try:
            super().log_error(format, *args)
        except (OSError, ValueError):
            pass

    def log_message(self, format, *args):
        code = str(args[1]) if len(args) > 1 else ''
        verbose = os.environ.get('STUDIO_ACCESS_LOG', '0') == '1'
        if not verbose and not code.startswith(('4', '5')):
            return
        try:
            sys.stderr.write(f"[{self.log_date_time_string()}] {args[0]} -> {code}\n")
        except (OSError, ValueError):
            pass

# =============================================================================
# SERVER ENTRY POINT
# =============================================================================

def run_server(port=8080, ws_port=8082, host=None, token=None, serve_dir=None, use_dist=False):
    global BIND_HOST, STUDIO_TOKEN
    script_dir = BASE_DIR
    os.chdir(script_dir)

    if serve_dir:
        target_dir = serve_dir if os.path.isabs(serve_dir) else os.path.join(script_dir, serve_dir)
    elif use_dist:
        target_dir = os.path.join(script_dir, 'dist')
    else:
        target_dir = script_dir
    target_dir = os.path.abspath(target_dir)
    if not os.path.isdir(target_dir):
        print(
            f"[Server] Serve directory does not exist: {target_dir}\n"
            + ("         Run `npm run build` first before using --dist." if use_dist else ""),
            file=sys.stderr, flush=True,
        )
        raise SystemExit(2)

    bind = (host or BIND_HOST or "127.0.0.1").strip()
    if token is not None:
        STUDIO_TOKEN = str(token).strip()
    loopback = bind in ("127.0.0.1", "localhost", "::1")
    if not loopback and not STUDIO_TOKEN:
        print(
            "[Server] Refusing to expose the studio on a non-loopback interface without a token.\n"
            "         Use: python server.py --host 0.0.0.0 --token <long-random-secret>\n"
            "         Then open: http://<this-machine-ip>:%d/?token=<secret>" % port,
            file=sys.stderr, flush=True,
        )
        raise SystemExit(2)
    BIND_HOST = bind

    # 1. Start WebSocket Bridge thread
    ws_thread = threading.Thread(target=start_ws_server, args=(ws_port,), daemon=True)
    ws_thread.start()

    # 2. Start HTTP server
    handler_factory = partial(BlenderStudioHTTPRequestHandler, directory=target_dir)
    httpd = StudioHTTPServer((bind, port), handler_factory)
    httpd.ws_port = ws_port
    _ACTIVE_HTTP_PORTS.add(int(getattr(httpd, 'server_port', port) or port))
    print("=" * 70, flush=True)
    print(f"🚀 Web Blender Studio 2.0 Server Live!", flush=True)
    print(f"👉 HTTP Web App:  http://{bind}:{port}", flush=True)
    print(f"👉 CLI/MCP Bridge: ws://{bind}:{ws_port} & http://{bind}:{port}/api/*", flush=True)
    print(
        f"⚡ Serving: {target_dir} | backlog={httpd.request_queue_size} | HTTP/1.1 keep-alive + gzip + ETag",
        flush=True,
    )
    if STUDIO_TOKEN:
        print("🔐 Studio token required (X-Studio-Token or studio_token cookie)", flush=True)
    elif os.environ.get("STUDIO_TRUSTED_PROXIES", "").strip():
        print("⚠️  [SECURITY WARNING] STUDIO_TRUSTED_PROXIES is set without STUDIO_TOKEN — set STUDIO_TOKEN before exposing non-cloud /api/* through a reverse proxy.", flush=True)
    print("=" * 70, flush=True)

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping server...")
    finally:
        httpd.server_close()

if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description="Web Blender Studio server")
    parser.add_argument('--host', default=os.environ.get('STUDIO_HOST', '127.0.0.1'),
                        help='Bind address (default 127.0.0.1; non-loopback requires --token)')
    parser.add_argument('--port', type=int, default=8080)
    parser.add_argument('--ws-port', type=int, default=8082)
    parser.add_argument('--token', default=os.environ.get('STUDIO_TOKEN', ''),
                        help='Shared secret required for /api/* and the WebSocket bridge')
    parser.add_argument('--dist', action='store_true',
                        help='Serve bundled production dist/ assets (recommended for multi-user load)')
    parser.add_argument('--dir', default=os.environ.get('STUDIO_SERVE_DIR', ''),
                        help='Override static web root directory')
    args = parser.parse_args()
    run_server(args.port, args.ws_port, args.host, args.token,
               serve_dir=(args.dir or None), use_dist=bool(args.dist))
