"""The refund app inside each world (W1, W5). Owner: Tensae.

    uvicorn world.app.main:app --port 8080

POST /refunds {order_id, amount, idempotency_key?}
  - Writes a refunds row (source='plan') and calls the payments mock.
  - Honors an optional idempotency key (W5): a repeated key returns the first result.
  - Without one, its client retries on timeout the way real payment SDKs do — this is the hole
    timeout_after_success exploits.
GET /refunds/{order_id}  → what the app believes was refunded (the app DB view)
GET /health              → W1 health check

Its port 8080 preview link is what the world inspector opens ("refunds and outbox").
"""

from __future__ import annotations

from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI(title="Antibody world: refund app")


class RefundRequest(BaseModel):
    order_id: str
    amount: float
    idempotency_key: str | None = None


@app.get("/health")
def health() -> dict:
    # TODO(Tensae): also check Postgres and the payments mock are reachable.
    return {"ok": True}


@app.post("/refunds")
def create_refund(req: RefundRequest) -> dict:
    raise NotImplementedError("TODO(Tensae): refunds row + payments mock call + retry-on-timeout client")


@app.get("/refunds/{order_id}")
def get_refunds(order_id: str) -> dict:
    raise NotImplementedError
