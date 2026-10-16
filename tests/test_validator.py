"""Binding-vow test (B4) and the selection-query guard (B1, first line of defence)."""

from __future__ import annotations

import pytest

from agents import blue
from agents.validator import PlanRejected, check_plan, validate_plan


def _child(parent, **changes):
    data = parent.model_dump()
    data.update(id="plan.child", generation=parent.generation + 1, parent_id=parent.id, **changes)
    return type(parent).model_validate(data)


def test_child_with_an_extra_permission_is_rejected():
    parent = blue.initial_plan().model_copy(update={"permissions": ["db.read", "payments.refund"]})
    child = _child(parent, permissions=["db.read", "payments.refund", "outbox.send"])
    with pytest.raises(PlanRejected, match="binding vow"):
        validate_plan(child, parent)


def test_child_may_drop_permissions():
    parent = blue.initial_plan()
    child = _child(parent, permissions=["db.read", "payments.refund"])
    assert validate_plan(child, parent) is child


@pytest.mark.parametrize(
    "sql",
    [
        "UPDATE orders SET amount = 0",
        "SELECT 1; DELETE FROM refunds",
        "WITH x AS (DELETE FROM refunds RETURNING *) SELECT * FROM x",
        "DROP TABLE orders",
    ],
)
def test_selection_sql_must_be_a_single_read(sql):
    parent = blue.initial_plan()
    assert check_plan(_child(parent, selection_sql=sql), parent)


def test_known_plans_pass():
    assert check_plan(blue.initial_plan(), None) == []
    assert check_plan(blue.KNOWN_GOOD_PLAN, None) == []
