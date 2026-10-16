#!/usr/bin/env python3
"""Serve a frozen, read-only evidence bundle. No controller or shell endpoints."""
from __future__ import annotations

import argparse
import json
import mimetypes
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path, PurePosixPath
from urllib.parse import unquote, urlsplit


def create_handler(root: Path):
    root = root.resolve(strict=True)
    run = json.loads((root / "run.json").read_text(encoding="utf-8"))
    system = json.loads((root / "system.json").read_text(encoding="utf-8"))
    system["readOnly"] = True
    run_id = run["id"]
    if not isinstance(run_id, str) or not re.fullmatch(r"[a-zA-Z0-9_-]{1,100}", run_id):
        raise ValueError("Invalid evidence run id")
    summary = {key: run[key] for key in ("id", "prompt", "provider", "status", "createdAt")}
    summary["candidates"] = len(run.get("candidates", []))
    if run.get("championId"):
        summary["championId"] = run["championId"]
    index = (root / "index.html").read_bytes()
    forbidden = {"run.json", "system.json", "preview_server.py"}
    # The whitelist is built once. New or outside files cannot become web assets.
    assets: dict[str, Path] = {}
    for candidate in root.rglob("*"):
        relative = candidate.relative_to(root)
        if (candidate.is_file() and not candidate.is_symlink()
                and candidate.resolve().is_relative_to(root)
                and not any(part.startswith(".") for part in relative.parts)
                and str(relative) not in forbidden):
            assets["/" + relative.as_posix()] = candidate

    class EvidenceHandler(BaseHTTPRequestHandler):
        server_version = "AntibodyEvidence/1"
        sys_version = ""

        def log_message(self, _format, *_args):
            # Signed preview URLs may carry a capability in their query string.
            return

        def _send(self, status: int, body: bytes, mime: str = "application/json; charset=utf-8", *, download=False):
            self.send_response(status)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store" if "json" in mime or "html" in mime else "public, max-age=300")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
            if download:
                self.send_header("Content-Disposition", f'attachment; filename="{run_id}.json"')
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def _json(self, value, status=200, **kwargs):
            self._send(status, json.dumps(value, ensure_ascii=False).encode("utf-8"), **kwargs)

        def do_GET(self):
            try:
                path = unquote(urlsplit(self.path).path, errors="strict")
                if "\x00" in path or "\\" in path or any(p in {"..", "."} for p in path.split("/")):
                    return self._json({"error": "Invalid path."}, 400)
            except (UnicodeError, ValueError):
                return self._json({"error": "Invalid path."}, 400)
            if path in {"/api/demo", f"/api/runs/{run_id}"}:
                return self._json(run)
            if path == f"/api/runs/{run_id}/export":
                return self._json(run, download=True)
            if path == "/api/runs":
                return self._json([summary])
            if path == "/api/system":
                return self._json(system)
            if path.startswith("/api/"):
                return self._json({"error": "This snapshot has no live controller endpoint."}, 404)
            if path in assets:
                asset = assets[path]
                mime = mimetypes.guess_type(asset.name)[0] or "application/octet-stream"
                if asset.suffix == ".js":
                    mime = "text/javascript; charset=utf-8"
                return self._send(200, asset.read_bytes(), mime)
            if path in {"/", "/index.html"} or (not PurePosixPath(path).suffix and not any(p.startswith(".") for p in path.split("/") if p)):
                return self._send(200, index, "text/html; charset=utf-8")
            return self._json({"error": "Asset not found."}, 404)

        do_HEAD = do_GET

        def _read_only(self):
            self.close_connection = True
            self._json({"error": "Evidence snapshot is read only. No live controller is exposed."}, 405)

        do_POST = _read_only
        do_PUT = _read_only
        do_PATCH = _read_only
        do_DELETE = _read_only
        do_OPTIONS = _read_only
        do_CONNECT = _read_only
        do_TRACE = _read_only

    return EvidenceHandler


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path("/home/daytona/evidence"))
    parser.add_argument("--port", type=int, default=8080)
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535:
        parser.error("port must be between 1024 and 65535")
    server = ThreadingHTTPServer(("0.0.0.0", args.port), create_handler(args.root))
    server.daemon_threads = True
    print(f"Read-only evidence server listening on port {args.port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
