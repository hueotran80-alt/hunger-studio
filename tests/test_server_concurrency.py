"""Concurrency, static caching, gzip, keep-alive, singleflight & backpressure tests."""
import base64
import concurrent.futures
import gzip
import io
import json
import os
import sys
import tempfile
import threading
import time
import types
import unittest
from http.client import HTTPConnection
from pathlib import Path
from unittest.mock import patch
from urllib.parse import quote

sys.path.insert(0, str(Path(__file__).resolve().parent))

import helpers  # noqa: E402

SERVER = helpers.load_server()


class ServerConcurrencyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.saved_config_file = SERVER.bridge_hub.config_file
        self.saved_config = dict(SERVER.bridge_hub.config)
        self.saved_token = SERVER.STUDIO_TOKEN
        self.saved_models = SERVER.MODELS_DIR
        self.saved_deprioritized = set(SERVER.bridge_hub._deprioritized_keys)

        SERVER.bridge_hub.config_file = os.path.join(self.tmp.name, "ai_config.json")
        SERVER.bridge_hub.config.update({
            "geminiKey": helpers.FAKE_GEMINI,
            "openAiKey": helpers.FAKE_OPENAI,
            "customKey": helpers.FAKE_CUSTOM,
            "customKeys": [helpers.FAKE_CUSTOM],
            "geminiModel": "gemini-test",
            "customModel": "custom-test",
            "customEndpoint": "https://motapis.com/v1",
            "provider": "motapis",
        })
        SERVER.bridge_hub._config_file_stat = None
        SERVER.STUDIO_TOKEN = ""
        SERVER.MODELS_DIR = self.tmp.name
        SERVER._STATIC_CACHE.clear()
        SERVER._TTS_MEM_CACHE.clear()
        SERVER._RATE_LIMITER.reset()

        # Populate a representative static tree (HTML, hashed Vite bundle, vendor, media).
        os.makedirs(os.path.join(self.tmp.name, "assets"), exist_ok=True)
        os.makedirs(os.path.join(self.tmp.name, "vendor"), exist_ok=True)
        os.makedirs(os.path.join(self.tmp.name, "models"), exist_ok=True)

        self.index_html = ("<!doctype html><html><body>" + ("<p>Web Blender Studio</p>" * 80) + "</body></html>").encode("utf-8")
        self.hashed_js = ("export const studioVersion = 2;\n" + ("console.log('mesh_kernel ready');\n" * 120)).encode("utf-8")
        self.vendor_js = ("window.__vendor = true;\n" * 90).encode("utf-8")
        self.video_bin = os.urandom(2048)

        with open(os.path.join(self.tmp.name, "index.html"), "wb") as f:
            f.write(self.index_html)
        with open(os.path.join(self.tmp.name, "assets", "studio-Ab12Cd34.js"), "wb") as f:
            f.write(self.hashed_js)
        with open(os.path.join(self.tmp.name, "vendor", "rapier.js"), "wb") as f:
            f.write(self.vendor_js)
        with open(os.path.join(self.tmp.name, "models", "demo.mp4"), "wb") as f:
            f.write(self.video_bin)

        self.httpd, self.thread, self.host = helpers.make_server(
            SERVER, directory=self.tmp.name
        )

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.tmp.cleanup()
        SERVER._STATIC_CACHE.clear()
        SERVER._TTS_MEM_CACHE.clear()
        SERVER._RATE_LIMITER.reset()
        SERVER.bridge_hub.config_file = self.saved_config_file
        SERVER.bridge_hub.config.clear()
        SERVER.bridge_hub.config.update(self.saved_config)
        SERVER.bridge_hub._config_file_stat = None
        SERVER.bridge_hub._deprioritized_keys = self.saved_deprioritized
        SERVER.STUDIO_TOKEN = self.saved_token
        SERVER.MODELS_DIR = self.saved_models

    def _raw_get(self, path, headers=None):
        conn = HTTPConnection(self.host, timeout=15)
        try:
            conn.request("GET", path, headers=headers or {})
            resp = conn.getresponse()
            body = resp.read()
            hdrs = {k.lower(): v for k, v in resp.getheaders()}
            return resp.status, hdrs, body
        finally:
            conn.close()

    def test_backlog_and_http11_keepalive_reuse(self):
        self.assertIs(SERVER.ThreadingHTTPServer, SERVER.StudioHTTPServer)
        self.assertGreaterEqual(SERVER.StudioHTTPServer.request_queue_size, 512)
        self.assertTrue(SERVER.StudioHTTPServer.daemon_threads)
        self.assertGreaterEqual(self.httpd.request_queue_size, 512)

        conn = HTTPConnection(self.host, timeout=15)
        try:
            sockets = set()
            paths = [
                "/index.html",
                "/assets/studio-Ab12Cd34.js",
                "/api/status",
                "/api/config",
                "/vendor/rapier.js",
            ]
            for p in paths:
                conn.request("GET", p, headers={"Accept-Encoding": "gzip"})
                resp = conn.getresponse()
                body = resp.read()
                self.assertEqual(resp.status, 200, f"failed on {p}")
                self.assertEqual(resp.version, 11, f"expected HTTP/1.1 on {p}")
                self.assertIsNotNone(conn.sock)
                sockets.add(conn.sock.fileno())
                self.assertTrue(len(body) > 0)
            # All 5 requests reused a single persistent TCP socket.
            self.assertEqual(len(sockets), 1)
        finally:
            conn.close()

    def test_static_gzip_etag_304_invalidation_and_cache_control(self):
        # 1. HTML entry: gzipped, ETag, no-cache (revalidatable)
        st, hdrs, body = self._raw_get("/index.html", {"Accept-Encoding": "gzip"})
        self.assertEqual(st, 200)
        self.assertEqual(hdrs.get("content-encoding"), "gzip")
        self.assertEqual(hdrs.get("cache-control"), "no-cache")
        self.assertIn("vary", hdrs)
        self.assertEqual(gzip.decompress(body), self.index_html)
        etag = hdrs.get("etag")
        self.assertTrue(etag)

        # 2. ETag conditional revalidation -> 304 empty body
        st304, hdrs304, body304 = self._raw_get(
            "/index.html", {"Accept-Encoding": "gzip", "If-None-Match": etag}
        )
        self.assertEqual(st304, 304)
        self.assertEqual(body304, b"")
        self.assertEqual(hdrs304.get("etag"), etag)

        # 3. File edit invalidates cache immediately on next request
        updated_html = b"<!doctype html><html><body>Updated Studio!</body></html>" * 20
        index_path = os.path.join(self.tmp.name, "index.html")
        with open(index_path, "wb") as f:
            f.write(updated_html)
        # Ensure mtime_ns ticks cleanly on coarse filesystems too
        stat_now = os.stat(index_path)
        os.utime(index_path, ns=(stat_now.st_atime_ns, stat_now.st_mtime_ns + 1_000_000))

        st2, hdrs2, body2 = self._raw_get(
            "/index.html", {"Accept-Encoding": "gzip", "If-None-Match": etag}
        )
        self.assertEqual(st2, 200)
        self.assertNotEqual(hdrs2.get("etag"), etag)
        self.assertEqual(gzip.decompress(body2), updated_html)

        # 4. Hashed Vite bundle gets immutable 1-year cache + gzip
        st_js, hdrs_js, body_js = self._raw_get(
            "/assets/studio-Ab12Cd34.js", {"Accept-Encoding": "gzip"}
        )
        self.assertEqual(st_js, 200)
        self.assertEqual(hdrs_js.get("cache-control"), "public, max-age=31536000, immutable")
        self.assertEqual(hdrs_js.get("content-encoding"), "gzip")
        self.assertEqual(gzip.decompress(body_js), self.hashed_js)

        # 5. Vendor asset gets 1h cache
        st_v, hdrs_v, body_v = self._raw_get("/vendor/rapier.js")
        self.assertEqual(st_v, 200)
        self.assertNotIn("content-encoding", hdrs_v)
        self.assertEqual(hdrs_v.get("cache-control"), "public, max-age=3600")
        self.assertEqual(body_v, self.vendor_js)

        # 6. Binary video stays uncompressed and supports byte ranges
        st_m, hdrs_m, body_m = self._raw_get("/models/demo.mp4", {"Accept-Encoding": "gzip"})
        self.assertEqual(st_m, 200)
        self.assertNotIn("content-encoding", hdrs_m)
        self.assertEqual(body_m, self.video_bin)

        # 7. agent/copilot exec workers & Vite-hashed assets get strict CSP + CORP + no-cache
        for worker_path in (
            "/js/agent/agent-exec-worker.js",
            "/js/ai/copilot-exec-worker.js",
        ):
            st_w, hdrs_w, body_w = self._raw_get(worker_path)
            self.assertEqual(st_w, 200)
            self.assertEqual(hdrs_w.get("cache-control"), "no-cache")
            self.assertEqual(hdrs_w.get("cross-origin-resource-policy"), "same-origin")
            self.assertIn("default-src 'none'", hdrs_w.get("content-security-policy", ""))
            self.assertIn("connect-src 'none'", hdrs_w.get("content-security-policy", ""))
            self.assertIn("worker-src 'none'", hdrs_w.get("content-security-policy", ""))
            self.assertTrue(len(body_w) > 0)

        os.makedirs(os.path.join(self.tmp.name, "assets"), exist_ok=True)
        for worker_name in (
            "agent-exec-worker-deadbeef.js",
            "copilot-exec-worker-deadbeef.js",
        ):
            hashed_worker = os.path.join(self.tmp.name, "assets", worker_name)
            with open(hashed_worker, "wb") as f:
                f.write(b"self.onmessage=()=>{};")
            st_hw, hdrs_hw, body_hw = self._raw_get(f"/assets/{worker_name}")
            self.assertEqual(st_hw, 200)
            self.assertEqual(hdrs_hw.get("cache-control"), "no-cache")
            self.assertEqual(hdrs_hw.get("cross-origin-resource-policy"), "same-origin")
            self.assertIn("connect-src 'none'", hdrs_hw.get("content-security-policy", ""))
            self.assertEqual(body_hw, b"self.onmessage=()=>{};")

    def test_large_json_response_uses_gzip_and_no_store(self):
        fake_glb = b"glTF" + (b"0123456789ABCDEF" * 200)
        fake_blend = types.SimpleNamespace(
            BlenderNotAvailableError=RuntimeError,
            BlendValidationError=ValueError,
            BlendConversionError=RuntimeError,
            convert_blend_bytes_to_glb=lambda raw, apply_modifiers=False: {
                "glbBytes": fake_glb,
                "report": {"ok": True},
                "blenderVersion": "4.2",
            },
        )
        body_req = json.dumps({
            "fileName": "large_test.blend",
            "fileData": base64.b64encode(b"BLENDER-v300").decode("ascii"),
        }).encode("utf-8")
        conn = HTTPConnection(self.host, timeout=15)
        try:
            with patch.object(SERVER, "blend_converter", fake_blend):
                conn.request("POST", "/api/import/blend", body=body_req, headers={
                    "Content-Type": "application/json",
                    "Accept-Encoding": "gzip",
                })
                resp = conn.getresponse()
                raw = resp.read()
                hdrs = {k.lower(): v for k, v in resp.getheaders()}
        finally:
            conn.close()
        self.assertEqual(resp.status, 200)
        self.assertEqual(hdrs.get("content-encoding"), "gzip")
        self.assertIn("no-store", hdrs.get("cache-control", ""))
        parsed = json.loads(gzip.decompress(raw).decode("utf-8"))
        self.assertTrue(parsed["success"])
        self.assertEqual(parsed["size"], len(fake_glb))

    def test_tts_singleflight_dedup_under_20_concurrent_requests(self):
        unique_phrase = f"Xin chao hoc vien STEM {time.time_ns()}"
        cache_key = SERVER.hashlib.sha256(f"vi:{unique_phrase}".encode("utf-8")).hexdigest()[:32]
        cache_file = os.path.join(SERVER.BASE_DIR, "cloud_data", "tts_cache", f"{cache_key}.mp3")
        fake_mp3 = b"ID3" + (b"\x01\x02\x03\x04" * 80)

        call_count = 0
        count_lock = threading.Lock()

        def fake_synth(handler_self, clauses, safe_lang):
            nonlocal call_count
            time.sleep(0.15)
            with count_lock:
                call_count += 1
            return fake_mp3

        try:
            with patch.object(SERVER.BlenderStudioHTTPRequestHandler, "_synthesize_tts_clauses", fake_synth):
                q = quote(unique_phrase)
                with concurrent.futures.ThreadPoolExecutor(max_workers=20) as pool:
                    results = list(pool.map(
                        lambda _: self._raw_get(f"/api/tts?lang=vi&text={q}"),
                        range(20),
                    ))
                for status, hdrs, body in results:
                    self.assertEqual(status, 200)
                    self.assertEqual(body, fake_mp3)
                    self.assertEqual(hdrs.get("x-tts-cache"), cache_key)
                self.assertEqual(call_count, 1, "20 simultaneous identical TTS misses must deduplicate to 1 upstream synthesis")

                # Subsequent hit comes straight from RAM cache
                st2, _, body2 = self._raw_get(f"/api/tts?lang=vi&text={q}")
                self.assertEqual(st2, 200)
                self.assertEqual(body2, fake_mp3)
                self.assertEqual(call_count, 1)
        finally:
            if os.path.exists(cache_file):
                os.remove(cache_file)

    def test_ai_chat_rate_limit_and_semaphore_backpressure(self):
        class FakeResp:
            def __init__(self, obj):
                self._data = json.dumps(obj).encode("utf-8")
            def read(self):
                return self._data
            def __enter__(self):
                return self
            def __exit__(self, *args):
                return False

        SERVER._RATE_LIMITER.reset()
        with patch.dict(os.environ, {"STUDIO_RL_AI_CHAT_PER_MIN": "3"}), \
             patch("urllib.request.urlopen", return_value=FakeResp({"choices": [{"message": {"content": "ok"}}]})):
            for idx in range(3):
                st, _, data = helpers.request(self.host, "POST", "/api/ai/chat", {
                    "provider": "motapis",
                    "messages": [{"role": "user", "content": f"hello {idx}"}],
                })
                self.assertEqual(st, 200)
                self.assertIn("choices", data)

            # 4th call from same IP hits 429 rate limit
            st4, hdrs4, data4 = helpers.request(self.host, "POST", "/api/ai/chat", {
                "provider": "motapis",
                "messages": [{"role": "user", "content": "over limit"}],
            })
            self.assertEqual(st4, 429)
            self.assertFalse(data4["success"])
            self.assertIn("Retry-After", hdrs4)

        # Test concurrency semaphore 503 backpressure
        SERVER._RATE_LIMITER.reset()
        tiny_sem = threading.BoundedSemaphore(1)
        tiny_sem.acquire()
        try:
            with patch.dict(os.environ, {"STUDIO_RL_AI_CHAT_PER_MIN": "100"}), \
                 patch.object(SERVER, "_AI_CHAT_SEMAPHORE", tiny_sem):
                st503, hdrs503, data503 = helpers.request(self.host, "POST", "/api/ai/chat", {
                    "provider": "motapis",
                    "messages": [{"role": "user", "content": "busy test"}],
                })
                self.assertEqual(st503, 503)
                self.assertFalse(data503["success"])
                self.assertEqual(hdrs503.get("Retry-After"), "3")
        finally:
            tiny_sem.release()

    def test_heavy_job_semaphore_and_rate_limit(self):
        fake_blend = types.SimpleNamespace(
            BlenderNotAvailableError=RuntimeError,
            BlendValidationError=ValueError,
            BlendConversionError=RuntimeError,
            convert_blend_bytes_to_glb=lambda raw, apply_modifiers=False: {
                "glbBytes": b"glTF_fake_glb",
                "report": {"ok": True},
                "blenderVersion": "4.2",
            },
        )
        valid_b64 = base64.b64encode(b"BLENDER-v300").decode("ascii")

        tiny_sem = threading.BoundedSemaphore(1)
        tiny_sem.acquire()
        try:
            with patch.object(SERVER, "blend_converter", fake_blend), \
                 patch.object(SERVER, "_HEAVY_JOB_SEMAPHORE", tiny_sem), \
                 patch.dict(os.environ, {"STUDIO_RL_HEAVY_PER_MIN": "20"}):
                st, hdrs, data = helpers.request(self.host, "POST", "/api/import/blend", {
                    "fileName": "cube.blend",
                    "fileData": valid_b64,
                })
                self.assertEqual(st, 503)
                self.assertFalse(data["success"])
                self.assertEqual(hdrs.get("Retry-After"), "5")
        finally:
            tiny_sem.release()

        SERVER._RATE_LIMITER.reset()
        with patch.object(SERVER, "blend_converter", fake_blend), \
             patch.dict(os.environ, {"STUDIO_RL_HEAVY_PER_MIN": "2"}):
            for _ in range(2):
                st, _, data = helpers.request(self.host, "POST", "/api/import/blend", {
                    "fileName": "cube.blend",
                    "fileData": valid_b64,
                })
                self.assertEqual(st, 200)
                self.assertTrue(data["success"])
            st3, hdrs3, _ = helpers.request(self.host, "POST", "/api/import/blend", {
                "fileName": "cube.blend",
                "fileData": valid_b64,
            })
            self.assertEqual(st3, 429)
            self.assertIn("Retry-After", hdrs3)

    def test_120_concurrent_clients_burst_zero_failures(self):
        clients = 120
        paths = [
            "/index.html",
            "/assets/studio-Ab12Cd34.js",
            "/vendor/rapier.js",
            "/api/status",
            "/api/config",
        ]

        def simulate_user(user_id):
            conn = HTTPConnection(self.host, timeout=15)
            try:
                for p in paths:
                    conn.request("GET", p, headers={"Accept-Encoding": "gzip"})
                    resp = conn.getresponse()
                    raw = resp.read()
                    if resp.status != 200 or not raw:
                        return f"user={user_id} path={p} status={resp.status} len={len(raw)}"
                return None
            except Exception as exc:
                return f"user={user_id} exc={exc!r}"
            finally:
                conn.close()

        with concurrent.futures.ThreadPoolExecutor(max_workers=clients) as pool:
            outcomes = list(pool.map(simulate_user, range(clients)))

        failures = [o for o in outcomes if o is not None]
        self.assertEqual(failures, [], f"Concurrency failures: {failures[:5]}")

    def test_run_server_dist_and_dir_flags(self):
        # Missing directory must exit cleanly with code 2
        with self.assertRaises(SystemExit) as cm:
            SERVER.run_server(port=0, ws_port=0, host="127.0.0.1", serve_dir=os.path.join(self.tmp.name, "missing_dir"))
        self.assertEqual(cm.exception.code, 2)


if __name__ == "__main__":
    unittest.main()
