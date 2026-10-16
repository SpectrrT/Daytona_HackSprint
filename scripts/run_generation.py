"""Run the arena from the command line (no web server needed).

    python -m scripts.run_generation                       # 4 generations + exam + graduation, fake backend
    python -m scripts.run_generation --generations 1       # Must-have: one generation end to end
    python -m scripts.run_generation --backend daytona --timing   # also measure parallel vs sequential (A8)

The run is recorded to runs/<run_id>.jsonl; open it in the web app's replay picker.
"""

from __future__ import annotations

import argparse

from dotenv import load_dotenv


def main() -> None:
    load_dotenv()
    from agents import blue, red
    from arena.backends import make_backend
    from arena.events import EventBus
    from arena.generation import ArenaContext, run_arena
    from arena.timing import measure_speedup
    from memory.store import make_store
    from telemetry import arize

    parser = argparse.ArgumentParser()
    parser.add_argument("--generations", type=int, default=4)
    parser.add_argument("--attack-worlds", type=int, default=6)
    parser.add_argument("--clean-worlds", type=int, default=2)
    parser.add_argument("--backend", choices=["fake", "daytona"], default=None)
    parser.add_argument("--timing", action="store_true", help="only measure one generation parallel vs sequential")
    parser.add_argument("--run-id", default=None)
    args = parser.parse_args()

    arize.setup_tracing()
    bus = EventBus()
    run_id = bus.start_run(args.run_id)
    ctx = ArenaContext(
        bus=bus,
        backend=make_backend(args.backend),
        store=make_store(),
        attack_worlds=args.attack_worlds,
        clean_worlds=args.clean_worlds,
    )
    print(f"run {run_id} on the {ctx.backend.kind} backend → runs/{run_id}.jsonl")

    if args.timing:
        attacks = red.propose_attacks(1, ctx.attack_worlds, [], [], seed=ctx.seed)
        print(measure_speedup(ctx, 1, blue.initial_plan(), attacks))
    else:
        run_arena(ctx, generations=args.generations)

    for event in bus.history:
        if event.type in ("gen.done", "exam.done", "call.status", "prod.committed"):
            print(f"{event.type:15} {event.payload}")
    bus.close()


if __name__ == "__main__":
    main()
