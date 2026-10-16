#!/usr/bin/env python3
"""A private, expiring PTY byte relay for filming the real Claude CLI in Daytona.

No terminal UI is rendered here. xfce4-terminal renders the installed Claude
process's actual output, like an SSH terminal. Claude and its sign-in stay on the
controller. The relay cannot start a shell or choose a controller command.
"""
import argparse
import base64
import json
import os
import select
import sys
import termios
import threading
import time
import tty
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["server", "client"])
    parser.add_argument("--directory", required=True)
    parser.add_argument("--port", type=int, default=8778)
    args = parser.parse_args()
    directory = Path(args.directory)
    secret = json.loads((directory / "relay-secret.json").read_text())
    token = secret["token"]
    if args.mode == "client":
        client(args.port, token)
    else:
        server(args.port, token, secret["expiresAt"], directory)


def server(port, token, expires_at, directory):
    condition = threading.Condition()
    state = {"input": [], "output": [], "connected": False, "closed": False, "bytes": 0}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def handle_request(self):
            if self.headers.get("Authorization") != "Bearer " + token or time.time() > expires_at:
                self.send_error(403)
                return
            from urllib.parse import urlparse, parse_qs
            parsed = urlparse(self.path)
            path = parsed.path
            content = None
            if self.command == "POST":
                size = int(self.headers.get("Content-Length", "0"))
                if size < 0 or size > 524288:
                    self.send_error(413)
                    return
                content = json.loads(self.rfile.read(size) or b"{}")
            with condition:
                if path == "/client/connect" and self.command == "POST":
                    state["connected"] = True
                    state["input"].append({"kind": "resize", "rows": content["rows"], "cols": content["cols"]})
                    result = {"ok": True}
                elif path in ["/client/input", "/client/resize"] and self.command == "POST":
                    state["input"].append(content)
                    result = {"ok": True}
                elif path == "/host/output" and self.command == "POST":
                    data = base64.b64decode(content["data"], validate=True)
                    state["bytes"] += len(data)
                    if state["bytes"] > 64 * 1024 * 1024:
                        self.send_error(413)
                        return
                    state["output"].append(content["data"])
                    result = {"ok": True}
                elif path in ["/host/input", "/client/output"] and self.command == "GET":
                    name = "input" if path == "/host/input" else "output"
                    after = max(0, int(parse_qs(parsed.query).get("after", ["0"])[0]))
                    deadline = time.monotonic() + 15
                    while len(state[name]) <= after and not state["closed"] and time.monotonic() < deadline:
                        condition.wait(max(0, deadline - time.monotonic()))
                    batch = state[name][after:after + 100]
                    result = {"events": batch, "next": after + len(batch), "closed": state["closed"], "connected": state["connected"]}
                elif path == "/host/status" and self.command == "GET":
                    result = {"connected": state["connected"], "closed": state["closed"], "output_chunks": len(state["output"])}
                elif path == "/host/close" and self.command == "POST":
                    state["closed"] = True
                    result = {"ok": True}
                else:
                    self.send_error(404)
                    return
                condition.notify_all()
            body = json.dumps(result).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            self.handle_request()

        def do_POST(self):
            self.handle_request()

    httpd = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    httpd.daemon_threads = True
    (directory / "relay.pid").write_text(str(os.getpid()))
    httpd.serve_forever()


def client(port, token):
    import signal
    base = "http://127.0.0.1:" + str(port)

    def request(path, content=None):
        data = json.dumps(content).encode() if content is not None else None
        req = urllib.request.Request(base + path, data=data, headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=25) as response:
            return json.load(response)

    def resize(*_):
        size = os.get_terminal_size()
        request("/client/resize", {"kind": "resize", "rows": size.lines, "cols": size.columns})

    size = os.get_terminal_size()
    request("/client/connect", {"rows": size.lines, "cols": size.columns})
    old = termios.tcgetattr(sys.stdin)
    tty.setraw(sys.stdin)
    signal.signal(signal.SIGWINCH, resize)
    closed = threading.Event()

    def receive():
        after = 0
        try:
            while not closed.is_set():
                result = request("/client/output?after=" + str(after))
                for chunk in result["events"]:
                    os.write(sys.stdout.fileno(), base64.b64decode(chunk))
                after = result["next"]
                if result["closed"]:
                    closed.set()
        finally:
            closed.set()

    threading.Thread(target=receive, daemon=True).start()
    try:
        while not closed.is_set():
            if select.select([sys.stdin], [], [], 0.2)[0]:
                data = os.read(sys.stdin.fileno(), 65536)
                if not data:
                    break
                request("/client/input", {"kind": "input", "data": base64.b64encode(data).decode()})
    finally:
        closed.set()
        termios.tcsetattr(sys.stdin, termios.TCSADRAIN, old)
        print()


if __name__ == "__main__":
    main()
