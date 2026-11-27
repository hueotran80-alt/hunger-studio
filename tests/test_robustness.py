"""Phase-1 regression tests: malformed input and request-size limits."""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import helpers  # noqa: E402

SERVER = helpers.load_server()


class RobustnessTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.saved_token = SERVER.STUDIO_TOKEN
        self.saved_config_file = SERVER.bridge_hub.config_file
        self.saved_config = dict(SERVER.bridge_hub.config)
        SERVER.STUDIO_TOKEN = ""
        SERVER.bridge_hub.config_file = os.path.join(self.tmp.name, "ai_config.json")
        SERVER.bridge_hub.config.update({
            "customKey": helpers.FAKE_CUSTOM,
            "customEndpoint": "https://motapis.com/v1",
        })
        self.httpd, self.thread, self.host = helpers.make_server(
            SERVER, directory=self.tmp.name)
        self.limit = SERVER.MAX_JSON_BODY_BYTES

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        SERVER.STUDIO_TOKEN = self.saved_token
        SERVER.bridge_hub.config_file = self.saved_config_file
        SERVER.bridge_hub.config.clear()
        SERVER.bridge_hub.config.update(self.saved_config)
        self.tmp.cleanup()

    def call(self, method, path, body=None, headers=None, raw_body=None):
        return helpers.request(self.host, method, path, body=body,
                               headers=headers, raw_body=raw_body)

    def test_bad_timeout_returns_json_400_instead_of_dropping(self):
        status, _, data = self.call("POST", "/api/execute", {"timeout": "abc", "code": "1"})
        self.assertEqual(status, 400)
        self.assertFalse(data["success"])
        self.assertIn("timeout", json.dumps(data).lower())

    def test_bad_temperature_returns_json_400(self):
        status, _, data = self.call("POST", "/api/ai/chat", {
            "messages": [{"role": "user", "content": "hi"}],
            "temperature": "hot",
        })
        self.assertEqual(status, 400)
        self.assertFalse(data["success"])

    def test_negative_timeout_is_clamped_or_rejected(self):
        status, _, data = self.call("POST", "/api/execute", {"timeout": -5, "code": "1"})
        self.assertIn(status, (200, 400, 500, 503))
        self.assertIsInstance(data, dict)

    def test_oversized_body_is_rejected_with_413(self):
        # Build a payload just over the configured JSON limit.
        oversized = b'{"blob":"' + b"A" * (self.limit + 1024) + b'"}'
        status, _, data = self.call("POST", "/api/ai/chat", raw_body=oversized)
        self.assertEqual(status, 413)
        self.assertFalse(data["success"])

    def test_invalid_json_returns_400(self):
        status, _, data = self.call("POST", "/api/execute", raw_body=b"not-json")
        self.assertEqual(status, 400)
        self.assertFalse(data["success"])

    def test_server_survives_bad_request(self):
        self.call("POST", "/api/execute", {"timeout": "abc", "code": "1"})
        status, _, data = self.call("GET", "/api/status")
        self.assertEqual(status, 200)
        self.assertTrue(data["success"])

    def test_unknown_endpoint_is_json_404(self):
        status, _, data = self.call("POST", "/api/definitely-not-real", {})
        self.assertEqual(status, 404)
        self.assertFalse(data["success"])


if __name__ == "__main__":
    unittest.main()
