"""Loads the fixed attack menu and enforces it (R1, R3). Owner: Ryan."""

from __future__ import annotations

import random
from functools import lru_cache
from pathlib import Path
from typing import Any

import yaml

from contracts import AttackSpec

MENU_PATH = Path(__file__).with_name("menu.yaml")


class OffMenuAttack(ValueError):
    """Raised when an attack isn't on the menu or its params fall outside the menu's ranges."""


@lru_cache(maxsize=1)
def load_menu() -> dict[str, Any]:
    return yaml.safe_load(MENU_PATH.read_text())


def training_types() -> list[tuple[str, str]]:
    """Every (family, type) Red may train on, in menu order."""
    return [(fam, typ) for fam, types in load_menu()["families"].items() for typ in types]


def type_entry(family: str, type_: str) -> dict[str, Any]:
    try:
        return load_menu()["families"][family][type_]
    except KeyError as exc:
        raise OffMenuAttack(f"{family}/{type_} is not on the menu") from exc


def defended_by(family: str, type_: str) -> list[str]:
    return list(type_entry(family, type_)["defended_by"])


def sample_params(family: str, type_: str, rng: random.Random) -> dict[str, Any]:
    """Draw params uniformly inside the menu's ranges."""
    params: dict[str, Any] = {}
    for name, spec in type_entry(family, type_)["params"].items():
        if "choices" in spec:
            params[name] = rng.choice(spec["choices"])
        elif isinstance(spec["min"], int) and isinstance(spec["max"], int):
            params[name] = rng.randint(spec["min"], spec["max"])
        else:
            params[name] = round(rng.uniform(spec["min"], spec["max"]), 3)
    return params


def validate_training_attack(attack: AttackSpec) -> None:
    """R1 + R3: a training attack must be on the menu, inside its ranges, and not held out."""
    if attack.held_out:
        raise OffMenuAttack(f"{attack.id} is a held-out exam attack; Red can't train on it")
    entry = type_entry(attack.family, attack.type)
    allowed = entry["params"]
    unknown = set(attack.params) - set(allowed)
    if unknown:
        raise OffMenuAttack(f"{attack.id}: params not on the menu: {sorted(unknown)}")
    for name, spec in allowed.items():
        if name not in attack.params:
            raise OffMenuAttack(f"{attack.id}: missing param {name}")
        value = attack.params[name]
        if "choices" in spec:
            if value not in spec["choices"]:
                raise OffMenuAttack(f"{attack.id}: {name}={value!r} not in {spec['choices']}")
        elif not spec["min"] <= value <= spec["max"]:
            raise OffMenuAttack(f"{attack.id}: {name}={value} outside [{spec['min']}, {spec['max']}]")


def held_out_specs(generation: int, seed: int = 0) -> list[AttackSpec]:
    """The final exam's attacks. Only arena/exam.py may call this."""
    return [
        AttackSpec(
            id=f"exam.{entry['family']}.{entry['type']}.{i}",
            family=entry["family"],
            type=entry["type"],
            params=dict(entry["params"]),
            seed=seed + i,
            parent_id=None,
            generation=generation,
            held_out=True,
        )
        for i, entry in enumerate(load_menu()["held_out"])
    ]
