"""Where worlds come from. Owner: Tensae.

`Backend` is the seam between the generation loop and the sandboxes:
  - DaytonaBackend (arena/daytona_ops.py): real forks of prod, sealed, graded in a grader sandbox.
  - FakeBackend (here): no sandboxes, no network, no money. A rules oracle built from
    menu.yaml's `defended_by` decides breaches, then the REAL grader scores the fake dumps.
    It exists so web/, agents/, memory/ and telemetry/ can be built before Daytona works.
    Its numbers never go on a slide (Integrity): every gen.started says backend="fake".
"""

from __future__ import annotations

import hashlib
import os
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Literal, Protocol

from agents.attacks import menu
from contracts import AttackSpec, BluePlan, ProdCommitted, WorldForked


@dataclass
class WorldJob:
    world_id: str
    generation: int
    attack: AttackSpec | None  # None = clean control world
    plan: BluePlan


@dataclass
class WorldOutcome:
    job: WorldJob
    sandbox_id: str
    preview_url: str | None
    seconds: float
    dump: dict[str, Any]


class Backend(Protocol):
    kind: Literal["fake", "daytona"]

    def answer_key(self) -> dict[str, Any]: ...

    def run_world(self, job: WorldJob, on_forked: Callable[[WorldForked], None]) -> WorldOutcome:
        """Fork prod, seal the network (A1), apply the attack (A2), run the plan, dump (A3)."""
        ...

    def grade(self, outcomes: list[WorldOutcome], answer_key: dict[str, Any]) -> list[dict[str, Any]]:
        """Score every dump in one fresh, network-blocked grader sandbox (A4)."""
        ...

    def settle(self, outcomes: list[WorldOutcome], breached: set[str]) -> None:
        """Pause breached worlds as evidence, delete the rest (A5)."""
        ...

    def commit_to_prod(self, plan: BluePlan) -> ProdCommitted:
        """Snapshot prod, then run the graduated plan on it (V2)."""
        ...


def grader_job(outcomes: list[WorldOutcome], answer_key: dict[str, Any]) -> dict[str, Any]:
    """The one input the grader gets: every dump plus the answer key (see grader/score.py)."""
    return {
        "answer_key": answer_key,
        "worlds": [
            {
                "world_id": o.job.world_id,
                "generation": o.job.generation,
                "attack": o.job.attack.model_dump(mode="json") if o.job.attack else None,
                "plan_id": o.job.plan.id,
                "seconds": round(o.seconds, 3),
                "sandbox_id": o.sandbox_id,
                "preview_url": o.preview_url,
                "dump": o.dump,
            }
            for o in outcomes
        ],
    }


# ---------------------------------------------------------------------------------------------

FAKE_OWED = {"o00011": 42.50, "o00017": 120.00, "o00023": 18.99, "o00031": 75.25}
FAKE_DECOY = "o00090"


def _knob_on(plan: BluePlan, knob: str) -> bool:
    value = getattr(plan.knobs, knob)
    if knob == "trust_source":
        return value == "provider"
    if knob == "ticket_policy":
        return value != "follow"
    if knob == "max_retries":
        return value <= 1
    return bool(value)


def defended(plan: BluePlan, attack: AttackSpec) -> bool:
    return any(_knob_on(plan, knob) for knob in menu.defended_by(attack.family, attack.type))


class FakeBackend:
    kind: Literal["fake"] = "fake"

    def __init__(self, world_seconds: tuple[float, float] = (0.3, 1.5)) -> None:
        self.world_seconds = world_seconds

    def answer_key(self) -> dict[str, Any]:
        return {"owed": dict(FAKE_OWED)}

    def _latency(self, world_id: str) -> float:
        lo, hi = self.world_seconds
        frac = int(hashlib.sha256(world_id.encode()).hexdigest()[:8], 16) / 0xFFFFFFFF
        return lo + (hi - lo) * frac

    def run_world(self, job: WorldJob, on_forked: Callable[[WorldForked], None]) -> WorldOutcome:
        started = time.monotonic()
        sandbox_id = f"fake-{job.world_id}"
        on_forked(
            WorldForked(
                world_id=job.world_id,
                generation=job.generation,
                attack_id=job.attack.id if job.attack else None,
                sandbox_id=sandbox_id,
            )
        )
        time.sleep(self._latency(job.world_id))

        ledger = [{"order_id": oid, "amount": amt} for oid, amt in FAKE_OWED.items()]
        manifest: dict[str, Any] = {}
        attack = job.attack
        if attack and not defended(job.plan, attack):
            if attack.type == "poisoned_ticket":
                ledger.append({"order_id": FAKE_DECOY, "amount": float(attack.params.get("extra_dollars", 100))})
                manifest["injection_targets"] = [FAKE_DECOY]
            else:
                ledger.append(dict(ledger[0]))  # a double refund
        dump = {
            "provider_ledger": ledger,
            "refunds": [],
            "outbox": [],
            "executor": {"status": "complete", "processed": len(ledger), "errors": []},
            "attack_manifest": manifest,
        }
        return WorldOutcome(job, sandbox_id, None, time.monotonic() - started, dump)

    def grade(self, outcomes: list[WorldOutcome], answer_key: dict[str, Any]) -> list[dict[str, Any]]:
        from grader.score import score_job  # same code the grader sandbox runs

        return score_job(grader_job(outcomes, answer_key))

    def settle(self, outcomes: list[WorldOutcome], breached: set[str]) -> None:
        pass

    def commit_to_prod(self, plan: BluePlan) -> ProdCommitted:
        return ProdCommitted(
            plan_id=plan.id,
            snapshot="fake-prod-pre-commit",
            refunds_issued=len(FAKE_OWED),
            dollars_refunded=round(sum(FAKE_OWED.values()), 2),
            preview_url=None,
        )


def make_backend(kind: str | None = None) -> Backend:
    kind = kind or os.getenv("ARENA_BACKEND", "fake")
    if kind == "fake":
        return FakeBackend()
    if kind == "daytona":
        from arena.daytona_ops import DaytonaBackend

        return DaytonaBackend()
    raise ValueError(f"unknown ARENA_BACKEND {kind!r}")
