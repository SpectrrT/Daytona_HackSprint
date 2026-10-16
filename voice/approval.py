"""Holds the approver's decision until graduation reads it. Owner: Donald.

The ElevenLabs agent's webhook tool hits POST /api/approve (arena/app.py), which calls record().
graduation waits on wait() with a timeout; no answer in time counts as no.
"""

from __future__ import annotations

import threading

_event = threading.Event()
_decision: str | None = None
_lock = threading.Lock()


def reset() -> None:
    global _decision
    with _lock:
        _decision = None
        _event.clear()


def record(decision: str) -> None:
    global _decision
    with _lock:
        _decision = decision
        _event.set()


def wait(timeout_s: float) -> str | None:
    """Returns "approved", "declined", or None on timeout."""
    _event.wait(timeout_s)
    with _lock:
        return _decision
