"""Phase-1 regression tests: Hunyuan3D upload hardening."""
import base64
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import hunyuan3d_engine


def b64(data):
    return base64.b64encode(data).decode("ascii")


class HunyuanUploadTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.saved_inputs = hunyuan3d_engine.INPUTS_DIR
        hunyuan3d_engine.INPUTS_DIR = self.tmp.name

    def tearDown(self):
        hunyuan3d_engine.INPUTS_DIR = self.saved_inputs
        self.tmp.cleanup()

    def test_rejects_html_and_svg(self):
        engine = hunyuan3d_engine.Hunyuan3DEngine(config_path=str(Path(self.tmp.name, "c.json")))
        for name in ("poc.html", "poc.svg", "poc.js"):
            with self.assertRaises(ValueError):
                engine.save_uploaded_image(b64(b"<script>alert(1)</script>"), name)
        self.assertEqual(list(Path(self.tmp.name).glob("*")), [])

    def test_accepts_png_and_generates_name(self):
        engine = hunyuan3d_engine.Hunyuan3DEngine(config_path=str(Path(self.tmp.name, "c.json")))
        result = engine.save_uploaded_image(b64(b"\x89PNG\r\n\x1a\nfake"), "../../evil.png", slot="0")
        self.assertTrue(result["success"])
        self.assertRegex(result["name"], r"^input_[A-Za-z0-9_-]+_\d+_[0-9a-f]{8}\.png$")
        self.assertNotIn("..", result["name"])
        self.assertTrue(Path(self.tmp.name, result["name"]).is_file())

    def test_slot_is_sanitized(self):
        engine = hunyuan3d_engine.Hunyuan3DEngine(config_path=str(Path(self.tmp.name, "c.json")))
        result = engine.save_uploaded_image(b64(b"\x89PNG\r\n\x1a\nfake"), "x.png", slot="../../etc")
        self.assertTrue(result["success"])
        self.assertNotIn("/", result["name"])
        self.assertNotIn("..", result["name"])

    def test_rejects_oversized_upload(self):
        engine = hunyuan3d_engine.Hunyuan3DEngine(config_path=str(Path(self.tmp.name, "c.json")))
        too_big = b"\x89PNG\r\n\x1a\n" + b"A" * (hunyuan3d_engine.MAX_IMAGE_UPLOAD_BYTES + 1)
        with self.assertRaises(ValueError):
            engine.save_uploaded_image(b64(too_big), "big.png")

    def test_rejects_invalid_base64(self):
        engine = hunyuan3d_engine.Hunyuan3DEngine(config_path=str(Path(self.tmp.name, "c.json")))
        with self.assertRaises(ValueError):
            engine.save_uploaded_image("not-base64!!!", "x.png")


class HunyuanStatusRedactionTests(unittest.TestCase):
    def test_status_never_includes_hf_token(self):
        engine = hunyuan3d_engine.Hunyuan3DEngine(config_path=str(Path(tempfile.gettempdir(), "missing.json")))
        engine.config["hfToken"] = "hf_FAKEhuggingfacetoken0123456789abcdef"
        engine.config["providerKey"] = "trp_FAKEproviderkey0123456789abcdef"
        status = engine.get_status()
        self.assertNotIn("hfToken", status.get("config", {}))
        self.assertNotIn("providerKey", status.get("config", {}))
        self.assertNotIn("endpoint", status.get("config", {}))
        self.assertNotIn("colabUrl", status.get("config", {}))
        self.assertNotIn("localRepoPath", status.get("config", {}))
        self.assertTrue(status.get("config", {}).get("hfTokenConfigured"))
        self.assertNotIn("hf_FAKEhuggingfacetoken0123456789abcdef", str(status))
        self.assertNotIn("trp_FAKEproviderkey0123456789abcdef", str(status))

    def test_start_generation_never_leaks_secrets_and_gates_unready_backend(self):
        with tempfile.TemporaryDirectory() as tmp:
            cfg = Path(tmp, "c.json")
            cfg.write_text('{"hunyuan3d":{"hfToken":"hf_FAKEGEN_123","providerKey":"trp_FAKEGEN_456","mode":"tripo"}}')
            img = Path(tmp, "in.png")
            img.write_bytes(b"\x89PNG\r\n\x1a\n" + b"0" * 32)
            engine = hunyuan3d_engine.Hunyuan3DEngine(config_path=str(cfg))
            with patch.object(hunyuan3d_engine, "INPUTS_DIR", tmp), \
                 patch.object(engine, "_run_generation_task", return_value=None):
                res = engine.start_generation(str(img), {"steps": 15})
            self.assertTrue(res.get("success"), res)
            self.assertNotIn("hf_FAKEGEN_123", str(res))
            self.assertNotIn("trp_FAKEGEN_456", str(res))
            self.assertNotIn("hfToken", res.get("options", {}))
            self.assertNotIn("providerKey", res.get("options", {}))

        with tempfile.TemporaryDirectory() as tmp:
            cfg = Path(tmp, "c2.json")
            cfg.write_text('{"hunyuan3d":{"mode":"auto"}}')
            img = Path(tmp, "in2.png")
            img.write_bytes(b"\x89PNG\r\n\x1a\n" + b"0" * 32)
            engine = hunyuan3d_engine.Hunyuan3DEngine(config_path=str(cfg))
            with patch.object(hunyuan3d_engine, "INPUTS_DIR", tmp), \
                 patch.object(engine, "check_gradio_health", return_value=(False, "Chưa kết nối")), \
                 patch.object(engine, "check_local_repo", return_value=(False, None)):
                res = engine.start_generation(str(img), {})
            self.assertFalse(res.get("success"))
            self.assertTrue(res.get("maintenance"))

    def test_path_containment_blocks_traversal_outside_and_symlinks(self):
        with tempfile.TemporaryDirectory() as allowed_dir, tempfile.TemporaryDirectory() as outside_dir:
            outside_img = Path(outside_dir, "secret.png")
            outside_img.write_bytes(b"\x89PNG\r\n\x1a\n" + b"0" * 32)
            escape_link = Path(allowed_dir, "escape.png")
            escape_link.symlink_to(outside_img)
            bad_ext = Path(allowed_dir, "script.py")
            bad_ext.write_text("print(1)")

            cfg = Path(allowed_dir, "c.json")
            cfg.write_text('{"hunyuan3d":{"providerKey":"trp_TEST","mode":"tripo"}}')
            engine = hunyuan3d_engine.Hunyuan3DEngine(config_path=str(cfg))
            with patch.object(hunyuan3d_engine, "INPUTS_DIR", allowed_dir), \
                 patch.object(hunyuan3d_engine, "MODELS_DIR", allowed_dir), \
                 patch.object(hunyuan3d_engine, "ASSETS_DIR", allowed_dir):
                for bad_path in (
                    "../../etc/passwd",
                    "models/../../etc/passwd.png",
                    str(outside_img),
                    str(escape_link),
                    str(bad_ext),
                ):
                    with self.assertRaises(hunyuan3d_engine.UploadRejected, msg=f"must reject {bad_path}"):
                        engine._resolve_contained_image_path(bad_path, require_exists=False)
                    res = engine.start_generation(bad_path, {})
                    self.assertFalse(res.get("success"), f"start_generation must reject {bad_path}")
                    self.assertIn(res.get("status"), (400, 403, 415))


if __name__ == "__main__":
    unittest.main()
