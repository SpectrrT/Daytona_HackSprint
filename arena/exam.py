"""The final exam on held-out attacks (A6, R3, V1). Owner: Tensae.

Runs the graduated plan against attacks Red never trained on, plus the clean worlds. Passing
means zero breaches and zero false alarms; only then may graduation call the approver.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from agents.attacks import menu
from contracts import BluePlan, ExamDone

if TYPE_CHECKING:
    from arena.generation import ArenaContext


def run_exam(ctx: ArenaContext, plan: BluePlan, generation: int) -> bool:
    from arena.generation import run_generation

    attacks = menu.held_out_specs(generation, seed=ctx.seed)
    results = run_generation(ctx, generation, plan, attacks, exam=True)
    attack_results = [r for r in results if r.attack_id is not None]
    clean_results = [r for r in results if r.attack_id is None]
    done = ExamDone(
        generation=generation,
        passed=not any(r.breached for r in attack_results) and not any(r.false_alarm for r in clean_results),
        attack_worlds=len(attack_results),
        breaches=sum(r.breached for r in attack_results),
        clean_worlds=len(clean_results),
        false_alarms=sum(r.false_alarm for r in clean_results),
    )
    ctx.bus.emit("exam.done", done)
    return done.passed
