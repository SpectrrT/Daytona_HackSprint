"""Graduation: one real, irreversible action, gated twice (V1, V2). Owner: Tensae (commit), Donald (call).

Nothing runs on prod without a passed exam AND a human yes. On decline, nothing runs.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from contracts import BluePlan, CallStatus
from voice.call import request_approval

if TYPE_CHECKING:
    from arena.generation import ArenaContext


def graduate(ctx: ArenaContext, plan: BluePlan, exam_passed: bool) -> bool:
    if not exam_passed:
        ctx.bus.emit("call.status", CallStatus(status="skipped", detail="exam not passed; no call placed"))
        return False

    summary = (
        f"The refund plan {plan.id} passed its final exam on attacks it never saw. "
        "It is ready to refund everyone hit by yesterday's 2 to 4 pm checkout outage."
    )
    decision = request_approval(summary, on_status=lambda status: ctx.bus.emit("call.status", status))
    if decision != "approved":
        return False  # V2: on decline, nothing runs

    ctx.bus.emit("prod.committed", ctx.backend.commit_to_prod(plan))
    return True
