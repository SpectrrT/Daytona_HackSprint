import base64
import json
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request


class RelayTests(unittest.TestCase):
    def test_private_transport_preserves_terminal_bytes_and_cannot_execute_a_command(self):
        with tempfile.TemporaryDirectory() as directory:
            token = "test-only-token"
            Path(directory, "relay-secret.json").write_text(json.dumps({"token": token, "expiresAt": time.time() + 30}))
            with socket.socket() as sock:
                sock.bind(("127.0.0.1", 0))
                port = sock.getsockname()[1]
            process = subprocess.Popen([sys.executable, str(Path(__file__).with_name("terminal_relay.py")), "server", "--directory", directory, "--port", str(port)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

            def request(path, content=None, bearer=token):
                data = json.dumps(content).encode() if content is not None else None
                req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=data, headers={"Authorization": "Bearer " + bearer})
                with urllib.request.urlopen(req, timeout=2) as response:
                    return json.load(response)

            try:
                for _ in range(50):
                    try:
                        request("/host/status")
                        break
                    except urllib.error.URLError:
                        time.sleep(0.02)
                with self.assertRaises(urllib.error.HTTPError) as denied:
                    request("/host/status", bearer="wrong")
                self.assertEqual(denied.exception.code, 403)
                denied.exception.close()
                request("/client/connect", {"rows": 42, "cols": 120})
                raw = b"\x1b[38;5;141mreal PTY bytes\x1b[0m\r\n"
                request("/host/output", {"data": base64.b64encode(raw).decode()})
                result = request("/client/output?after=0")
                self.assertEqual(base64.b64decode(result["events"][0]), raw)
                self.assertEqual(result["next"], 1)
                request("/client/input", {"kind": "input", "data": base64.b64encode(b"hello\r").decode()})
                result = request("/host/input?after=0")
                self.assertEqual(result["events"][0], {"kind": "resize", "rows": 42, "cols": 120})
                self.assertEqual(base64.b64decode(result["events"][1]["data"]), b"hello\r")
                with self.assertRaises(urllib.error.HTTPError) as unknown:
                    request("/exec", {"command": "whoami"})
                self.assertEqual(unknown.exception.code, 404)
                unknown.exception.close()
                request("/host/close", {})
                self.assertTrue(request("/host/status")["closed"])
            finally:
                process.terminate()
                process.wait(timeout=5)


if __name__ == "__main__":
    unittest.main()
