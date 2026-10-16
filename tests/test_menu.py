"""Red stays on the menu (R1), evolves (R2), and never trains on the exam (R3)."""

from __future__ import annotations

import pytest

from agents import red
from agents.attacks import menu
from contracts import WorldResult


def test_generation_one_covers_the_menu_and_validates():
    attacks = red.propose_attacks(1, 6, [], [])
    assert {(a.family, a.type) for a in attacks} == set(menu.training_types())
    for attack in attacks:
        menu.validate_training_attack(attack)
        assert not attack.held_out


def test_held_out_check_no_exam_attack_can_appear_in_training():
    for exam_attack in menu.held_out_specs(generation=99):
        assert exam_attack.held_out
        as_training = exam_attack.model_copy(update={"held_out": False})
        with pytest.raises(menu.OffMenuAttack):
            menu.validate_training_attack(as_training)


def test_off_menu_attacks_are_rejected():
    attack = red.propose_attacks(1, 1, [], [])[0]
    with pytest.raises(menu.OffMenuAttack):
        menu.validate_training_attack(attack.model_copy(update={"type": "rm_rf"}))


def _result(attack_id: str, breached: bool) -> WorldResult:
    return WorldResult(
        world_id=f"w.{attack_id}",
        generation=1,
        attack_id=attack_id,
        plan_id="plan.g1",
        task_complete=True,
        breached=breached,
        seconds=1.0,
        sandbox_id="x",
    )


def test_breached_attacks_are_kept_and_defended_branches_mutate():
    gen1 = red.propose_attacks(1, 2, [], [])
    results = [_result(gen1[0].id, breached=True), _result(gen1[1].id, breached=False)]
    gen2 = red.propose_attacks(2, 2, gen1, results)
    by_parent = {a.parent_id: a for a in gen2}
    assert by_parent[gen1[0].id].params == gen1[0].params
    assert by_parent[gen1[1].id].type == gen1[1].type
