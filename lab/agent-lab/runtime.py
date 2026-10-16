"""Three synthetic applications with real SQLite tool effects and a replaceable guard."""
import builtins
import copy
import hashlib
import json
import os
import re
import sqlite3
import sys
import threading
import urllib.error
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from validate import BUILTINS, validate

ROOT = Path(__file__).resolve().parent
DB = ROOT / "lab.sqlite3"
LOCK = threading.RLock()
TOOLS = {"support": {"refund_order", "read_record"}, "procurement": {"place_order", "read_record"}, "engineering": {"deploy_build", "delete_artifact", "read_record"}}

def digest(value): return hashlib.sha256(value).hexdigest()
def fixtures(): return json.loads((ROOT / "fixtures.json").read_text())
def source_hash():
    prompt = json.loads((ROOT / "candidate.json").read_text())["systemPrompt"]
    return digest(json.dumps({"systemPrompt": prompt, "guardSource": (ROOT / "guard.py").read_text()}, separators=(",", ":"), ensure_ascii=False).encode())
def runtime_hash(): return digest(b"\0".join((ROOT / name).read_bytes() for name in ("runtime.py", "fixtures.json", "validate.py", "index.html")))
def connect():
    db = sqlite3.connect(DB, timeout=10); db.row_factory = sqlite3.Row; return db
def load_guard():
    tree = validate((ROOT / "guard.py").read_text())
    namespace = {"__builtins__": {name: getattr(builtins, name) for name in BUILTINS}}
    exec(compile(tree, "guard.py", "exec"), namespace)
    return namespace["authorize"]

def reset():
    with LOCK:
        for name in ("lab.sqlite3", "lab.sqlite3-wal", "lab.sqlite3-shm", "session-closed"): (ROOT / name).unlink(missing_ok=True)
        with connect() as db:
            db.executescript("CREATE TABLE records(domain TEXT,id TEXT,body TEXT,PRIMARY KEY(domain,id)); CREATE TABLE effects(id INTEGER PRIMARY KEY AUTOINCREMENT,domain TEXT,tool TEXT,record_id TEXT,actor_id TEXT,amount_cents INTEGER,target TEXT); CREATE TABLE tools(id INTEGER PRIMARY KEY AUTOINCREMENT,event TEXT NOT NULL); CREATE TABLE jobs(id TEXT PRIMARY KEY,input TEXT NOT NULL,result TEXT,verdict TEXT);")
            db.executemany("INSERT INTO records VALUES(?,?,?)", [(r["domain"], r["id"], json.dumps(r["data"])) for r in fixtures()["records"]])

def effect_rows(db):
    return [{"id": r["id"], "domain": r["domain"], "tool": r["tool"], "recordId": r["record_id"], "actorId": r["actor_id"], "amountCents": r["amount_cents"], "target": r["target"]} for r in db.execute("SELECT * FROM effects ORDER BY id")]

def execute(db, domain, action):
    if domain not in TOOLS or set(action) != {"tool", "recordId", "amountCents", "target"} or action["tool"] not in set().union(*TOOLS.values()): raise ValueError("Invalid environment tool")
    if any(not isinstance(action[k], str) or len(action[k]) > 80 for k in ("recordId", "target")) or type(action["amountCents"]) is not int or not 0 <= action["amountCents"] <= 1000000: raise ValueError("Invalid tool arguments")
    row = db.execute("SELECT body FROM records WHERE domain=? AND id=?", (domain, action["recordId"])).fetchone()
    context = fixtures()["contexts"][domain]
    record = json.loads(row["body"]) if row else None
    allowed, reason, data = False, "Record not found", None
    if action["tool"] not in TOOLS[domain]: reason = "Tool unavailable in this environment"
    elif record is not None:
        decision = load_guard()(copy.deepcopy(action), copy.deepcopy(record), copy.deepcopy(context), copy.deepcopy(effect_rows(db)))
        if not isinstance(decision, tuple) or len(decision) != 2 or type(decision[0]) is not bool or not isinstance(decision[1], str) or not 1 <= len(decision[1]) <= 300: raise ValueError("Guard must return (bool, reason)")
        allowed, reason = decision
        if allowed:
            if action["tool"] == "read_record": data = record
            else:
                db.execute("INSERT INTO effects(domain,tool,record_id,actor_id,amount_cents,target) VALUES(?,?,?,?,?,?)", (domain, action["tool"], action["recordId"], context["actorId"], action["amountCents"], action["target"]))
                data = {"effectId": db.execute("SELECT last_insert_rowid()").fetchone()[0], "recordId": action["recordId"], "amountCents": action["amountCents"], "target": action["target"]}
    event = {**action, "domain": domain, "allowed": allowed, "reason": reason, "data": data}
    cursor = db.execute("INSERT INTO tools(event) VALUES(?)", (json.dumps(event),))
    return {**event, "sequence": cursor.lastrowid}

def snapshot():
    with LOCK, connect() as db:
        records = [{"domain": r["domain"], "id": r["id"], "data": json.loads(r["body"])} for r in db.execute("SELECT * FROM records ORDER BY rowid")]
        tools = [{**json.loads(r["event"]), "sequence": r["id"]} for r in db.execute("SELECT * FROM tools ORDER BY id")]
        jobs = [{"id": r["id"], "input": json.loads(r["input"]), "result": json.loads(r["result"]) if r["result"] else None, "verdict": json.loads(r["verdict"]) if r["verdict"] else None} for r in db.execute("SELECT * FROM jobs ORDER BY rowid")]
        candidate = json.loads((ROOT / "candidate.json").read_text())
        return {"sourceHash": source_hash(), "runtimeHash": runtime_hash(), "processId": os.getpid(), "records": records, "effects": effect_rows(db), "tools": tools, "jobs": jobs, "sessionClosed": (ROOT / "session-closed").exists(), "candidate": {"id": candidate["id"], "label": candidate["label"], "importedFixture": candidate.get("importedFixture", False)}}

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_): pass
    def send(self, status, body, content_type="application/json"):
        data = json.dumps(body).encode() if content_type == "application/json" else body
        self.send_response(status); self.send_header("Content-Type", content_type); self.send_header("Content-Length", str(len(data))); self.send_header("Cache-Control", "no-store"); self.send_header("X-Candidate-SHA256", source_hash()); self.end_headers(); self.wfile.write(data)
    def proxy(self):
        target = json.loads((ROOT / "target.json").read_text())["url"]
        if not re.fullmatch(r"http://(?:127\.0\.0\.1|[a-zA-Z0-9-]+):8000", target): raise ValueError("Invalid linked target")
        length = int(self.headers.get("Content-Length", "0"))
        if not 0 <= length <= 32768: return self.send(413, {"error": "Request too large"})
        request = urllib.request.Request(target + self.path, data=self.rfile.read(length) if self.command == "POST" else None, method=self.command, headers={"Content-Type": "application/json"})
        try: response = urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=20)
        except urllib.error.HTTPError as error: response = error
        except (OSError, ValueError): return self.send(503, {"error": "Linked candidate unavailable"})
        data = response.read(300000)
        self.send_response(response.status)
        for key in ("Content-Type", "X-Candidate-SHA256"):
            if response.headers.get(key): self.send_header(key, response.headers[key])
        self.send_header("Content-Length", str(len(data))); self.send_header("Cache-Control", "no-store"); self.end_headers(); self.wfile.write(data)
    def do_GET(self):
        if self.server.server_port == 8080: return self.proxy()
        if self.path == "/": return self.send(200, (ROOT / "index.html").read_bytes(), "text/html; charset=utf-8")
        if self.path in ("/api/state", "/api/jobs", "/healthz"):
            state = snapshot(); state.pop("records")
            return self.send(200, state)
        self.send(404, {"error": "Not found"})
    def do_POST(self):
        if self.server.server_port == 8080: return self.proxy()
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 32768: return self.send(413, {"error": "Request too large"})
            value = json.loads(self.rfile.read(length))
            with LOCK, connect() as db:
                if self.path == "/api/messages":
                    if set(value) != {"message", "knowledge", "domain"} or value["domain"] not in TOOLS or any(not isinstance(value[k], str) or len(value[k]) > 4000 for k in ("message", "knowledge")): raise ValueError("Invalid input")
                    key = uuid.uuid4().hex; db.execute("INSERT INTO jobs(id,input) VALUES(?,?)", (key, json.dumps(value))); db.commit()
                    return self.send(201, {"id": key, "sourceHash": source_hash()})
                if self.path.startswith("/api/jobs/") and self.path.endswith("/result"):
                    key = self.path.split("/")[3]; job = db.execute("SELECT * FROM jobs WHERE id=?", (key,)).fetchone()
                    if not job or job["result"]: raise ValueError("Job missing or already completed")
                    proposal = value["proposal"]
                    if set(proposal) != {"reply", "actions"} or not isinstance(proposal["reply"], str) or len(proposal["reply"]) > 2000 or not isinstance(proposal["actions"], list) or len(proposal["actions"]) > 2: raise ValueError("Invalid target proposal")
                    domain = json.loads(job["input"])["domain"]
                    result = {"proposal": proposal, "tools": [execute(db, domain, action) for action in proposal["actions"]], "targetModel": str(value.get("targetModel", "unknown"))[:120]}
                    db.execute("UPDATE jobs SET result=? WHERE id=?", (json.dumps(result), key)); db.commit()
                    return self.send(200, result)
                if self.path == "/api/tool-test":
                    if not isinstance(value["actions"], list) or not 1 <= len(value["actions"]) <= 8: raise ValueError("Invalid test size")
                    result = {"tools": [execute(db, value["domain"], action) for action in value["actions"]]}; db.commit(); return self.send(200, result)
                if self.path.startswith("/api/jobs/") and self.path.endswith("/verdict"):
                    key = self.path.split("/")[3]
                    if type(value["passed"]) is not bool or not isinstance(value["summary"], str) or len(value["summary"]) > 1000: raise ValueError("Invalid verdict")
                    db.execute("UPDATE jobs SET verdict=? WHERE id=?", (json.dumps(value), key)); db.commit(); return self.send(200, {"ok": True})
            self.send(404, {"error": "Not found"})
        except (ValueError, KeyError, TypeError, json.JSONDecodeError): self.send(400, {"error": "Invalid request"})

if __name__ == "__main__":
    command = sys.argv[1]
    if command == "reset": reset()
    elif command == "observe": print(json.dumps(snapshot()))
    elif command == "validate": load_guard(); print("Guard validated")
    elif command == "serve": load_guard(); ThreadingHTTPServer(("0.0.0.0", int(sys.argv[2])), Handler).serve_forever()
