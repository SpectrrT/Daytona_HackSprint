"""Fixed web/SQLite harness. Agents edit checkout.py only; grading stays on the controller."""
import hashlib
import importlib.util
import json
import pathlib
import sqlite3
import sys
import threading
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = pathlib.Path(__file__).resolve().parent
LOCK = threading.Lock()
SOURCE_HASH = hashlib.sha256((ROOT / 'checkout.py').read_bytes()).hexdigest() if (ROOT / 'checkout.py').exists() else ''
RUNTIME_HASH = hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest()


def connect():
    db = sqlite3.connect(ROOT / 'store.db', isolation_level=None, timeout=10)
    # The candidate has business DML and transactions, but cannot alter the schema.
    deny = {sqlite3.SQLITE_ATTACH, sqlite3.SQLITE_DETACH, sqlite3.SQLITE_ALTER_TABLE,
            sqlite3.SQLITE_DROP_TABLE, sqlite3.SQLITE_DROP_INDEX, sqlite3.SQLITE_CREATE_TABLE,
            sqlite3.SQLITE_CREATE_INDEX, sqlite3.SQLITE_PRAGMA}
    db.set_authorizer(lambda action, *_: sqlite3.SQLITE_DENY if action in deny else sqlite3.SQLITE_OK)
    return db


def reset():
    for suffix in ('', '-wal', '-shm'):
        (ROOT / ('store.db' + suffix)).unlink(missing_ok=True)
    (ROOT / 'requests.ndjson').write_text('')
    db = sqlite3.connect(ROOT / 'store.db')
    db.executescript('''
      CREATE TABLE inventory(id INTEGER PRIMARY KEY, stock INTEGER NOT NULL CHECK(stock>=0), unit_price_cents INTEGER NOT NULL);
      INSERT INTO inventory VALUES(1,5,1999);
      CREATE TABLE orders(id INTEGER PRIMARY KEY AUTOINCREMENT,request_id TEXT NOT NULL,quantity INTEGER NOT NULL,total_cents INTEGER NOT NULL);
    ''')
    db.commit()
    db.close()


def snapshot():
    db = sqlite3.connect('file:' + str(ROOT / 'store.db') + '?mode=ro', uri=True)
    try:
        stock = db.execute('SELECT stock FROM inventory WHERE id=1').fetchone()[0]
        orders = [{'id': row[0], 'requestId': row[1], 'quantity': row[2], 'totalCents': row[3]}
                  for row in db.execute('SELECT id,request_id,quantity,total_cents FROM orders ORDER BY id')]
        return {'stock': stock, 'orders': orders, 'sourceHash': SOURCE_HASH, 'runtimeHash': RUNTIME_HASH}
    finally:
        db.close()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def send(self, status, value, content_type='application/json', candidate_hash=None):
        data = value if isinstance(value, bytes) else json.dumps(value).encode()
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Candidate-SHA256', candidate_hash if candidate_hash is not None else SOURCE_HASH)
        self.end_headers()
        self.wfile.write(data)

    def proxy(self, data=None):
        target = json.loads((ROOT / 'target.json').read_text())['url'].rstrip('/')
        req = urllib.request.Request(target + self.path, data=data,
            headers={'Content-Type': 'application/json', 'X-Daytona-Skip-Preview-Warning': 'true'})
        try:
            # Targets are this sandbox or a named child on its Daytona link network.
            response = urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req, timeout=20)
        except urllib.error.HTTPError as error:
            response = error
        except (urllib.error.URLError, TimeoutError):
            return self.send(503, {'error': 'Candidate is restarting'})
        with response:
            self.send(response.status, response.read(), candidate_hash=response.headers.get('X-Candidate-SHA256', ''))

    def do_GET(self):
        if self.path == '/':
            return self.send(200, (ROOT / 'index.html').read_bytes(), 'text/html; charset=utf-8')
        if self.path == '/healthz':
            return self.send(200, {'ok': True, 'sourceHash': SOURCE_HASH})
        if self.path == '/api/state':
            if self.server.server_port == 8080:
                return self.proxy()
            return self.send(200, snapshot())
        return self.send(404, {'error': 'Not found'})

    def do_POST(self):
        if self.path != '/api/checkout':
            return self.send(404, {'error': 'Not found'})
        try:
            length = int(self.headers.get('Content-Length', 0))
            if not 0 < length <= 16384:
                return self.send(400, {'error': 'Invalid body length'})
            raw = self.rfile.read(length)
            if self.server.server_port == 8080:
                return self.proxy(raw)
            body = json.loads(raw)
            if not isinstance(body, dict) or set(body) != {'requestId', 'quantity'}:
                return self.send(400, {'error': 'Invalid fields'})
        except (ValueError, json.JSONDecodeError):
            return self.send(400, {'error': 'Invalid JSON'})
        db = connect()
        try:
            status, result = self.server.checkout(db, body['requestId'], body['quantity'])
            if not isinstance(status, int) or status not in (200, 201, 400, 409):
                raise ValueError('Candidate returned an invalid HTTP status')
        except Exception:
            db.rollback()
            status, result = 500, {'error': 'Candidate backend exception'}
        finally:
            db.close()
        record = {'input': body, 'response': {'status': status, 'body': result, 'sourceHash': SOURCE_HASH}}
        with LOCK:
            with (ROOT / 'requests.ndjson').open('a') as file:
                file.write(json.dumps(record, separators=(',', ':')) + '\n')
        self.send(status, result)


def serve(port):
    server = ThreadingHTTPServer(('0.0.0.0', port), Handler)
    server.daemon_threads = True
    if port != 8080:
        spec = importlib.util.spec_from_file_location('candidate_checkout', ROOT / 'checkout.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        server.checkout = module.checkout
    print(f'Actual checkout app listening on port {port}; candidate {SOURCE_HASH[:12]}', flush=True)
    server.serve_forever()


if __name__ == '__main__':
    command = sys.argv[1]
    if command == 'reset':
        reset()
    elif command == 'observe':
        print(json.dumps(snapshot()))
    elif command == 'serve':
        serve(int(sys.argv[2]))
