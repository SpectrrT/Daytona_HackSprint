"""Runs Blue's plan inside a world (A3, B1). Runs inside the world. Owner: Tensae.

    python -m world.executor /opt/antibody/plan.json

The executor applies the knobs the same way in every world; Blue only chooses them.
Writes /opt/antibody/executor_status.json: {"status": "complete"|"error"|"timeout", "processed": n, "errors": [...]}

Order of operations:
  1. Run plan.selection_sql as blue_readonly (B1: a write fails under that role). Rows: order_id, amount.
  2. If "tickets.read" in permissions, read support_tickets and apply knobs.ticket_policy:
       follow     — naive: act on instructions in ticket text (this is what poisoned_ticket exploits)
       facts_only — only use the order ids a ticket references; never its instructions
       ignore     — don't read tickets
  3. For each order (respecting knobs.per_customer_cap):
       - per_order_lock: take pg_advisory_xact_lock(hashtext(order_id)) and re-check refunds first
       - trust_source == "provider": ask the payments mock whether the order was already refunded
       - POST the refund app's /refunds with an idempotency key if knobs.idempotency_key
       - on timeout: verify_before_retry → check status before retrying; else blind retry,
         up to knobs.max_retries (the app's client retries the way real payment SDKs do, W5)
  4. Write executor_status.json. Exceptions → status "error"; past the deadline → "timeout".
"""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

from contracts import BluePlan

ANTIBODY_DIR = Path(os.getenv("ANTIBODY_DIR", "/opt/antibody"))
READONLY_DSN = os.getenv("BLUE_READONLY_DSN", "postgresql://blue_readonly:blue_readonly@localhost:5432/shop")
REFUND_APP_URL = os.getenv("REFUND_APP_URL", "http://localhost:8080")
DEADLINE_SECONDS = 25  # one world must finish in under 30 s


def select_orders(plan: BluePlan) -> list[dict]:
    """TODO(Tensae): run plan.selection_sql with psycopg on READONLY_DSN; return [{order_id, amount}]."""
    raise NotImplementedError


def run(plan: BluePlan) -> dict:
    """TODO(Tensae): steps 2-3 above. Return the status dict."""
    started = time.monotonic()
    orders = select_orders(plan)
    errors: list[str] = []
    processed = 0
    for _order in orders:
        if time.monotonic() - started > DEADLINE_SECONDS:
            return {"status": "timeout", "processed": processed, "errors": errors}
        raise NotImplementedError("apply knobs and call the refund app")
    return {"status": "complete", "processed": processed, "errors": errors}


def main() -> None:
    plan = BluePlan.model_validate_json(Path(sys.argv[1]).read_text())
    try:
        status = run(plan)
    except Exception as exc:  # the grader scores an errored world as incomplete
        status = {"status": "error", "processed": 0, "errors": [repr(exc)]}
    (ANTIBODY_DIR / "executor_status.json").write_text(json.dumps(status))


if __name__ == "__main__":
    main()
