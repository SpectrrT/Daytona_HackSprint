"""The arena's HTTP API: live events for the web app, recorded runs, run control, approval webhook.

    uvicorn arena.app:app --reload --port 8000      (or: make arena)

GET  /api/health
GET  /api/events            SSE; replays the current run so far, then streams live (U1)
GET  /api/runs              recorded runs, newest first
GET  /api/runs/{run_id}     one recorded run as JSONL (A7)
POST /api/run               {"generations": 4} → starts a run in the background
POST /api/approve           ElevenLabs agent's webhook tool: {"decision": "approve"|"decline"}
"""

from __future__ import annotations

import os
import threading

from dotenv import load_dotenv
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel
from sse_starlette.sse import EventSourceResponse

load_dotenv()

from arena.backends import make_backend
from arena.events import RUNS_DIR, EventBus, list_runs
from arena.generation import ArenaContext, run_arena
from memory.store import make_store
from telemetry import arize
from voice import approval

app = FastAPI(title="Antibody arena")
bus = EventBus()
_run_lock = threading.Lock()
arize.setup_tracing()


@app.get("/api/health")
def health() -> dict:
    return {"ok": True, "backend": os.getenv("ARENA_BACKEND", "fake"), "run_id": bus.run_id}


@app.get("/api/events")
async def events():
    queue, backlog = bus.subscribe()

    async def stream():
        try:
            for event in backlog:
                yield {"data": event.model_dump_json()}
            while True:
                event = await queue.get()
                yield {"data": event.model_dump_json()}
        finally:
            bus.unsubscribe(queue)

    return EventSourceResponse(stream())


@app.get("/api/runs")
def runs() -> list[dict]:
    return list_runs(RUNS_DIR)


@app.get("/api/runs/{run_id}", response_class=PlainTextResponse)
def run(run_id: str) -> str:
    path = (RUNS_DIR / f"{run_id}.jsonl").resolve()
    if path.parent != RUNS_DIR.resolve() or not path.exists():
        raise HTTPException(404, "no such run")
    return path.read_text()


class RunRequest(BaseModel):
    generations: int = 4
    attack_worlds: int = 6
    clean_worlds: int = 2


@app.post("/api/run")
def start_run(req: RunRequest) -> dict:
    if not _run_lock.acquire(blocking=False):
        raise HTTPException(409, "a run is already in progress")
    run_id = bus.start_run()
    ctx = ArenaContext(
        bus=bus,
        backend=make_backend(),
        store=make_store(),
        attack_worlds=req.attack_worlds,
        clean_worlds=req.clean_worlds,
    )

    def work() -> None:
        try:
            run_arena(ctx, generations=req.generations)
        finally:
            _run_lock.release()

    threading.Thread(target=work, name=f"arena-{run_id}", daemon=True).start()
    return {"run_id": run_id}


class Decision(BaseModel):
    decision: str  # "approve" | "decline"
    conversation_id: str | None = None


@app.post("/api/approve")
def approve(body: Decision, x_approve_secret: str = Header(default="")) -> dict:
    secret = os.getenv("APPROVE_WEBHOOK_SECRET", "")
    if not secret or x_approve_secret != secret:
        raise HTTPException(403, "bad secret")
    approval.record("approved" if body.decision.lower().startswith("approv") else "declined")
    return {"ok": True}
