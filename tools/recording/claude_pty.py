#!/usr/bin/env python3
"""Run only the real repository Claude launcher; relay its actual PTY bytes.

The config file is private and generated from Daytona's signed preview API.
There is no arbitrary command, shell or filesystem RPC on the remote endpoint.
"""
import argparse
import base64
import fcntl
import json
import os
import pty
import select
import signal
import struct
import termios
import threading
import time
import urllib.request
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--directory", required=True)
    args = parser.parse_args()
    config = json.loads(Path(args.config).read_text())
    directory = Path(args.directory)
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    root = Path(__file__).resolve().parents[2]

    def request(path, content=None):
        from urllib.parse import urlsplit, urlunsplit
        parsed = urlsplit(config["url"])
        endpoint = urlunsplit((parsed.scheme, parsed.netloc, path.split("?", 1)[0], "&".join(filter(None, [parsed.query, path.split("?", 1)[1] if "?" in path else ""])), ""))
        data = json.dumps(content).encode() if content is not None else None
        req = urllib.request.Request(endpoint, data=data, headers={"Authorization": "Bearer " + config["token"], "Content-Type": "application/json", "X-Daytona-Skip-Preview-Warning": "true"})
        with urllib.request.urlopen(req, timeout=25) as response:
            return json.load(response)

    # Wait for the actual command to be typed in the native terminal before launching Claude.
    after = 0
    initial = []
    while True:
        batch = request("/host/input?after=" + str(after))
        initial.extend(batch["events"])
        after = batch["next"]
        if batch["connected"]:
            break

    child, master = pty.fork()
    if child == 0:
        os.chdir(root)
        os.environ.update({"TERM": "xterm-256color", "COLORTERM": "truecolor", "DISABLE_TELEMETRY": "1"})
        os.execvp("node", ["node", str(root / "scripts/claude.mjs"), "--tools", "", "--permission-mode", "dontAsk", "--setting-sources", ""])
    (directory / "claude-pty.pid").write_text(str(os.getpid()))
    (directory / "claude-process.json").write_text(json.dumps({"pid": child, "terminalHost": "Daytona native xfce4-terminal", "processHost": "controller", "transport": "actual PTY bytes", "startedAt": time.time(), "command": "node scripts/claude.mjs --tools '' --permission-mode dontAsk --setting-sources ''"}, indent=2))
    stopped = threading.Event()

    def apply(event):
        if event["kind"] == "resize":
            rows, cols = max(10, min(100, int(event["rows"]))), max(40, min(240, int(event["cols"])))
            fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
            os.kill(child, signal.SIGWINCH)
        elif event["kind"] == "input":
            os.write(master, base64.b64decode(event["data"], validate=True))

    for event in initial:
        apply(event)

    def receive():
        nonlocal after
        try:
            while not stopped.is_set():
                batch = request("/host/input?after=" + str(after))
                for event in batch["events"]:
                    apply(event)
                after = batch["next"]
                if batch["closed"]:
                    stopped.set()
        except Exception as error:
            (directory / "relay-error.txt").write_text(type(error).__name__)
            stopped.set()

    threading.Thread(target=receive, daemon=True).start()
    with (directory / "claude-pty.ndjson").open("w") as transcript:
        try:
            while not stopped.is_set():
                if select.select([master], [], [], 0.2)[0]:
                    try:
                        output = os.read(master, 196608)
                    except OSError:
                        break
                    if not output:
                        break
                    encoded = base64.b64encode(output).decode()
                    transcript.write(json.dumps({"at": time.time(), "data": encoded}) + "\n")
                    transcript.flush()
                    request("/host/output", {"data": encoded})
        finally:
            stopped.set()
            request("/host/close", {})
            try:
                os.kill(child, signal.SIGTERM)
            except ProcessLookupError:
                pass
            os.close(master)


if __name__ == "__main__":
    main()
