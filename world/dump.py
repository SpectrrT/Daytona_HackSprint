"""Dumps a world's final state as JSON for the grader (A3). Runs inside the world. Owner: Tensae.

    python -m world.dump > /opt/antibody/dump.json

Output: {"provider_ledger": [...], "refunds": [...], "outbox": [...],
         "executor": <contents of /opt/antibody/executor_status.json>,
         "attack_manifest": <contents of /opt/antibody/attack_manifest.json, or {}>}
Never includes the answer key — it was never here (W3).
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

ANTIBODY_DIR = Path(os.getenv("ANTIBODY_DIR", "/opt/antibody"))
DSN = os.getenv("WORLD_ADMIN_DSN", "postgresql://postgres:postgres@localhost:5432/shop")


def _rows(cur, sql: str) -> list[dict]:
    cur.execute(sql)
    cols = [c.name for c in cur.description]
    return [
        dict(zip(cols, (float(v) if hasattr(v, "is_finite") else v for v in row), strict=True))
        for row in cur.fetchall()
    ]


def _read(name: str) -> dict:
    path = ANTIBODY_DIR / name
    return json.loads(path.read_text()) if path.exists() else {}


def dump() -> dict:
    import psycopg  # installed in the prod snapshot, not on the host

    with psycopg.connect(DSN) as conn, conn.cursor() as cur:
        return {
            "provider_ledger": _rows(cur, "SELECT refund_ref, order_id, amount, idempotency_key FROM provider.ledger"),
            "refunds": _rows(cur, "SELECT id, order_id, amount, source, idempotency_key FROM refunds"),
            "outbox": _rows(cur, "SELECT to_addr, subject, body FROM outbox"),
            "executor": _read("executor_status.json"),
            "attack_manifest": _read("attack_manifest.json"),
        }


if __name__ == "__main__":
    json.dump(dump(), sys.stdout, default=str)
