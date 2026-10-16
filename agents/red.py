"""Red: picks attacks from the fixed menu and evolves them. Owner: Ryan.

R1  Attacks come only from agents/attacks/menu.yaml, params inside its ranges. Never code.
R2  Keep attacks that breached; mutate fully defended branches into new variants.
R3  Never uses held-out exam attacks (menu.held_out_specs is off-limits here).

The deterministic baseline below works with no model calls, so the loop runs end to end today.
TODO(Ryan): replace `_choose_mutations` with a Claude call (agents.llm.ask) that looks at which
branches Blue defended and why, and proposes params designed to slip past Blue's knobs. Every
proposal still goes through menu.validate_training_attack before it's used.
"""

from __future__ import annotations

import random

from agents.attacks import menu
from contracts import AttackSpec, WorldResult


def _spec(generation: int, idx: int, family: str, type_: str, params: dict, seed: int, parent_id: str | None):
    return AttackSpec(
        id=f"g{generation}.{family}.{type_}.{idx}",
        family=family,
        type=type_,
        params=params,
        seed=seed,
        parent_id=parent_id,
        generation=generation,
        held_out=False,
    )


def propose_attacks(
    generation: int,
    n: int,
    previous: list[AttackSpec],
    previous_results: list[WorldResult],
    seed: int = 7,
) -> list[AttackSpec]:
    """Return n training attacks for this generation."""
    rng = random.Random(seed * 1000 + generation)
    types = menu.training_types()
    attacks: list[AttackSpec] = []

    if not previous:
        # Generation 1: cover the menu round-robin so every branch gets tested.
        for i in range(n):
            family, type_ = types[i % len(types)]
            params = menu.sample_params(family, type_, rng)
            attacks.append(_spec(generation, i, family, type_, params, rng.randrange(1 << 30), None))
    else:
        breached = {r.attack_id for r in previous_results if r.attack_id and r.breached}
        for i, prev in enumerate(_choose_mutations(previous, breached, n)):
            if prev.id in breached:
                params = dict(prev.params)  # R2: keep what works
            else:
                params = menu.sample_params(prev.family, prev.type, rng)  # R2: mutate defended branches
            attacks.append(_spec(generation, i, prev.family, prev.type, params, rng.randrange(1 << 30), prev.id))

    for attack in attacks:
        menu.validate_training_attack(attack)
    return attacks


def _choose_mutations(previous: list[AttackSpec], breached: set[str], n: int) -> list[AttackSpec]:
    """Which previous attacks to carry forward or mutate, breached ones first."""
    ordered = sorted(previous, key=lambda a: (a.id not in breached, a.id))
    return [ordered[i % len(ordered)] for i in range(n)]
