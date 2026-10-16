from __future__ import annotations

import os

import pytest

# Tests never touch real services unless a test opts in with a marker.
os.environ["ARENA_BACKEND"] = "fake"
os.environ["MEMORY_BACKEND"] = "memory"
os.environ.setdefault("APPROVER", "fake-approve")
os.environ["LLM_CACHE"] = "0"


@pytest.fixture
def ctx(tmp_path):
    """An arena context on the fake backend with near-instant worlds, recording to a temp dir."""
    from arena.backends import FakeBackend
    from arena.events import EventBus
    from arena.generation import ArenaContext
    from memory.store import InMemoryTreeStore

    bus = EventBus(runs_dir=tmp_path)
    bus.start_run("test-run")
    yield ArenaContext(
        bus=bus,
        backend=FakeBackend(world_seconds=(0.0, 0.01)),
        store=InMemoryTreeStore(),
        attack_worlds=4,
        clean_worlds=2,
    )
    bus.close()


def needs_daytona():
    return pytest.mark.skipif(
        not (os.getenv("DAYTONA_API_KEY") and os.getenv("RUN_DAYTONA_TESTS") == "1"),
        reason="set DAYTONA_API_KEY and RUN_DAYTONA_TESTS=1 (and build prod first)",
    )
