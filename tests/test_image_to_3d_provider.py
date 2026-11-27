"""Giai đoạn 2.3 — Cloud Image-to-3D provider layer (Tripo3D / Meshy / Fal.ai).

Kiểm tra phần thuần logic KHÔNG gọi mạng thật:
- phân giải API key (env > config), ẩn key khỏi public config
- submit payload đúng schema từng provider (mock urlopen)
- poll state machine (running/succeeded/failed)
- extract link GLB từ payload từng provider
- GLB inspector đọc bounding box thật
"""
import base64
import io
import json
import os
import sys
import tempfile
import unittest
import urllib.request
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import hunyuan3d_engine


def _png_bytes():
    # PNG header + garbage body — chỉ cần ext+magic cho _encode (không quan trọng nội dung)
    return b"\x89PNG\r\n\x1a\n" + b"0" * 64


def _mock_urlopen_return(json_obj, status=200):
    """Trả về context manager mô phỏng urllib response JSON."""
    body = json.dumps(json_obj).encode("utf-8")

    class FakeResp(io.BytesIO):
        def __init__(self, buf, st):
            super().__init__(buf)
            self.status = st

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    return FakeResp(body, status)


class ProviderKeyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.engine = hunyuan3d_engine.Hunyuan3DEngine(
            config_path=str(Path(self.tmp.name, "c.json")))

    def tearDown(self):
        self.tmp.cleanup()

    def test_key_from_env_wins_and_public_config_hides_key(self):
        self.engine.config["providerKey"] = "cfg-key"
        with patch.dict(os.environ, {"TRIPO_API_KEY": "env-key"}):
            self.assertEqual(self.engine._provider_api_key("tripo"), "env-key")
        pub = self.engine._public_config()
        self.assertNotIn("providerKey", pub)
        self.assertTrue(pub["providerKeyConfigured"])

    def test_key_from_config_when_no_env(self):
        self.engine.config["providerKey"] = "cfg-key"
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(self.engine._provider_api_key("meshy"), "cfg-key")

    def test_missing_key_raises_readable_error_on_submit(self):
        self.engine.config.pop("providerKey", None)
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(RuntimeError) as ctx:
                self.engine._submit_provider_task("tripo", "/tmp/x.png", {})
            self.assertIn("API key", str(ctx.exception))


class ProviderSubmitPollTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.engine = hunyuan3d_engine.Hunyuan3DEngine(
            config_path=str(Path(self.tmp.name, "c.json")))
        self.engine.config["providerKey"] = "test-key"
        self.image = Path(self.tmp.name, "in.png")
        self.image.write_bytes(_png_bytes())

    def tearDown(self):
        self.tmp.cleanup()

    def test_tripo_submit_payload_and_returns_task_id(self):
        captured = {}

        def fake_urlopen(req, data=None, timeout=None):
            captured["url"] = req.full_url
            captured["payload"] = json.loads(data.decode("utf-8"))
            captured["auth"] = req.headers.get("Authorization")
            return _mock_urlopen_return(
                {"success": True, "data": {"task_id": "task-123"}})

        with patch("urllib.request.urlopen", side_effect=fake_urlopen):
            task_id = self.engine._submit_provider_task("tripo", str(self.image), {})
        self.assertEqual(task_id, "task-123")
        self.assertIn("api.tripo3d.ai", captured["url"])
        self.assertEqual(captured["auth"], "Bearer test-key")
        self.assertEqual(captured["payload"]["type"], "image_to_model")

    def test_meshy_submit_returns_result_id(self):
        with patch("urllib.request.urlopen",
                   return_value=_mock_urlopen_return({"result": "meshy-42"})):
            task_id = self.engine._submit_provider_task("meshy", str(self.image), {})
        self.assertEqual(task_id, "meshy-42")

    def test_tripo_poll_states(self):
        cases = {
            "running": ("running", {"status": "running"}),
            "succeeded": ("succeeded", {"status": "success", "model": {"url": "http://x/a.glb"}}),
            "failed": ("failed", {"status": "failed"}),
        }
        for case_name, (expected, payload) in cases.items():
            merged = {"data": payload, "success": True}
            with patch("urllib.request.urlopen",
                       return_value=_mock_urlopen_return(merged)):
                status, data = self.engine._poll_provider_task("tripo", "t1", "k")
            self.assertEqual(status, expected, (expected, payload, status))

    def test_meshy_poll_states(self):
        for raw, expected in (("IN_PROGRESS", "running"), ("SUCCEEDED", "succeeded"), ("FAILED", "failed")):
            with patch("urllib.request.urlopen",
                       return_value=_mock_urlopen_return({"status": raw})):
                status, _ = self.engine._poll_provider_task("meshy", "t1", "k")
            self.assertEqual(status, expected, raw)

    def test_extract_glb_url_per_provider(self):
        self.assertEqual(
            self.engine._extract_provider_glb_url(
                "tripo", {"model": {"url": "http://t/a.glb"}}),
            "http://t/a.glb")
        self.assertEqual(
            self.engine._extract_provider_glb_url(
                "meshy", {"model_urls": {"glb": {"url": "http://m/a.glb"}}}),
            "http://m/a.glb")
        self.assertEqual(
            self.engine._extract_provider_glb_url(
                "fal", {"output": {"mesh_file": "http://f/a.glb"}}),
            "http://f/a.glb")

    def test_inspect_glb_reads_real_bbox(self):
        # GLB thật tối giản: JSON chunk khai báo 1 accessor VEC3 min/max
        glb_json = {
            "asset": {"version": "2.0"},
            "accessors": [
                {"type": "VEC3", "count": 8, "min": [-1, 0, -1], "max": [1, 2, 1]},
                {"type": "SCALAR", "count": 36},
            ],
        }
        js = json.dumps(glb_json).encode("utf-8")
        buf = io.BytesIO()
        buf.write(b"glTF")
        buf.write((2).to_bytes(4, "little"))  # version 2
        buf.write((len(js) + 8).to_bytes(4, "little"))  # total file length
        buf.write(len(js).to_bytes(4, "little"))  # JSON chunk length
        buf.write(b"JSON")                        # chunk type
        buf.write(js)
        p = Path(self.tmp.name, "m.glb")
        p.write_bytes(buf.getvalue())
        nv, nf, dx, dy, dz = self.engine._inspect_glb(str(p))
        self.assertEqual(nv, 8)
        self.assertEqual(nf, 12)
        self.assertAlmostEqual(dx, 2.0)
        self.assertAlmostEqual(dy, 2.0)
        self.assertAlmostEqual(dz, 2.0)


if __name__ == "__main__":
    unittest.main()
