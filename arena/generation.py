"""The generation loop (A2-A6). Owner: Tensae.

run_generation()  one generation: fork N worlds in parallel, attack, run, dump, grade, settle.
                  Tensae's hand-off: returns WorldResults (by 12:30).
run_arena()       G generations with lessons and revision, then the final exam, then graduation.
"""

from __future__ import annotations

import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field

from agents import blue, red
from agents.validator import validate_plan
from arena.backends import Backend, WorldJob
from arena.events import EventBus
from contracts import AttackSpec, BluePlan, GenDone, GenStarted, WorldResult
from memory.store import TreeStore
from telemetry import arize


@dataclass
class ArenaContext:
    bus: EventBus
    backend: Backend
    store: TreeStore
    attack_worlds: int = 6
    clean_worlds: int = 2
    seed: int = 7
    attacks: dict[str, AttackSpec] = field(default_factory=dict)


def run_generation(
    ctx: ArenaContext,
    generation: int,
    plan: BluePlan,
    attacks: list[AttackSpec],
    *,
    exam: bool = False,
    parallel: bool = True,
) -> list[WorldResult]:
    started = time.monotonic()
    mode = "parallel" if parallel else "sequential"
    suffix = "" if parallel else "s"
    jobs = [
        WorldJob(f"w.g{generation}.{i}{suffix}", generation, attack, plan)
        for i, attack in enumerate([*attacks, *([None] * ctx.clean_worlds)])
    ]
    for attack in attacks:
        ctx.attacks[attack.id] = attack
        ctx.store.put_attack(attack)

    if parallel:
        ctx.bus.emit(
            "gen.started",
            GenStarted(
                run_id=ctx.bus.run_id or "",
                generation=generation,
                exam=exam,
                backend=ctx.backend.kind,
                plan=plan,
                attacks=attacks,
                clean_worlds=ctx.clean_worlds,
            ),
        )

    def on_forked(forked):
        if parallel:
            ctx.bus.emit("world.forked", forked)

    with ThreadPoolExecutor(max_workers=len(jobs) if parallel else 1) as pool:
        outcomes = list(pool.map(lambda job: ctx.backend.run_world(job, on_forked), jobs))

    results = [WorldResult.model_validate(r) for r in ctx.backend.grade(outcomes, ctx.backend.answer_key())]
    ctx.backend.settle(outcomes, {r.world_id for r in results if r.breached})

    attack_results = [r for r in results if r.attack_id is not None]
    clean_results = [r for r in results if r.attack_id is None]
    summary = GenDone(
        generation=generation,
        exam=exam,
        mode=mode,
        attack_worlds=len(attack_results),
        survived=sum(not r.breached for r in attack_results),
        clean_worlds=len(clean_results),
        false_alarms=sum(r.false_alarm for r in clean_results),
        dollars_lost=round(sum(r.dollars_over for r in attack_results), 2),
        seconds=round(time.monotonic() - started, 2),
    )
    if parallel:
        for result in results:
            ctx.store.put_world(result)
            ctx.bus.emit("world.graded", result)
    ctx.bus.emit("gen.done", summary)
    arize.log_generation(summary, results, plan)
    return results


def run_arena(ctx: ArenaContext, generations: int = 4) -> BluePlan:
    """A6: G generations, then the final exam, then graduation."""
    from arena import exam, graduation

    plan = validate_plan(blue.initial_plan(), None)
    attacks: list[AttackSpec] = []
    results: list[WorldResult] = []

    for generation in range(1, generations + 1):
        attacks = red.propose_attacks(generation, ctx.attack_worlds, attacks, results, seed=ctx.seed)
        results = run_generation(ctx, generation, plan, attacks)

        new_lessons = []
        for result in results:
            if result.breached and result.attack_id:
                lesson = blue.write_lesson(result, ctx.attacks[result.attack_id], plan)  # B2
                ctx.store.put_lesson(lesson)
                ctx.bus.emit("lesson.filed", lesson)
                new_lessons.append(lesson)

        if new_lessons:  # B3: lessons from the breached branches and their parents
            relevant = ctx.store.lessons_for([lesson.attack_id for lesson in new_lessons])
            plan = validate_plan(blue.revise_plan(plan, relevant, ctx.attacks), plan)  # B4

    passed = exam.run_exam(ctx, plan, generation=generations + 1)
    graduation.graduate(ctx, plan, passed)
    return plan
