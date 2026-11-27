"""Wave 1A tests: .blend headless conversion service & server.py routes."""

import base64
import json
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import blend_converter  # noqa: E402
import helpers  # noqa: E402

SERVER = helpers.load_server()


class BlendConverterUnitTests(unittest.TestCase):
    def test_magic_bytes_validation(self):
        self.assertTrue(blend_converter.is_valid_blend_bytes(b"BLENDER-v306\x00\x00\x00"))
        self.assertTrue(blend_converter.is_valid_blend_bytes(b"\x1f\x8b\x08\x00" + b"\x00" * 16))
        self.assertTrue(blend_converter.is_valid_blend_bytes(b"\x28\xb5\x2f\xfd" + b"\x00" * 16))
        self.assertFalse(blend_converter.is_valid_blend_bytes(b"glTF\x02\x00\x00\x00\x00\x00\x00\x00"))
        self.assertFalse(blend_converter.is_valid_blend_bytes(b"SHORT"))

    def test_broken_wrapper_not_reported_available(self):
        with tempfile.TemporaryDirectory() as tmp:
            bad_bin = os.path.join(tmp, "blender")
            with open(bad_bin, "w", encoding="utf-8") as f:
                f.write("#!/bin/sh\nexit 127\n")
            os.chmod(bad_bin, 0o755)
            probe_explicit = blend_converter.find_blender_binary({"BLENDER_BIN": bad_bin, "PATH": tmp})
            self.assertFalse(probe_explicit["available"])
            probe_path = blend_converter.find_blender_binary({"PATH": tmp}, standard_paths=())
            self.assertFalse(probe_path["available"])

    def test_convert_raises_when_missing_and_succeeds_with_executable_mock(self):
        raw_blend = b"BLENDER-v400" + b"\x00" * 64
        with self.assertRaises(blend_converter.BlenderNotAvailableError):
            blend_converter.convert_blend_bytes_to_glb(raw_blend, blender_bin="/nonexistent/blender")

        with tempfile.TemporaryDirectory() as tmp:
            fake_blender = os.path.join(tmp, "blender")
            with open(fake_blender, "w", encoding="utf-8") as f:
                f.write(
                    "#!/usr/bin/env python3\n"
                    "import json, sys\n"
                    "if '--version' in sys.argv:\n"
                    "    print('Blender 4.2.1'); sys.exit(0)\n"
                    "args = sys.argv[sys.argv.index('--') + 1:]\n"
                    "out_glb, report_json = args[0], args[1]\n"
                    "with open(out_glb, 'wb') as g: g.write(b'glTF\\x02\\x00\\x00\\x00')\n"
                    "with open(report_json, 'w') as r: json.dump({'meshCount': 2, 'apply': '--apply-modifiers' in args}, r)\n"
                )
            os.chmod(fake_blender, os.stat(fake_blender).st_mode | stat.S_IXUSR)

            res = blend_converter.convert_blend_bytes_to_glb(
                raw_blend,
                apply_modifiers=True,
                blender_bin=fake_blender,
            )
            self.assertTrue(res["glbBytes"].startswith(b"glTF"))
            self.assertEqual(res["report"]["meshCount"], 2)
            self.assertEqual(res["report"]["apply"], True)
            self.assertIn("4.2.1", res["blenderVersion"])


class BlendServerApiTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.saved_token = SERVER.STUDIO_TOKEN
        SERVER.STUDIO_TOKEN = ""
        self.httpd, self.thread, self.host = helpers.make_server(SERVER, directory=self.tmp.name)

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.tmp.cleanup()
        SERVER.STUDIO_TOKEN = self.saved_token

    def test_status_and_503_when_blender_missing(self):
        with patch.object(blend_converter, "find_blender_binary", return_value={
            "available": False, "path": None, "version": None, "error": "Blender not installed"
        }):
            code, _, body = helpers.request(self.host, "GET", "/api/import/blend/status")
            self.assertEqual(code, 200)
            self.assertFalse(body["available"])

            raw_b64 = base64.b64encode(b"BLENDER-v400\x00\x00\x00\x00").decode("ascii")
            code2, _, body2 = helpers.request(self.host, "POST", "/api/import/blend", {
                "fileName": "hero.blend",
                "fileData": raw_b64,
            })
            self.assertEqual(code2, 503)
            self.assertEqual(body2["code"], "BLENDER_NOT_INSTALLED")

    def test_rejects_bad_extension_and_bad_magic(self):
        code, _, _ = helpers.request(self.host, "POST", "/api/import/blend", {
            "fileName": "evil.exe",
            "fileData": base64.b64encode(b"BLENDER-v400\x00\x00").decode("ascii"),
        })
        self.assertEqual(code, 415)

        code2, _, body2 = helpers.request(self.host, "POST", "/api/import/blend", {
            "fileName": "fake.blend",
            "fileData": base64.b64encode(b"NOT_A_BLEND_FILE").decode("ascii"),
        })
        self.assertEqual(code2, 415)
        self.assertEqual(body2["code"], "INVALID_BLEND")

    def test_end_to_end_blend_upload_conversion_with_mock_blender(self):
        fake_blender = os.path.join(self.tmp.name, "blender")
        with open(fake_blender, "w", encoding="utf-8") as f:
            f.write(
                "#!/usr/bin/env python3\n"
                "import json, sys\n"
                "if '--version' in sys.argv:\n"
                "    print('Blender 4.3.0'); sys.exit(0)\n"
                "args = sys.argv[sys.argv.index('--') + 1:]\n"
                "with open(args[0], 'wb') as g: g.write(b'glTF_MOCK_BINARY')\n"
                "with open(args[1], 'w') as r: json.dump({'meshCount': 1, 'warnings': []}, r)\n"
            )
        os.chmod(fake_blender, 0o755)

        with patch.dict(os.environ, {"BLENDER_BIN": fake_blender}):
            code, _, payload = helpers.request(self.host, "POST", "/api/import/blend", {
                "fileName": "scene.blend",
                "fileData": base64.b64encode(b"BLENDER-v400\x00\x00\x00\x00").decode("ascii"),
            })
            self.assertEqual(code, 200)
            self.assertTrue(payload["success"])
            self.assertEqual(payload["fileName"], "scene.glb")
            self.assertEqual(base64.b64decode(payload["glbBase64"]), b"glTF_MOCK_BINARY")
            self.assertEqual(payload["report"]["meshCount"], 1)


if __name__ == "__main__":
    unittest.main()
