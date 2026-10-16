import hashlib
import importlib.util
import json
import pathlib
import sqlite3
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

HERE = pathlib.Path(__file__).parent / 'software'


class SoftwareRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        spec = importlib.util.spec_from_file_location('web_runtime_test', HERE / 'runtime.py')
        self.runtime = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.runtime)
        self.runtime.ROOT = pathlib.Path(self.temp.name)
        self.runtime.SOURCE_HASH = hashlib.sha256((HERE / 'fixture_checkout.py').read_bytes()).hexdigest()
        self.runtime.reset()
        code = {}
        exec(compile((HERE / 'fixture_checkout.py').read_text(), 'manual-fixture', 'exec'), code)
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), self.runtime.Handler)
        self.server.checkout = code['checkout']
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temp.cleanup()

    def post(self, request_id, quantity):
        request = urllib.request.Request(f'http://127.0.0.1:{self.server.server_port}/api/checkout',
            data=json.dumps({'requestId': request_id, 'quantity': quantity}).encode(),
            headers={'Content-Type': 'application/json'})
        try:
            response = urllib.request.urlopen(request, timeout=3)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            return response.status, json.load(response), response.headers['X-Candidate-SHA256']

    def test_seeded_fixture_exhibits_real_duplicate_effects(self):
        first, receipt, source_hash = self.post('retry', 1)
        second, other, _ = self.post('retry', 1)
        state = self.runtime.snapshot()
        self.assertEqual((first, second), (201, 201))
        self.assertNotEqual(receipt['orderId'], other['orderId'])
        self.assertEqual(source_hash, self.runtime.SOURCE_HASH)
        self.assertEqual(len(state['orders']), 2)
        self.assertEqual(state['stock'], 3)

    def test_invalid_inputs_do_not_change_the_ledger(self):
        for quantity in [-1, 0, 1.5, True, '1', None, 6]:
            self.assertEqual(self.post('invalid', quantity)[0], 400)
        self.assertEqual(self.runtime.snapshot()['stock'], 5)
        self.assertEqual(self.runtime.snapshot()['orders'], [])

    def test_candidate_connection_cannot_redefine_the_schema(self):
        db = self.runtime.connect()
        try:
            with self.assertRaises(sqlite3.DatabaseError):
                db.execute('DROP TABLE orders')
            with self.assertRaises(sqlite3.DatabaseError):
                db.execute("ATTACH DATABASE ':memory:' AS other")
        finally:
            db.close()

    def test_module_gate_rejects_file_and_process_access(self):
        spec = importlib.util.spec_from_file_location('web_validate_test', HERE / 'validate.py')
        gate = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(gate)
        for source in [
            'import os\ndef checkout(db, request_id, quantity):\n return os.environ',
            'def checkout(db, request_id, quantity):\n return open("/tmp/data").read()',
            'def checkout(db, request_id, quantity):\n return db.__class__',
        ]:
            with self.assertRaises(ValueError):
                gate.validate(source)


if __name__ == '__main__':
    unittest.main()
