"""World lifecycle on real Daytona sandboxes. Owner: Tensae. Skipped unless RUN_DAYTONA_TESTS=1.

Seal check (A1), calm-world smoke (W1-W3, A3, G1), answer-key leak check (W3), dumps reach only
the grader (A4, G3), breached worlds pause and the rest are deleted (A5), parallel timing (A8).
"""

from __future__ import annotations

import pytest

from .conftest import needs_daytona

pytestmark = [pytest.mark.daytona, needs_daytona()]


@pytest.fixture(scope="module")
def backend():
    from arena.daytona_ops import DaytonaBackend

    return DaytonaBackend()


def test_seal_check_outbound_request_from_a_fork_fails(backend):
    world = backend.prod.fork(name="antibody-test-seal")
    try:
        world.update_network_settings(network_block_all=True)
        res = world.process.exec(
            "python -c \"import urllib.request; urllib.request.urlopen('https://example.com', timeout=5)\""
        )
        assert res.exit_code != 0
    finally:
        world.delete()


def test_calm_world_smoke_known_good_plan_matches_answer_key(backend):
    pytest.skip("TODO(Tensae): run KNOWN_GOOD_PLAN in a clean world; refunded total == answer key, verdict green")


def test_answer_key_never_enters_a_world(backend):
    pytest.skip("TODO(Tensae): grep a forked world's disk and DB for answer_key.json contents")


def test_breached_worlds_pause_and_the_rest_are_deleted(backend):
    pytest.skip("TODO(Tensae): run one generation, check sandbox states via daytona.list()")


def test_parallel_generation_is_faster_than_sequential(backend):
    pytest.skip("TODO(Tensae): arena.timing.measure_speedup on 6+2 worlds; record the number for the slide")
