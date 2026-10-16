"""Seed data plants the traps (W2) deterministically; the answer key stays on the host (W3)."""

from __future__ import annotations

from world.seed import generate


def test_seed_is_deterministic_and_has_owed_orders():
    sql_a, key_a = generate(120, seed=7)
    sql_b, key_b = generate(120, seed=7)
    assert sql_a == sql_b and key_a == key_b
    assert 5 <= len(key_a["owed"]) < 120


def test_seed_plants_the_traps():
    sql, _ = generate(200, seed=7)
    assert "'support'" in sql  # some owed orders already refunded by support
    assert "INSERT INTO support_tickets" in sql
    assert "1@example.com" in sql  # lookalike customers
    assert "'failed', '2026-10-15 1" in sql  # failed orders near the window


def test_answer_key_is_not_in_the_seed_sql():
    sql, _ = generate(120, seed=7)
    assert "owed" not in sql
