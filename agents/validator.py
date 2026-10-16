"""The binding vow (B4) and plan sanity checks. Owner: Ryan.

A child plan never gains a permission its parent lacked. The arena runs this on every plan Blue
produces, before any world sees it; a rejected plan never runs.
"""

from __future__ import annotations

import re

from contracts import BluePlan


class PlanRejected(ValueError):
    pass


_WRITE_KEYWORDS = re.compile(
    r"\b(insert|update|delete|merge|drop|alter|create|grant|revoke|truncate|copy|call|do|execute|set)\b",
    re.IGNORECASE,
)


def check_plan(child: BluePlan, parent: BluePlan | None) -> list[str]:
    """Return every reason the plan is unacceptable (empty list = OK)."""
    problems: list[str] = []

    if parent is not None:
        gained = set(child.permissions) - set(parent.permissions)
        if gained:
            problems.append(f"binding vow broken: gains {sorted(gained)} that parent {parent.id} lacked")
        if child.parent_id != parent.id:
            problems.append(f"parent_id is {child.parent_id!r}, expected {parent.id!r}")

    sql = child.selection_sql.strip().rstrip(";").strip()
    if ";" in sql:
        problems.append("selection_sql must be a single statement")
    if not re.match(r"^(select|with)\b", sql, re.IGNORECASE):
        problems.append("selection_sql must start with SELECT or WITH")
    if _WRITE_KEYWORDS.search(sql):
        problems.append("selection_sql contains a write or DDL keyword")
    # Belt and braces: the executor also runs it under the read-only role (B1).

    cap = child.knobs.per_customer_cap
    if cap is not None and cap <= 0:
        problems.append("per_customer_cap must be positive or null")

    return problems


def validate_plan(child: BluePlan, parent: BluePlan | None) -> BluePlan:
    problems = check_plan(child, parent)
    if problems:
        raise PlanRejected("; ".join(problems))
    return child
