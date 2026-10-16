"""A8: time one generation run in parallel and again one world at a time. Owner: Tensae.

The sequential run emits only its gen.done (mode="sequential"), so the scoreboard can show both
times without the sequential worlds cluttering the graph. Every number comes from a measured run.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from contracts import AttackSpec, BluePlan

if TYPE_CHECKING:
    from arena.generation import ArenaContext


def measure_speedup(ctx: ArenaContext, generation: int, plan: BluePlan, attacks: list[AttackSpec]) -> dict:
    from arena.generation import run_generation

    def timed(parallel: bool) -> float:
        before = len(ctx.bus.history)
        run_generation(ctx, generation, plan, attacks, parallel=parallel)
        done = [e for e in ctx.bus.history[before:] if e.type == "gen.done"]
        return done[-1].payload["seconds"]

    parallel_s = timed(parallel=True)
    sequential_s = timed(parallel=False)
    return {
        "parallel_seconds": parallel_s,
        "sequential_seconds": sequential_s,
        "speedup": round(sequential_s / parallel_s, 2) if parallel_s else None,
    }
