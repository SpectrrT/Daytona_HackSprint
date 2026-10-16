"""The four JSON shapes every part of Antibody agrees on (spec: "Architecture, contracts").

These pydantic models are the source of truth. `make contracts` exports them to
contracts/schemas/*.json, and web/src/contracts.ts mirrors them by hand. Change all three in
one commit; tests/test_contracts.py fails if the exported schemas drift.

Money is in dollars (float, rounded to cents by the grader). All money is mock money.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class _Contract(BaseModel):
    model_config = ConfigDict(extra="forbid")


# ---------------------------------------------------------------------------------------------
# AttackSpec — Red picks these from agents/attacks/menu.yaml only (R1). Never code.
# ---------------------------------------------------------------------------------------------


class AttackSpec(_Contract):
    id: str
    family: str  # e.g. "payments" — a key in menu.yaml
    type: str  # e.g. "timeout_after_success" — a key under that family
    params: dict[str, Any] = Field(default_factory=dict)  # inside the menu's parameter ranges
    seed: int  # every attack carries a seed (determinism)
    parent_id: str | None = None  # the attack this one mutated from (R2); None for a root variant
    generation: int
    held_out: bool = False  # exam-only; never used in training (R3)


# ---------------------------------------------------------------------------------------------
# BluePlan — Blue's structured plan. The executor applies the knobs identically in every world (B1).
# ---------------------------------------------------------------------------------------------

TrustSource = Literal["app_db", "provider"]  # where "did this payment fail?" is checked
TicketPolicy = Literal["follow", "facts_only", "ignore"]  # how support-ticket text is treated

# Everything a plan can be allowed to do. The binding vow (B4): a child never gains one its parent lacked.
Permission = Literal["db.read", "tickets.read", "payments.refund", "payments.status", "outbox.send"]


class Knobs(_Contract):
    idempotency_key: bool = False
    verify_before_retry: bool = False
    max_retries: int = Field(default=3, ge=0, le=10)
    trust_source: TrustSource = "app_db"
    ticket_policy: TicketPolicy = "follow"
    per_order_lock: bool = False
    per_customer_cap: float | None = None  # dollars per customer; None = no cap


class BluePlan(_Contract):
    id: str
    generation: int
    parent_id: str | None = None
    selection_sql: str  # one SELECT, run under the read-only role; returns order_id, amount
    knobs: Knobs = Field(default_factory=Knobs)
    permissions: list[Permission]
    lessons_used: list[str] = Field(default_factory=list)  # Lesson ids


# ---------------------------------------------------------------------------------------------
# WorldResult — one per world per generation, produced only by grader/score.py (G1, G2).
# ---------------------------------------------------------------------------------------------


class WorldResult(_Contract):
    world_id: str
    generation: int
    attack_id: str | None  # None for a clean control world
    plan_id: str
    dollars_over: float = 0.0
    dollars_missed: float = 0.0
    duplicate_refunds: int = 0
    injections_followed: int = 0
    task_complete: bool
    breached: bool
    false_alarm: bool = False  # clean world where Blue missed owed refunds
    seconds: float
    sandbox_id: str
    preview_url: str | None = None


# ---------------------------------------------------------------------------------------------
# Lesson — filed by Blue on the attack-tree branch that breached it (B2). Rides in lesson.filed.
# ---------------------------------------------------------------------------------------------


class Lesson(_Contract):
    id: str
    generation: int
    attack_id: str  # the branch it protects
    world_id: str
    text: str  # one plain-English sentence or two


# ---------------------------------------------------------------------------------------------
# Event — everything the arena does, in order. Recorded to runs/<run_id>.jsonl for replay (A7).
# ---------------------------------------------------------------------------------------------

EventType = Literal[
    "gen.started",
    "world.forked",
    "world.graded",
    "lesson.filed",
    "gen.done",
    "exam.done",
    "call.status",
    "prod.committed",
]


class Event(_Contract):
    ts: float  # unix seconds
    type: EventType
    payload: dict[str, Any]


class GenStarted(_Contract):
    run_id: str
    generation: int
    exam: bool = False  # True for the final exam on held-out attacks
    backend: Literal["fake", "daytona"]
    plan: BluePlan
    attacks: list[AttackSpec]
    clean_worlds: int


class WorldForked(_Contract):
    world_id: str
    generation: int
    attack_id: str | None
    sandbox_id: str


class GenDone(_Contract):
    generation: int
    exam: bool = False
    mode: Literal["parallel", "sequential"] = "parallel"  # A8 timing runs repeat a generation sequentially
    attack_worlds: int
    survived: int  # attack worlds defended
    clean_worlds: int
    false_alarms: int
    dollars_lost: float  # dollars_over summed over attack worlds
    seconds: float


class ExamDone(_Contract):
    generation: int
    passed: bool  # zero breaches and zero false alarms (V1)
    attack_worlds: int
    breaches: int
    clean_worlds: int
    false_alarms: int


class CallStatus(_Contract):
    status: Literal["dialing", "ringing", "in_progress", "approved", "declined", "failed", "skipped"]
    conversation_id: str | None = None
    detail: str | None = None


class ProdCommitted(_Contract):
    plan_id: str
    snapshot: str  # name of the prod snapshot taken just before the commit
    refunds_issued: int
    dollars_refunded: float
    preview_url: str | None = None


EVENT_PAYLOADS: dict[str, type[BaseModel]] = {
    "gen.started": GenStarted,
    "world.forked": WorldForked,
    "world.graded": WorldResult,
    "lesson.filed": Lesson,
    "gen.done": GenDone,
    "exam.done": ExamDone,
    "call.status": CallStatus,
    "prod.committed": ProdCommitted,
}


def validate_event(event: Event | dict[str, Any]) -> Event:
    """Validate an event and its payload against the contract for its type."""
    ev = event if isinstance(event, Event) else Event.model_validate(event)
    EVENT_PAYLOADS[ev.type].model_validate(ev.payload)
    return ev


CONTRACT_MODELS: dict[str, type[BaseModel]] = {
    "attack_spec": AttackSpec,
    "blue_plan": BluePlan,
    "world_result": WorldResult,
    "event": Event,
    "lesson": Lesson,
    **{f"payload.{name}": model for name, model in EVENT_PAYLOADS.items()},
}
