"""End-to-end on the fake backend: the loop, lessons, tree, events, replay, graduation.

Covers the spec's "two-generation run with 4 worlds" (A6, B2, B3, M1 in-memory), the replay test
(A7), and the graduation dry run (V1, V2). The same tests must pass on the daytona backend later.
"""

from __future__ import annotations

from agents.attacks import menu
from arena.events import load_run
from arena.generation import run_arena


def _types(ctx):
    return [e.type for e in ctx.bus.history]


def test_two_generation_run_connects_end_to_end(ctx, monkeypatch):
    monkeypatch.setenv("APPROVER", "fake-approve")
    plan = run_arena(ctx, generations=2)
    types = _types(ctx)

    assert types.count("gen.started") == 3  # 2 generations + the exam
    exam_worlds = len(menu.held_out_specs(generation=3)) + ctx.clean_worlds
    assert types.count("world.graded") == 2 * (ctx.attack_worlds + ctx.clean_worlds) + exam_worlds
    assert "lesson.filed" in types and "exam.done" in types
    assert plan.generation > 1 and plan.lessons_used  # B3: revised from lessons
    assert ctx.store.lessons and ctx.store.worlds  # M1 (in-memory store)

    gen_done = [e.payload for e in ctx.bus.history if e.type == "gen.done" and not e.payload["exam"]]
    assert gen_done[0]["survived"] < gen_done[-1]["survived"]  # the curve rises


def test_recorded_run_replays_identically(ctx):
    run_arena(ctx, generations=1)
    recorded = load_run(ctx.bus.runs_dir / f"{ctx.bus.run_id}.jsonl")
    assert [e.model_dump() for e in recorded] == [e.model_dump() for e in ctx.bus.history]


def _exam_passed(ctx) -> bool:
    return [e.payload["passed"] for e in ctx.bus.history if e.type == "exam.done"][-1]


def _call_statuses(ctx) -> list[str]:
    return [e.payload["status"] for e in ctx.bus.history if e.type == "call.status"]


def test_failed_exam_places_no_call(ctx, monkeypatch):
    # 4 attack worlds can't cover all 5 attack types in 2 generations, so the exam catches the gap.
    monkeypatch.setenv("APPROVER", "fake-approve")
    run_arena(ctx, generations=2)
    assert not _exam_passed(ctx)
    assert _call_statuses(ctx) == ["skipped"]
    assert "prod.committed" not in _types(ctx)


def test_graduation_dry_run_decline_then_approve(ctx, monkeypatch):
    ctx.attack_worlds = 6
    monkeypatch.setenv("APPROVER", "fake-decline")
    run_arena(ctx, generations=2)
    assert _exam_passed(ctx)
    assert _call_statuses(ctx)[-1] == "declined"
    assert "prod.committed" not in _types(ctx)

    monkeypatch.setenv("APPROVER", "fake-approve")
    run_arena(ctx, generations=2)
    assert _call_statuses(ctx)[-1] == "approved"
    assert _types(ctx)[-1] == "prod.committed"


def test_attack_lands_only_in_its_own_world(ctx):
    run_arena(ctx, generations=1)
    for event in ctx.bus.history:
        if event.type == "world.graded" and event.payload["attack_id"] is None:
            assert not event.payload["breached"]
