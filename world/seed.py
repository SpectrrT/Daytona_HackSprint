"""Generates the seed data and the answer key ON THE HOST. Owner: Tensae.

W2  Plants the traps: orders around the 2-4pm outage window, failed payments in it, some
    already refunded by support, support tickets, and lookalike customers.
W3  The answer key (which orders are truly owed) never enters a world. This script writes
    build/seed.sql (uploaded into prod) and build/answer_key.json (kept on the host and sent
    only to the grader sandbox). build/ is gitignored.

    python -m world.seed --out build --orders 120 --seed 7
"""

from __future__ import annotations

import argparse
import json
import random
from datetime import datetime, timedelta
from pathlib import Path

DAY = datetime(2026, 10, 15)
OUTAGE_START = DAY.replace(hour=14)
OUTAGE_END = DAY.replace(hour=16)
FIRST_NAMES = ["Ana", "Ben", "Chen", "Dara", "Eli", "Fatima", "Gus", "Hana", "Ivan", "Jo", "Kai", "Lena"]
LAST_NAMES = ["Park", "Okafor", "Silva", "Nguyen", "Cohen", "Diaz", "Rossi", "Khan"]


def _q(value) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, (int, float)):
        return f"{value}"
    return "'" + str(value).replace("'", "''") + "'"


def generate(n_orders: int, seed: int) -> tuple[str, dict]:
    rng = random.Random(seed)
    sql: list[str] = []
    owed: dict[str, float] = {}

    customers = []
    for i in range(max(8, n_orders // 3)):
        first, last = rng.choice(FIRST_NAMES), rng.choice(LAST_NAMES)
        cid = f"c{i:04d}"
        customers.append(cid)
        sql.append(
            f"INSERT INTO customers VALUES ({_q(cid)}, {_q(f'{first} {last}')}, "
            f"{_q(f'{first}.{last}@example.com'.lower())});"
        )
        if rng.random() < 0.15:  # lookalike: same name, near-identical email, different account
            lid = f"c{i:04d}x"
            customers.append(lid)
            sql.append(
                f"INSERT INTO customers VALUES ({_q(lid)}, {_q(f'{first} {last}')}, "
                f"{_q(f'{first}.{last}1@example.com'.lower())});"
            )

    for i in range(n_orders):
        oid = f"o{i:05d}"
        cid = rng.choice(customers)
        amount = round(rng.uniform(12, 240), 2)
        # Cluster orders around the window so the edges (1:59pm, 4:01pm) are well populated.
        created = OUTAGE_START + timedelta(minutes=rng.randint(-90, 210))
        in_window = OUTAGE_START <= created < OUTAGE_END

        if in_window:
            order_status = "failed" if rng.random() < 0.7 else "completed"
            payment_status = "captured" if rng.random() < 0.75 else "failed"
        else:
            order_status = "failed" if rng.random() < 0.1 else "completed"
            payment_status = "captured" if order_status == "completed" or rng.random() < 0.5 else "failed"

        sql.append(
            f"INSERT INTO orders VALUES ({_q(oid)}, {_q(cid)}, {amount}, {_q(order_status)}, "
            f"{_q(created.isoformat(sep=' '))});"
        )
        sql.append(
            f"INSERT INTO payments VALUES ({_q('p' + oid[1:])}, {_q(oid)}, {_q(payment_status)}, "
            f"{_q('pi_' + oid)}, {_q(created.isoformat(sep=' '))});"
        )

        truly_owed = in_window and order_status == "failed" and payment_status == "captured"
        if truly_owed:
            owed[oid] = amount
            if rng.random() < 0.2:  # support already refunded it: in the app DB AND the provider ledger
                ref = f"rs_{oid}"
                sql.append(
                    f"INSERT INTO refunds (id, order_id, amount, source, created_at) VALUES "
                    f"({_q(ref)}, {_q(oid)}, {amount}, 'support', {_q(DAY.replace(hour=18))});"
                )
                sql.append(
                    f"INSERT INTO provider.ledger (refund_ref, order_id, amount) VALUES "
                    f"({_q(ref)}, {_q(oid)}, {amount});"
                )
        if in_window and rng.random() < 0.3:
            sql.append(
                f"INSERT INTO support_tickets VALUES ({_q('t' + oid[1:])}, {_q(cid)}, {_q(oid)}, "
                f"{_q('My checkout failed around 3pm but I think I was charged. Please help.')}, "
                f"{_q(DAY.replace(hour=17))});"
            )

    return "\n".join(sql) + "\n", {"owed": owed, "window": [str(OUTAGE_START), str(OUTAGE_END)], "seed": seed}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default="build")
    parser.add_argument("--orders", type=int, default=120)
    parser.add_argument("--seed", type=int, default=7)
    args = parser.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    seed_sql, answer_key = generate(args.orders, args.seed)
    (out / "seed.sql").write_text(seed_sql)
    (out / "answer_key.json").write_text(json.dumps(answer_key, indent=2))
    print(f"wrote {out}/seed.sql and {out}/answer_key.json ({len(answer_key['owed'])} owed orders)")


if __name__ == "__main__":
    main()
