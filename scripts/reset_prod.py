"""Puts prod back to its seeded state between demo run-throughs. Owner: Tensae.

    python -m scripts.reset_prod

TODO(Tensae): on the prod sandbox, truncate refunds/outbox/provider.ledger and reload
build/seed.sql (or recreate prod from the antibody-prod-v1 snapshot). Run before each timed run-through.
"""

from __future__ import annotations


def main() -> None:
    raise NotImplementedError("TODO(Tensae)")


if __name__ == "__main__":
    main()
