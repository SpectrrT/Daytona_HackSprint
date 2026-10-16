"""Writes contracts/schemas/*.schema.json from contracts/models.py (`make contracts`).

python -m scripts.export_contracts           # write
python -m scripts.export_contracts --check   # exit 1 if the committed schemas are stale
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from contracts import CONTRACT_MODELS

SCHEMA_DIR = Path(__file__).resolve().parent.parent / "contracts" / "schemas"


def rendered() -> dict[Path, str]:
    return {
        SCHEMA_DIR / f"{name}.schema.json": json.dumps(model.model_json_schema(), indent=2, sort_keys=True) + "\n"
        for name, model in CONTRACT_MODELS.items()
    }


def main() -> None:
    files = rendered()
    if "--check" in sys.argv:
        stale = [p.name for p, text in files.items() if not p.exists() or p.read_text() != text]
        if stale:
            sys.exit(f"stale contract schemas (run `make contracts`): {stale}")
        print("contract schemas up to date")
        return
    SCHEMA_DIR.mkdir(parents=True, exist_ok=True)
    for path, text in files.items():
        path.write_text(text)
    print(f"wrote {len(files)} schemas to {SCHEMA_DIR}")


if __name__ == "__main__":
    main()
