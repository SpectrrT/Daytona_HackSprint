"""Every arena step is an event (A7). Owner: Tensae.

The bus validates each event against contracts/, appends it to runs/<run_id>.jsonl, and fans it
out to live subscribers (the web app's SSE stream). Generations run in worker threads, so emit()
is thread-safe and hands events to asyncio subscribers with call_soon_threadsafe.
"""

from __future__ import annotations

import asyncio
import threading
import time
from pathlib import Path
from typing import Any

from pydantic import BaseModel

from contracts import Event, EventType, validate_event

RUNS_DIR = Path("runs")


class EventBus:
    def __init__(self, runs_dir: Path = RUNS_DIR) -> None:
        self.runs_dir = runs_dir
        self.run_id: str | None = None
        self.history: list[Event] = []
        self._lock = threading.Lock()
        self._subscribers: list[tuple[asyncio.AbstractEventLoop, asyncio.Queue[Event]]] = []
        self._file = None

    def start_run(self, run_id: str | None = None) -> str:
        with self._lock:
            self.run_id = run_id or time.strftime("run-%Y%m%d-%H%M%S")
            self.history = []
            self.runs_dir.mkdir(parents=True, exist_ok=True)
            if self._file:
                self._file.close()
            self._file = open(self.runs_dir / f"{self.run_id}.jsonl", "w")
        return self.run_id

    def emit(self, type_: EventType, payload: BaseModel | dict[str, Any]) -> Event:
        data = payload.model_dump(mode="json") if isinstance(payload, BaseModel) else payload
        event = validate_event(Event(ts=time.time(), type=type_, payload=data))
        with self._lock:
            self.history.append(event)
            if self._file:
                self._file.write(event.model_dump_json() + "\n")
                self._file.flush()
            subscribers = list(self._subscribers)
        for loop, queue in subscribers:
            loop.call_soon_threadsafe(queue.put_nowait, event)
        return event

    def subscribe(self) -> tuple[asyncio.Queue[Event], list[Event]]:
        """Returns a live queue plus everything emitted so far in this run (no gap, no overlap)."""
        queue: asyncio.Queue[Event] = asyncio.Queue()
        with self._lock:
            self._subscribers.append((asyncio.get_running_loop(), queue))
            backlog = list(self.history)
        return queue, backlog

    def unsubscribe(self, queue: asyncio.Queue[Event]) -> None:
        with self._lock:
            self._subscribers = [(lp, q) for lp, q in self._subscribers if q is not queue]

    def close(self) -> None:
        with self._lock:
            if self._file:
                self._file.close()
                self._file = None


def load_run(path: Path) -> list[Event]:
    return [validate_event(Event.model_validate_json(line)) for line in path.read_text().splitlines() if line]


def list_runs(runs_dir: Path = RUNS_DIR) -> list[dict[str, Any]]:
    runs = []
    for path in sorted(runs_dir.glob("*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True):
        lines = [line for line in path.read_text().splitlines() if line]
        started = Event.model_validate_json(lines[0]).ts if lines else path.stat().st_mtime
        runs.append({"run_id": path.stem, "events": len(lines), "started_at": started})
    return runs
