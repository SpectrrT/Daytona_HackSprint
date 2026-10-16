"""The payments provider mock inside each world. All money is mock money. Owner: Tensae.

    uvicorn world.payments_mock.main:app --port 8090

Its ledger (provider.ledger) is the source of truth the grader scores against.
Reads /opt/antibody/faults.json (written by world/prep.py) on every request:
  timeout_after_success  record the refund, then sleep past the client's timeout
  duplicate_webhook      after a refund, POST the app's webhook `copies` times
  slow_provider          add latency_ms to every response

POST /provider/refunds {order_id, amount, idempotency_key?}  → {refund_ref}
GET  /provider/refunds?order_id=...                          → ledger entries (payments.status permission)
"""

from __future__ import annotations

from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI(title="Antibody world: payments mock")


class ProviderRefund(BaseModel):
    order_id: str
    amount: float
    idempotency_key: str | None = None


@app.post("/provider/refunds")
def refund(req: ProviderRefund) -> dict:
    raise NotImplementedError("TODO(Tensae): ledger insert (unique on idempotency_key) + faults")


@app.get("/provider/refunds")
def status(order_id: str) -> dict:
    raise NotImplementedError
