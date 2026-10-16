import io
import json
import tempfile
import unittest
from pathlib import Path

from preview_server import create_handler


class PreviewBoundaryTests(unittest.TestCase):
    """Exercise the actual request router with no network socket or credentials."""

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="evidence-preview-test-")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name) / "public"
        self.root.mkdir()
        (self.root / "assets").mkdir()
        self.index = b"<!doctype html><title>Frozen evidence fixture</title>"
        (self.root / "index.html").write_bytes(self.index)
        (self.root / "assets/app.js").write_text("window.fixture=true;", encoding="utf-8")
        # These fixtures must never become directly addressable assets.
        (self.root / ".env").write_text("DUMMY_PRIVATE_MARKER=never-serve", encoding="utf-8")
        (self.root / "preview_server.py").write_text("DUMMY_SERVER_SOURCE", encoding="utf-8")
        outside = Path(self.directory.name) / "outside.txt"
        outside.write_text("DUMMY_OUTSIDE_MARKER", encoding="utf-8")
        (self.root / "assets/outside.txt").symlink_to(outside)
        self.run = {"id": "frozen-run", "prompt": "Public buffer prompt", "provider": "daytona", "status": "completed",
                    "createdAt": 100, "verificationFixture": True, "championId": "c2",
                    "candidates": [{"id": "c2", "sourceHash": "a" * 64, "regressionCount": 1}],
                    "regressions": [{"sequence": [{"reset": True, "write": False, "read": False, "data": 0}]}]}
        (self.root / "run.json").write_text(json.dumps(self.run), encoding="utf-8")
        (self.root / "system.json").write_text(json.dumps({"readOnly": False, "providers": {"daytona": True}}), encoding="utf-8")
        self.handler_type = create_handler(self.root)

    def request(self, path, method="GET"):
        handler = object.__new__(self.handler_type)
        handler.path = path
        handler.command = method
        handler.wfile = io.BytesIO()
        handler.close_connection = False
        status, headers = [], {}
        handler.send_response = lambda code: status.append(code)
        handler.send_header = lambda name, value: headers.__setitem__(name, value)
        handler.end_headers = lambda: None
        getattr(handler, f"do_{method}")()
        self.assertEqual(len(status), 1)
        return status[0], headers, handler.wfile.getvalue(), handler

    def test_static_assets_and_spa_routes_serve_only_frozen_content(self):
        for route in ("/", "/index.html", "/lineage", "/?token=DUMMY_CAPABILITY"):
            with self.subTest(route=route):
                status, headers, body, _ = self.request(route)
                self.assertEqual(status, 200)
                self.assertEqual(body, self.index)
                self.assertEqual(headers["Content-Type"].split(";", 1)[0], "text/html")
                self.assertEqual(headers["Referrer-Policy"], "no-referrer")
                self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
        status, headers, body, _ = self.request("/assets/app.js")
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "text/javascript; charset=utf-8")
        self.assertEqual(body, b"window.fixture=true;")

    def test_run_routes_preserve_evidence_and_export_the_same_snapshot(self):
        for route in ("/api/demo", "/api/runs/frozen-run", "/api/runs/frozen-run/export"):
            with self.subTest(route=route):
                status, headers, body, _ = self.request(route)
                self.assertEqual(status, 200)
                self.assertEqual(json.loads(body), self.run)
                self.assertEqual(headers["Cache-Control"], "no-store")
                if route.endswith("/export"):
                    self.assertEqual(headers["Content-Disposition"], 'attachment; filename="frozen-run.json"')
        status, _, body, _ = self.request("/api/runs")
        self.assertEqual(status, 200)
        summary = json.loads(body)
        self.assertEqual(summary, [{"id": "frozen-run", "prompt": "Public buffer prompt", "provider": "daytona", "status": "completed", "createdAt": 100, "candidates": 1, "championId": "c2"}])

    def test_system_is_forced_read_only_and_live_controller_routes_are_absent(self):
        status, _, body, _ = self.request("/api/system")
        self.assertEqual(status, 200)
        self.assertTrue(json.loads(body)["readOnly"])
        for route in ("/api/runs/other-run", "/api/runs/frozen-run/events", "/api/runs/frozen-run/browser-audit", "/api/private"):
            with self.subTest(route=route):
                status, _, body, _ = self.request(route)
                self.assertEqual(status, 404)
                self.assertNotIn(b"sourceHash", body)

    def test_write_and_tunnel_methods_are_rejected_without_mutating_snapshot(self):
        before = (self.root / "run.json").read_bytes()
        for method in ("POST", "PUT", "PATCH", "DELETE", "OPTIONS", "CONNECT", "TRACE"):
            with self.subTest(method=method):
                status, _, body, handler = self.request("/api/runs/frozen-run", method)
                self.assertEqual(status, 405)
                self.assertTrue(handler.close_connection)
                self.assertIn("read only", json.loads(body)["error"])
        self.assertEqual((self.root / "run.json").read_bytes(), before)

    def test_traversal_and_hidden_or_private_files_are_never_served(self):
        for route in ("/../.env", "/%2e%2e/.env", "/assets/%2e%2e/run.json", "/assets%2f..%2f.env", "/%00", "/assets\\outside.txt"):
            with self.subTest(route=route):
                status, _, body, _ = self.request(route)
                self.assertEqual(status, 400)
                self.assertNotIn(b"DUMMY_", body)
        for route in ("/.env", "/.git/config", "/run.json", "/system.json", "/preview_server.py", "/assets/outside.txt"):
            with self.subTest(route=route):
                status, _, body, _ = self.request(route)
                self.assertEqual(status, 404)
                self.assertNotIn(b"DUMMY_", body)
                self.assertNotIn(b"sourceHash", body)

    def test_asset_whitelist_does_not_expand_after_startup_and_head_omits_body(self):
        (self.root / "later.txt").write_text("DUMMY_NEW_ASSET", encoding="utf-8")
        status, _, body, _ = self.request("/later.txt")
        self.assertEqual(status, 404)
        self.assertNotIn(b"DUMMY_NEW_ASSET", body)
        status, headers, body, _ = self.request("/api/runs/frozen-run", "HEAD")
        self.assertEqual(status, 200)
        self.assertEqual(body, b"")
        self.assertGreater(int(headers["Content-Length"]), 0)


if __name__ == "__main__":
    unittest.main()
