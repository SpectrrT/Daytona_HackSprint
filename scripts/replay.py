"""Replay or publish a recorded run (A7, U1).

    python -m scripts.replay runs/<run_id>.jsonl                 # print it with original timing
    python -m scripts.replay runs/<run_id>.jsonl --speed 0       # print instantly
    python -m scripts.replay runs/<run_id>.jsonl --to-web        # make it the web app's bundled sample
    python -m scripts.replay runs/<run_id>.jsonl --to-demo       # keep it as the stage backup (runs/demo/)

Validates every event against contracts/ on the way.
"""

from __future__ import annotations

import argparse
import shutil
import time
from pathlib import Path

from arena.events import load_run


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("path", type=Path)
    parser.add_argument("--speed", type=float, default=1.0, help="0 = no delays")
    parser.add_argument("--to-web", action="store_true")
    parser.add_argument("--to-demo", action="store_true")
    args = parser.parse_args()

    events = load_run(args.path)  # raises if any event breaks the contract
    if args.to_web:
        shutil.copy(args.path, Path("web/public/sample-run.jsonl"))
        print(f"copied {len(events)} events to web/public/sample-run.jsonl")
        return
    if args.to_demo:
        Path("runs/demo").mkdir(parents=True, exist_ok=True)
        shutil.copy(args.path, Path("runs/demo") / args.path.name)
        print(f"saved runs/demo/{args.path.name}")
        return

    previous = events[0].ts if events else 0.0
    for event in events:
        if args.speed > 0:
            time.sleep(max(0.0, (event.ts - previous) / args.speed))
        previous = event.ts
        print(f"{event.type:15} {event.payload}")


if __name__ == "__main__":
    main()
