"""Contract tests: every spec, plan, result and event validates against contracts/ (covers: All)."""

from __future__ import annotations

import json

import jsonschema
import pytest
from pydantic import ValidationError

from agents import blue, red
from arena.generation import run_generation
from contracts import CONTRACT_MODELS, AttackSpec, Event, validate_event
from scripts.export_contracts import SCHEMA_DIR, rendered


def test_exported_schemas_are_up_to_date():
    stale = [p.name for p, text in rendered().items() if not p.exists() or p.read_text() != text]
    assert not stale, f"run `make contracts`; stale: {stale}"


def _schema(name: str) -> dict:
    return json.loads((SCHEMA_DIR / f"{name}.schema.json").read_text())


def test_generation_output_validates_against_exported_json_schemas(ctx):
    attacks = red.propose_attacks(1, ctx.attack_worlds, [], [])
    plan = blue.initial_plan()
    results = run_generation(ctx, 1, plan, attacks)

    for attack in attacks:
        jsonschema.validate(attack.model_dump(mode="json"), _schema("attack_spec"))
    jsonschema.validate(plan.model_dump(mode="json"), _schema("blue_plan"))
    for result in results:
        jsonschema.validate(result.model_dump(mode="json"), _schema("world_result"))
    for event in ctx.bus.history:
        jsonschema.validate(event.model_dump(mode="json"), _schema("event"))
        jsonschema.validate(event.payload, _schema(f"payload.{event.type}"))


def test_every_contract_round_trips():
    plan = blue.initial_plan()
    assert type(plan).model_validate_json(plan.model_dump_json()) == plan
    assert set(CONTRACT_MODELS) >= {"attack_spec", "blue_plan", "world_result", "event"}


def test_unknown_fields_and_bad_payloads_are_rejected():
    with pytest.raises(ValidationError):
        AttackSpec.model_validate({"id": "a", "family": "f", "type": "t", "seed": 1, "generation": 1, "extra": 1})
    with pytest.raises(ValidationError):
        validate_event(Event(ts=0, type="gen.done", payload={"generation": 1}))
