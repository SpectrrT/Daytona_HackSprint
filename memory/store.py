"""The attack tree as a graph (M1). Owner: Ryan.

Stores attacks (with mutated_into edges), worlds (hit_by edges to their attack), verdicts and
lessons (protects edges to the attack branch). Blue asks it for the lessons on a branch and all
of that branch's ancestors (B3).

MEMORY_BACKEND=memory (default) keeps it in-process so everything runs with no database.
MEMORY_BACKEND=surreal uses SurrealDB (`make surreal` starts one locally on :8001).
The Surreal calls follow the surrealdb 2.x Python SDK (Surreal(url) → signin → use → query) but
have NOT been run yet — first job: make tests/test_memory.py pass with MEMORY_BACKEND=surreal.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Protocol

from contracts import AttackSpec, Lesson, WorldResult

SCHEMA_PATH = Path(__file__).with_name("schema.surql")


class TreeStore(Protocol):
    def put_attack(self, attack: AttackSpec) -> None: ...
    def put_world(self, result: WorldResult) -> None: ...
    def put_lesson(self, lesson: Lesson) -> None: ...
    def lessons_for(self, attack_ids: list[str]) -> list[Lesson]:
        """Lessons filed on these branches and on every ancestor branch, oldest first."""
        ...


class InMemoryTreeStore:
    def __init__(self) -> None:
        self.attacks: dict[str, AttackSpec] = {}
        self.worlds: dict[str, WorldResult] = {}
        self.lessons: dict[str, Lesson] = {}

    def put_attack(self, attack: AttackSpec) -> None:
        self.attacks[attack.id] = attack

    def put_world(self, result: WorldResult) -> None:
        self.worlds[result.world_id] = result

    def put_lesson(self, lesson: Lesson) -> None:
        self.lessons[lesson.id] = lesson

    def _with_ancestors(self, attack_ids: list[str]) -> set[str]:
        seen: set[str] = set()
        for attack_id in attack_ids:
            current: str | None = attack_id
            while current and current not in seen:
                seen.add(current)
                parent = self.attacks.get(current)
                current = parent.parent_id if parent else None
        return seen

    def lessons_for(self, attack_ids: list[str]) -> list[Lesson]:
        branch = self._with_ancestors(attack_ids)
        return sorted((x for x in self.lessons.values() if x.attack_id in branch), key=lambda x: (x.generation, x.id))


class SurrealTreeStore:
    def __init__(self) -> None:
        from surrealdb import Surreal

        self.db = Surreal(os.getenv("SURREAL_URL", "ws://localhost:8001/rpc"))
        self.db.signin({"username": os.getenv("SURREAL_USER", "root"), "password": os.getenv("SURREAL_PASS", "root")})
        self.db.use(os.getenv("SURREAL_NS", "antibody"), os.getenv("SURREAL_DB", "arena"))
        self.db.query(SCHEMA_PATH.read_text())

    def put_attack(self, attack: AttackSpec) -> None:
        self.db.query(
            "UPSERT type::thing('attack', $id) CONTENT $data;"
            "IF $parent != NONE {"
            " RELATE (type::thing('attack', $parent))->mutated_into->(type::thing('attack', $id)) };",
            {"id": attack.id, "parent": attack.parent_id, "data": attack.model_dump(mode="json")},
        )

    def put_world(self, result: WorldResult) -> None:
        self.db.query(
            "UPSERT type::thing('world', $id) CONTENT $data;"
            "IF $attack != NONE { RELATE (type::thing('world', $id))->hit_by->(type::thing('attack', $attack)) };",
            {"id": result.world_id, "attack": result.attack_id, "data": result.model_dump(mode="json")},
        )

    def put_lesson(self, lesson: Lesson) -> None:
        self.db.query(
            "UPSERT type::thing('lesson', $id) CONTENT $data;"
            "RELATE (type::thing('lesson', $id))->protects->(type::thing('attack', $attack));",
            {"id": lesson.id, "attack": lesson.attack_id, "data": lesson.model_dump(mode="json")},
        )

    def lessons_for(self, attack_ids: list[str]) -> list[Lesson]:
        branch: set[str] = set()
        frontier = list(attack_ids)
        while frontier:  # walk parent_id up the tree
            current = frontier.pop()
            if current in branch:
                continue
            branch.add(current)
            rows = self.db.query("SELECT parent_id FROM type::thing('attack', $id)", {"id": current})
            parent = rows[0].get("parent_id") if rows else None
            if parent:
                frontier.append(parent)
        rows = self.db.query(
            "SELECT * OMIT id FROM lesson WHERE attack_id IN $ids ORDER BY generation", {"ids": sorted(branch)}
        )
        return [Lesson.model_validate(row) for row in rows]


def make_store() -> TreeStore:
    kind = os.getenv("MEMORY_BACKEND", "memory")
    if kind == "memory":
        return InMemoryTreeStore()
    if kind == "surreal":
        return SurrealTreeStore()
    raise ValueError(f"unknown MEMORY_BACKEND {kind!r}")
