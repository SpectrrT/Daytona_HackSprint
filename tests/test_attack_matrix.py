"""Attack validity matrix (W4, W5, R1, G2): every attack breaches the naive plan and is defendable.

Today this runs on the fake backend's rules oracle, which only proves menu.yaml's `defended_by`
and KNOWN_GOOD_PLAN agree. TODO(Ryan + Tensae): run the same matrix with the daytona backend
(@needs_daytona) once world/prep.py and the executor work — that's the version that counts.
"""

from __future__ import annotations

import random

import pytest

from agents import blue
from agents.attacks import menu
from arena.backends import FakeBackend, WorldJob
from contracts import AttackSpec

from .conftest import needs_daytona

ATTACKS = [
    AttackSpec(
        id=f"matrix.{type_}",
        family=family,
        type=type_,
        params=menu.sample_params(family, type_, random.Random(i)),
        seed=i,
        generation=1,
    )
    for i, (family, type_) in enumerate(menu.training_types())
]


def _breached(backend, attack, plan) -> bool:
    outcome = backend.run_world(WorldJob(f"w.{attack.id}", 1, attack, plan), on_forked=lambda _: None)
    return backend.grade([outcome], backend.answer_key())[0]["breached"]


@pytest.mark.parametrize("attack", ATTACKS, ids=lambda a: a.type)
def test_matrix_on_fake_oracle(attack):
    backend = FakeBackend(world_seconds=(0.0, 0.0))
    assert _breached(backend, attack, blue.initial_plan()), "naive plan should be breached"
    assert not _breached(backend, attack, blue.KNOWN_GOOD_PLAN), "known-good plan should defend"


@needs_daytona()
@pytest.mark.daytona
@pytest.mark.parametrize("attack", ATTACKS, ids=lambda a: a.type)
def test_matrix_on_daytona(attack):
    from arena.daytona_ops import DaytonaBackend

    backend = DaytonaBackend()
    assert _breached(backend, attack, blue.initial_plan())
    assert not _breached(backend, attack, blue.KNOWN_GOOD_PLAN)
