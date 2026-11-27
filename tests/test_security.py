"""Phase-1 (P0) regression tests: secrets, origin/token guards, SSRF, uploads, bridge."""
import base64
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))

import helpers  # noqa: E402

SERVER = helpers.load_server()


class ApiTestBase(unittest.TestCase):
    directory = None

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.saved_config_file = SERVER.bridge_hub.config_file
        self.saved_config = dict(SERVER.bridge_hub.config)
        self.saved_token = SERVER.STUDIO_TOKEN
        self.saved_models = SERVER.MODELS_DIR

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
        SERVER.STUDIO_TOKEN = ""
        SERVER.MODELS_DIR = self.tmp.name
        os.makedirs(os.path.join(self.tmp.name, "models"), exist_ok=True)

        self.httpd, self.thread, self.host = helpers.make_server(
            SERVER, directory=self.tmp.name)

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.tmp.cleanup()
        SERVER.bridge_hub.config_file = self.saved_config_file
        SERVER.bridge_hub.config.clear()
        SERVER.bridge_hub.config.update(self.saved_config)
        SERVER.bridge_hub.connected_clients.clear()
        SERVER.STUDIO_TOKEN = self.saved_token
        SERVER.MODELS_DIR = self.saved_models

    def call(self, method, path, body=None, headers=None, raw_body=None):
        return helpers.request(self.host, method, path, body=body, headers=headers, raw_body=raw_body)

    def assert_no_secret(self, payload):
        text = payload if isinstance(payload, str) else json.dumps(payload)
        for secret in (helpers.FAKE_GEMINI, helpers.FAKE_OPENAI,
                       helpers.FAKE_CUSTOM, helpers.FAKE_HF):
            self.assertNotIn(secret, text, "API response leaked a stored secret")


class ConfigRedactionTests(ApiTestBase):
    def test_get_config_never_returns_secrets(self):
        status, _, data = self.call("GET", "/api/config")
        self.assertEqual(status, 200)
        self.assert_no_secret(data)
        for key in ("geminiKey", "openAiKey", "customKey", "customKeys"):
            self.assertNotIn(key, data, f"{key} must never be sent to the browser")
        self.assertTrue(data["geminiConfigured"])
        self.assertTrue(data["openAiConfigured"])
        self.assertEqual(data["customKeysCount"], 1)
        # Masked previews are allowed but must not contain the full key.
        for masked in data["maskedKeys"]:
            self.assertNotEqual(masked, helpers.FAKE_CUSTOM)

    def test_post_config_never_returns_secrets(self):
        status, _, data = self.call("POST", "/api/config", {"geminiModel": "gemini-test-2"})
        self.assertEqual(status, 200)
        self.assert_no_secret(data)
        self.assertNotIn("geminiKey", data.get("config", {}))
        self.assertNotIn("customKeys", data.get("config", {}))

    def test_config_does_not_echo_submitted_key(self):
        status, _, data = self.call("POST", "/api/config", {"geminiKey": "AIzaNEWSECRET-0123456789"})
        self.assertEqual(status, 200)
        self.assertNotIn("AIzaNEWSECRET-0123456789", json.dumps(data))

    def test_offline_provider_normalized_and_custom_endpoint_locked(self):
        status, _, data = self.call("POST", "/api/config", {
            "provider": "offline",
            "customEndpoint": "https://attacker.example/v1",
        })
        self.assertEqual(status, 200)
        cfg = data.get("config", {})
        self.assertNotEqual(cfg.get("provider"), "offline")
        self.assertNotIn("customEndpoint", cfg)
        self.assertEqual(SERVER.bridge_hub.config.get("customEndpoint"), "https://motapis.com/v1")
        free = cfg.get("freeModels") or {}
        self.assertIn("gemini-3.5-flash-lite", free.get("gemini", []))
        self.assertNotIn("gemini-4-argon", free.get("gemini", []))
        self.assertIn("claude-sonnet-4-6", free.get("motapis", []))


class OriginAndTokenTests(ApiTestBase):
    def test_foreign_origin_is_rejected(self):
        status, _, data = self.call("POST", "/api/execute", {"code": "1+1"},
                                    headers={"Origin": "https://evil.example"})
        self.assertEqual(status, 403)
        self.assertFalse(data["success"])
        self.assertIn("Origin", str(data))

    def test_foreign_host_is_rejected(self):
        status, _, data = self.call("GET", "/api/config", headers={"Host": "evil.example"})
        self.assertEqual(status, 403)
        self.assertFalse(data["success"])

    def test_token_required_when_configured(self):
        SERVER.STUDIO_TOKEN = "test-token-123"
        status, _, _ = self.call("GET", "/api/config")
        self.assertEqual(status, 401)
        status, _, _ = self.call("GET", "/api/config", headers={"X-Studio-Token": "test-token-123"})
        self.assertEqual(status, 200)
        status, _, _ = self.call("GET", "/api/config", headers={"Cookie": "studio_token=test-token-123"})
        self.assertEqual(status, 200)

    def test_wrong_token_is_rejected(self):
        SERVER.STUDIO_TOKEN = "test-token-123"
        status, _, _ = self.call("GET", "/api/config", headers={"X-Studio-Token": "nope"})
        self.assertEqual(status, 401)

    def test_cors_is_not_wildcard(self):
        status, headers, _ = self.call("OPTIONS", "/api/execute",
                                       headers={"Origin": "https://evil.example"})
        self.assertEqual(status, 403)
        self.assertNotEqual(headers.get("Access-Control-Allow-Origin"), "*")

    def test_same_origin_post_is_allowed(self):
        status, _, data = self.call("GET", "/api/config",
                                    headers={"Origin": f"http://{self.host}"})
        self.assertEqual(status, 200)


class AiChatSsrfTests(ApiTestBase):
    def test_request_supplied_endpoint_is_rejected(self):
        status, _, data = self.call("POST", "/api/ai/chat", {
            "endpoint": "http://127.0.0.1:9911/v1",
            "messages": [{"role": "user", "content": "hi"}],
        })
        self.assertEqual(status, 400)
        self.assertFalse(data.get("success", False))
        self.assertIn("endpoint", json.dumps(data).lower())

    def test_uses_server_configured_endpoint_only(self):
        SERVER.bridge_hub.config["customEndpoint"] = "https://api.example.test/v1"
        calls = []

        class FakeResponse:
            status = 200

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def read(self):
                return b'{"choices": [{"message": {"content": "ok"}}]}'

        def fake_urlopen(req, timeout=None):
            calls.append(req.full_url)
            return FakeResponse()

        with patch("urllib.request.urlopen", fake_urlopen):
            status, _, data = self.call("POST", "/api/ai/chat", {
                "messages": [{"role": "user", "content": "hi"}],
            })
        self.assertEqual(status, 200)
        self.assertTrue(calls, "expected one upstream call")
        self.assertTrue(all(url.startswith("https://api.example.test/v1") for url in calls))
        self.assertNotIn("127.0.0.1:9911", " ".join(calls))


class UploadTests(ApiTestBase):
    def test_mocap_upload_rejects_html(self):
        payload = base64.b64encode(b"<script>alert(1)</script>").decode()
        status, _, data = self.call("POST", "/api/mocap/upload", {
            "fileData": payload, "fileName": "poc.html",
        })
        self.assertEqual(status, 415)
        self.assertFalse(data["success"])
        self.assertEqual(list(Path(self.tmp.name).rglob("*.html")), [])

    def test_mocap_upload_generates_safe_name(self):
        payload = base64.b64encode(b"fake-webm").decode()
        status, _, data = self.call("POST", "/api/mocap/upload", {
            "fileData": payload, "fileName": "../../evil.webm",
        })
        self.assertEqual(status, 200)
        self.assertTrue(data["success"])
        rel = data["videoPath"]
        self.assertRegex(rel, r"^models/uploaded_mocap_[0-9a-f]{8,}\.webm$")
        self.assertTrue(Path(SERVER.MODELS_DIR, Path(rel).name).is_file())
        self.assertNotIn("..", rel)

    def test_mocap_upload_rejects_invalid_base64(self):
        status, _, data = self.call("POST", "/api/mocap/upload", {
            "fileData": "not base64!!!", "fileName": "x.webm",
        })
        self.assertEqual(status, 400)
        self.assertFalse(data["success"])

    def test_static_never_serves_html_from_upload_dirs(self):
        evil = Path(self.tmp.name, "models", "evil.html")
        evil.write_text("<script>alert(1)</script>")
        status, headers, body = self.call("GET", "/models/evil.html")
        self.assertIn(status, (403, 404))
        if isinstance(body, bytes):
            body = body.decode("utf-8", "replace")
        self.assertNotIn("<script>", str(body))

    def test_static_still_serves_allowed_assets(self):
        good = Path(self.tmp.name, "models", "good.glb")
        good.write_bytes(b"glTF")
        status, _, body = self.call("GET", "/models/good.glb")
        self.assertEqual(status, 200)
        self.assertEqual(body, b"glTF")

    def test_mocap_track_blocks_path_traversal_and_non_video(self):
        for payload_path in ("/etc/passwd", "/dev/zero", "../../server.py", "models/../server.py", "models/sub/clip.mp4"):
            status, _, data = self.call("POST", "/api/mocap/track", {"videoPath": payload_path})
            self.assertEqual(status, 403, f"expected 403 for {payload_path}, got {status}: {data}")
            self.assertFalse(data["success"])

        status, _, data = self.call("POST", "/api/mocap/track", {"videoPath": "models/secret.txt"})
        self.assertEqual(status, 415)
        self.assertFalse(data["success"])

    def test_embed_html_sends_coep_without_coop(self):
        Path(self.tmp.name, "embed.html").write_text("<!doctype html><title>embed</title>")
        status, headers, _ = self.call("GET", "/embed.html")
        self.assertEqual(status, 200)
        lowered = {k.lower(): v for k, v in headers.items()}
        self.assertEqual(lowered.get("cross-origin-embedder-policy"), "credentialless")
        self.assertEqual(lowered.get("cross-origin-resource-policy"), "cross-origin")
        self.assertNotIn("cross-origin-opener-policy", lowered)


class BridgeTargetTests(unittest.TestCase):
    def setUp(self):
        SERVER.bridge_hub.connected_clients.clear()

    def tearDown(self):
        SERVER.bridge_hub.connected_clients.clear()

    def test_targets_last_registered_client(self):
        first, second = object(), object()
        SERVER.bridge_hub.register_client(first)
        SERVER.bridge_hub.register_client(second)
        self.assertIs(SERVER.bridge_hub.target_client(), second)
        SERVER.bridge_hub.unregister_client(second)
        self.assertIs(SERVER.bridge_hub.target_client(), first)

    def test_registration_is_idempotent(self):
        first = object()
        SERVER.bridge_hub.register_client(first)
        SERVER.bridge_hub.register_client(first)
        self.assertEqual(len(SERVER.bridge_hub.connected_clients), 1)

    def test_prunes_closed_clients(self):
        class FakeWs:
            def __init__(self, close_code=None, state_name="OPEN"):
                self.close_code = close_code
                self.state = type("State", (), {"name": state_name})()

        closed_by_code = FakeWs(close_code=1000, state_name="CLOSED")
        closing_ws = FakeWs(close_code=None, state_name="CLOSING")
        open_ws = FakeWs(close_code=None, state_name="OPEN")
        SERVER.bridge_hub.register_client(closed_by_code)
        SERVER.bridge_hub.register_client(open_ws)
        SERVER.bridge_hub.register_client(closing_ws)
        self.assertIs(SERVER.bridge_hub.target_client(), open_ws)
        self.assertEqual(SERVER.bridge_hub.client_count(), 1)

    def test_ws_handler_unregisters_when_stdio_broken(self):
        import asyncio

        class BrokenStream:
            def write(self, _):
                raise OSError(5, "Input/output error")

            def flush(self):
                raise OSError(5, "Input/output error")

        class FakeWs:
            remote_address = ("127.0.0.1", 55555)
            close_code = None

            def __aiter__(self):
                return self

            async def __anext__(self):
                raise StopAsyncIteration

        ws = FakeWs()
        with patch.object(SERVER, "sys") as mock_sys:
            mock_sys.stdout = BrokenStream()
            mock_sys.stderr = BrokenStream()
            asyncio.run(SERVER.ws_handler(ws))
        self.assertEqual(len(SERVER.bridge_hub.connected_clients), 0)


class WsOriginTests(unittest.TestCase):
    def test_same_origin_allowed(self):
        self.assertTrue(SERVER._ws_origin_allowed("http://127.0.0.1:8080", "127.0.0.1:8080"))
        self.assertTrue(SERVER._ws_origin_allowed("http://localhost:8080", "127.0.0.1:8080"))

    def test_foreign_origin_rejected(self):
        self.assertFalse(SERVER._ws_origin_allowed("https://evil.example", "127.0.0.1:8080"))

    def test_unauthorized_localhost_port_rejected(self):
        self.assertFalse(SERVER._ws_origin_allowed("http://localhost:3999", "127.0.0.1:8080"))

    def test_missing_origin_allowed_for_cli(self):
        self.assertTrue(SERVER._ws_origin_allowed(None, "127.0.0.1:8080"))


class Wave1HardeningTests(ApiTestBase):
    def test_static_blocks_secrets_git_source_and_db(self):
        for rel in (
            ".git/config",
            ".env",
            "cloud_config.json",
            "cloud_config.example.json",
            "ai_config.json",
            "server.py",
            "cloud/service.py",
            "cloud_data/cloud.sqlite3",
            "crates/mesh_kernel/Cargo.toml",
            "Dockerfile",
            "AGENTS.md",
            "roadmap_web_saas.md",
            "requirements.txt",
        ):
            target = Path(self.tmp.name, rel)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text("TOP_SECRET_VALUE_SHOULD_NOT_LEAK")
            status, _, data = self.call("GET", f"/{rel}")
            self.assertIn(status, (403, 404), f"Expected 403/404 for /{rel}, got {status}")
            self.assertNotIn("TOP_SECRET_VALUE_SHOULD_NOT_LEAK", str(data))

        Path(self.tmp.name, "PRIVACY.md").write_text("# Privacy Policy")
        st_pub, _, _ = self.call("GET", "/PRIVACY.md")
        self.assertEqual(st_pub, 200)

    def test_security_headers_and_embed_xfo_exemption(self):
        Path(self.tmp.name, "index.html").write_text("<!doctype html><title>studio</title>")
        Path(self.tmp.name, "embed.html").write_text("<!doctype html><title>embed</title>")

        status, headers, _ = self.call("GET", "/")
        self.assertEqual(status, 200)
        low = {k.lower(): v for k, v in headers.items()}
        self.assertEqual(low.get("x-content-type-options"), "nosniff")
        self.assertEqual(low.get("referrer-policy"), "strict-origin-when-cross-origin")
        self.assertEqual(low.get("x-frame-options"), "SAMEORIGIN")

        status_e, headers_e, _ = self.call("GET", "/embed.html")
        self.assertEqual(status_e, 200)
        low_e = {k.lower(): v for k, v in headers_e.items()}
        self.assertEqual(low_e.get("x-content-type-options"), "nosniff")
        self.assertNotIn("x-frame-options", low_e)

    def test_options_non_api_does_not_reflect_origin(self):
        status, headers, _ = self.call(
            "OPTIONS",
            "/index.html",
            headers={"Origin": "https://evil.example"},
        )
        self.assertEqual(status, 204)
        low = {k.lower(): v for k, v in headers.items()}
        self.assertNotIn("access-control-allow-origin", low)

    def test_reverse_proxy_https_origin_check(self):
        prev_proxies = os.environ.get("STUDIO_TRUSTED_PROXIES")
        prev_hosts = os.environ.get("STUDIO_ALLOWED_HOSTS")
        os.environ["STUDIO_TRUSTED_PROXIES"] = "127.0.0.1"
        os.environ["STUDIO_ALLOWED_HOSTS"] = "studio.example.com"
        try:
            status, _, data = self.call(
                "POST",
                "/api/config",
                {"geminiModel": "gemini-test-proxy"},
                headers={
                    "Host": "studio.example.com",
                    "Origin": "https://studio.example.com",
                    "X-Forwarded-Proto": "https",
                },
            )
            self.assertEqual(status, 200, f"Trusted https reverse proxy rejected: {data}")

            bad_status, _, _ = self.call(
                "POST",
                "/api/config",
                {"geminiModel": "gemini-test-proxy"},
                headers={
                    "Host": "evil.example",
                    "Origin": "https://evil.example",
                    "X-Forwarded-Proto": "https",
                },
            )
            self.assertEqual(bad_status, 403)

            # Non-config admin/AI routes behind a public reverse proxy with Cloud enabled must require STUDIO_TOKEN
            from cloud.config import CloudConfig
            from cloud.service import CloudService

            prev_cloud = SERVER.CLOUD
            SERVER.CLOUD = CloudService(CloudConfig({
                "provider": "local", "allow_dev_login": True, "session_secret": "p" * 64, "data_dir": self.tmp.name,
            }))
            try:
                proxy_ai_status, _, _ = self.call(
                    "POST",
                    "/api/ai/chat",
                    {"provider": "motapis", "messages": [{"role": "user", "content": "hi"}]},
                    headers={
                        "Host": "studio.example.com",
                        "Origin": "https://studio.example.com",
                        "X-Forwarded-Proto": "https",
                    },
                )
                self.assertEqual(proxy_ai_status, 401)
            finally:
                SERVER.CLOUD = prev_cloud
        finally:
            if prev_proxies is None:
                os.environ.pop("STUDIO_TRUSTED_PROXIES", None)
            else:
                os.environ["STUDIO_TRUSTED_PROXIES"] = prev_proxies
            if prev_hosts is None:
                os.environ.pop("STUDIO_ALLOWED_HOSTS", None)
            else:
                os.environ["STUDIO_ALLOWED_HOSTS"] = prev_hosts

    def test_rejects_chunked_transfer_encoding(self):
        status, _, data = self.call(
            "POST",
            "/api/config",
            headers={"Transfer-Encoding": "chunked"},
            raw_body=b"0\r\n\r\n",
        )
        self.assertEqual(status, 411)
        self.assertFalse(data["success"])

    def test_healthz_and_csp_headers(self):
        Path(self.tmp.name, "index.html").write_text("<!doctype html><title>studio</title>")
        Path(self.tmp.name, "embed.html").write_text("<!doctype html><title>embed</title>")

        SERVER.STUDIO_TOKEN = "secret-healthz-token"
        try:
            st_h, _, data_h = self.call("GET", "/healthz")
            self.assertEqual(st_h, 200, data_h)
            self.assertTrue(data_h["ok"])
            self.assertEqual(data_h["status"], "healthy")
        finally:
            SERVER.STUDIO_TOKEN = ""

        st, hdrs, _ = self.call("GET", "/")
        self.assertEqual(st, 200)
        low = {k.lower(): v for k, v in hdrs.items()}
        csp = low.get("content-security-policy", "")
        self.assertIn("default-src 'self'", csp)
        self.assertIn("frame-ancestors 'self'", csp)
        self.assertIn("object-src 'none'", csp)

        st_e, hdrs_e, _ = self.call("GET", "/embed.html")
        self.assertEqual(st_e, 200)
        csp_e = {k.lower(): v for k, v in hdrs_e.items()}.get("content-security-policy", "")
        self.assertIn("frame-ancestors *", csp_e)

    def test_tts_does_not_scrape_google_translate(self):
        src = (Path(__file__).resolve().parents[1] / "server.py").read_text(encoding="utf-8")
        self.assertNotIn("translate.googleapis.com", src)
        st, _, data = self.call("POST", "/api/tts", {"text": "Xin chao", "lang": "vi"})
        # Without STUDIO_TTS_ENDPOINT configured, server cleanly returns 503 fallback notice.
        self.assertIn(st, (503,))

    def test_cloud_ai_chat_metering_refund_and_byok(self):
        from cloud.config import CloudConfig
        from cloud.service import CloudService

        prev_cloud = SERVER.CLOUD
        cfg = CloudConfig({
            "provider": "local",
            "allow_dev_login": True,
            "session_secret": "m" * 64,
            "data_dir": self.tmp.name,
            "free_credits": 10,
            "costs": {"save_project": 1, "upload_asset": 5, "ai_chat": 3},
        })
        svc = CloudService(cfg)
        SERVER.CLOUD = svc
        try:
            # 1) Unauthenticated rejected 401
            st_unauth, _, _ = self.call("POST", "/api/cloud/ai/chat", {
                "provider": "motapis",
                "messages": [{"role": "user", "content": "hi"}],
            })
            self.assertEqual(st_unauth, 401)

            _, _, login_res = self.call("POST", "/api/cloud/dev-login", {"email": "ai@example.com"})
            auth_hdr = {"Authorization": f"Bearer {login_res['session']['token']}"}

            # 2) Failed upstream refunds charged credits
            with patch.object(
                SERVER.BlenderStudioHTTPRequestHandler,
                "_execute_ai_proxy",
                return_value=(False, 502, {"success": False, "error": "upstream down"}),
            ):
                st_fail, _, _ = self.call("POST", "/api/cloud/ai/chat", {
                    "provider": "motapis",
                    "model": "claude-sonnet-4-6",
                    "messages": [{"role": "user", "content": "cube"}],
                }, headers=auth_hdr)
            self.assertEqual(st_fail, 502)
            _, _, me_after_fail = self.call("GET", "/api/cloud/me", headers=auth_hdr)
            self.assertEqual(me_after_fail["user"]["credits"], 10)

            # 3) Success deducts 3 credits -> 7 remaining
            with patch.object(
                SERVER.BlenderStudioHTTPRequestHandler,
                "_execute_ai_proxy",
                return_value=(True, 200, {"choices": [{"message": {"content": "ok"}}]}),
            ):
                st_ok, _, res_ok = self.call("POST", "/api/cloud/ai/chat", {
                    "provider": "motapis",
                    "model": "claude-sonnet-4-6",
                    "messages": [{"role": "user", "content": "cube"}],
                }, headers=auth_hdr)
            self.assertEqual(st_ok, 200, res_ok)
            self.assertEqual(res_ok["cloudCredits"], 7)

            # 4) BYOK bypasses credit deduction (stays 7)
            with patch.object(
                SERVER.BlenderStudioHTTPRequestHandler,
                "_execute_ai_proxy",
                return_value=(True, 200, {"choices": [{"message": {"content": "ok byok"}}]}),
            ) as mock_proxy:
                st_byok, _, res_byok = self.call("POST", "/api/cloud/ai/chat", {
                    "provider": "motapis",
                    "model": "claude-sonnet-4-6",
                    "messages": [{"role": "user", "content": "sphere"}],
                }, headers={**auth_hdr, "X-AI-Provider-Key": "sk-user-secret"})
            self.assertEqual(st_byok, 200, res_byok)
            self.assertEqual(res_byok["cloudCredits"], 7)
            self.assertEqual(mock_proxy.call_args.kwargs.get("byok_key"), "sk-user-secret")
        finally:
            SERVER.CLOUD = prev_cloud

    def test_ai_proxy_deprioritizes_403_and_cools_down_429_keys(self):
        from urllib.error import HTTPError
        import io
        prev_keys = list(SERVER.bridge_hub.config.get("customKeys") or [])
        prev_endpoint = SERVER.bridge_hub.config.get("customEndpoint")
        prev_cooldowns = getattr(SERVER.bridge_hub, "_key_cooldowns", {})
        prev_dep = set(getattr(SERVER.bridge_hub, "_deprioritized_keys", set()))
        try:
            SERVER.bridge_hub.config["customEndpoint"] = "https://api.example.test/v1"
            SERVER.bridge_hub.config["customKeys"] = ["k_429", "k_403", "k_good"]
            SERVER.bridge_hub._key_cooldowns = {}
            SERVER.bridge_hub._deprioritized_keys = set()

            seen_auth = []
            def fake_urlopen(req, timeout=45):
                auth = req.headers.get("Authorization")
                seen_auth.append(auth)
                if auth == "Bearer k_429":
                    raise HTTPError(req.full_url, 429, "Too Many", {}, io.BytesIO(b'{"error":"rate"}'))
                if auth == "Bearer k_403":
                    raise HTTPError(req.full_url, 403, "Forbidden", {}, io.BytesIO(b'{"error":"forbidden"}'))
                class Resp:
                    def __enter__(self): return self
                    def __exit__(self, *a): return False
                    def read(self): return b'{"choices":[{"message":{"content":"ok"}}]}'
                return Resp()

            body = {"provider": "motapis", "model": "gpt-6-astra", "messages": [{"role": "user", "content": "hi"}]}
            with patch("urllib.request.urlopen", side_effect=fake_urlopen):
                h = object.__new__(SERVER.BlenderStudioHTTPRequestHandler)
                ok1, st1, _ = h._execute_ai_proxy(body)
                self.assertTrue(ok1)
                self.assertEqual(st1, 200)
                self.assertEqual(seen_auth, ["Bearer k_429", "Bearer k_403", "Bearer k_good"])

                seen_auth.clear()
                ok2, st2, _ = h._execute_ai_proxy(body)
                self.assertTrue(ok2)
                self.assertEqual(st2, 200)
                # Second call MUST go directly to k_good first instead of hitting 429/403 keys again
                self.assertEqual(seen_auth, ["Bearer k_good"])
        finally:
            SERVER.bridge_hub.config["customKeys"] = prev_keys
            SERVER.bridge_hub.config["customEndpoint"] = prev_endpoint
            SERVER.bridge_hub._key_cooldowns = prev_cooldowns
            SERVER.bridge_hub._deprioritized_keys = prev_dep

    def test_mocap_upload_ttl_cleanup_removes_only_expired_uploads(self):
        old_upload = Path(self.tmp.name, "uploaded_mocap_expired0001.webm")
        fresh_upload = Path(self.tmp.name, "uploaded_mocap_fresh000001.webm")
        sample_video = Path(self.tmp.name, "sample_human_motion.webm")
        for p in (old_upload, fresh_upload, sample_video):
            p.write_bytes(b"webm-data")
        now = 1_800_000_000.0
        os.utime(old_upload, (now - 7200, now - 7200))
        os.utime(sample_video, (now - 7200, now - 7200))
        os.utime(fresh_upload, (now - 60, now - 60))

        removed = SERVER._cleanup_old_mocap_uploads(self.tmp.name, ttl_seconds=3600, now=now)
        self.assertEqual(removed, 1)
        self.assertFalse(old_upload.exists())
        self.assertTrue(fresh_upload.exists())
        self.assertTrue(sample_video.exists())


if __name__ == "__main__":
    unittest.main()
