"""Private-port relay to the demo Chromium's loopback-only DevTools socket.

Daytona's signed preview protects port 9223. No account browser is attached.
The controller uses this connection for DOM geometry and network observations.
"""
import select
import socket
import socketserver


class Relay(socketserver.BaseRequestHandler):
    def handle(self):
        self.request.settimeout(20)
        header = b''
        while b'\r\n\r\n' not in header:
            chunk = self.request.recv(4096)
            if not chunk or len(header) > 65536:
                return
            header += chunk
        first, remaining = header.split(b'\r\n\r\n', 1)
        lines = first.split(b'\r\n')
        if not lines[0].startswith(b'GET /devtools/browser/'):
            return
        lines = [line for line in lines if not line.lower().startswith((b'host:', b'origin:'))]
        lines.append(b'Host: 127.0.0.1:9222')
        with socket.create_connection(('127.0.0.1', 9222), timeout=10) as upstream:
            upstream.sendall(b'\r\n'.join(lines) + b'\r\n\r\n' + remaining)
            self.request.settimeout(None)
            upstream.settimeout(None)
            while True:
                ready, _, _ = select.select([self.request, upstream], [], [], 60)
                if not ready:
                    continue
                for source in ready:
                    data = source.recv(65536)
                    if not data:
                        return
                    (upstream if source is self.request else self.request).sendall(data)


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == '__main__':
    with Server(('0.0.0.0', 9223), Relay) as server:
        server.serve_forever()
