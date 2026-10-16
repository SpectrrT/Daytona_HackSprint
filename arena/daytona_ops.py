"""Real worlds on Daytona. Owner: Tensae.

SDK calls below were checked against daytona==0.224 (Sandbox.fork, update_network_settings,
pause, create_snapshot, create_signed_preview_url; Daytona.create/get). The flow is written but
NOT yet run against a real org — first hour: build the prod sandbox (scripts/build_snapshot.py),
then make tests/test_daytona_lifecycle.py pass.

Open questions to settle in the first hour:
  - Does a fork keep running processes (Postgres, app, mock) or only the disk? If disk only,
    START_SERVICES must bring them up in each world (counts against the 30 s budget).
  - Can a paused world still serve its preview link for the inspector? If not, stop (not delete)
    breached worlds and start one on click.
  - Org limits on concurrent sandboxes / vCPUs (Capacity constraint): 8 worlds + prod + grader.
If fork fails, create worlds from a prod snapshot instead (Daytona.create with
CreateSandboxFromSnapshotParams(snapshot=..., network_block_all=True)); the loop doesn't change.
"""

from __future__ import annotations

import json
import os
import re
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any, Literal

from arena.backends import WorldJob, WorldOutcome, grader_job
from contracts import BluePlan, ProdCommitted, WorldForked

HP = "/opt/antibody"  # where world/ lives inside the prod sandbox
START_SERVICES = f"bash {HP}/start_services.sh"  # TODO(Tensae): written by build_snapshot
APP_PORT = 8080
ANSWER_KEY_PATH = Path("build/answer_key.json")
GRADER_SCRIPT = Path(__file__).resolve().parent.parent / "grader" / "score.py"


class WorldCommandFailed(RuntimeError):
    pass


def _exec(sandbox, command: str, timeout: int = 30) -> str:
    res = sandbox.process.exec(command, cwd=HP, timeout=timeout)
    if res.exit_code != 0:
        raise WorldCommandFailed(f"{sandbox.id}: `{command}` exited {res.exit_code}: {res.result[-2000:]}")
    return res.result


def _put_json(sandbox, path: str, data: Any) -> None:
    payload = data.model_dump_json() if hasattr(data, "model_dump_json") else json.dumps(data)
    sandbox.fs.upload_file(payload.encode(), path)


def _sandbox_name(*parts: str) -> str:
    return re.sub(r"[^a-z0-9-]", "-", "-".join(parts).lower())[:60]


class DaytonaBackend:
    kind: Literal["daytona"] = "daytona"

    def __init__(self) -> None:
        from daytona import Daytona

        self.daytona = Daytona()  # reads DAYTONA_API_KEY / DAYTONA_API_URL
        self.prod = self.daytona.get(os.environ.get("PROD_SANDBOX_NAME", "antibody-prod"))
        self.run_tag = time.strftime("%H%M%S")
        self._worlds: dict[str, Any] = {}

    def answer_key(self) -> dict[str, Any]:
        return json.loads(ANSWER_KEY_PATH.read_text())  # host only; never uploaded to a world (W3)

    def run_world(self, job: WorldJob, on_forked: Callable[[WorldForked], None]) -> WorldOutcome:
        started = time.monotonic()
        world = self.prod.fork(name=_sandbox_name("antibody", self.run_tag, job.world_id))
        world.update_network_settings(network_block_all=True)  # A1: seal the moment it exists
        self._worlds[job.world_id] = world
        on_forked(
            WorldForked(
                world_id=job.world_id,
                generation=job.generation,
                attack_id=job.attack.id if job.attack else None,
                sandbox_id=world.id,
            )
        )

        _exec(world, START_SERVICES)
        if job.attack is not None:  # A2: clean worlds stay untouched
            _put_json(world, f"{HP}/attack.json", job.attack)
            _exec(world, f"python -m world.prep {HP}/attack.json")
        _put_json(world, f"{HP}/plan.json", job.plan)
        _exec(world, f"python -m world.executor {HP}/plan.json", timeout=30)
        dump = json.loads(_exec(world, "python -m world.dump"))
        preview = world.create_signed_preview_url(APP_PORT, expires_in_seconds=3600).url
        return WorldOutcome(job, world.id, preview, time.monotonic() - started, dump)

    def grade(self, outcomes: list[WorldOutcome], answer_key: dict[str, Any]) -> list[dict[str, Any]]:
        from daytona import CreateSandboxFromImageParams

        grader = self.daytona.create(
            CreateSandboxFromImageParams(
                image=os.getenv("GRADER_IMAGE", "python:3.11-slim"),
                name=_sandbox_name("antibody", self.run_tag, "grader", str(outcomes[0].job.generation)),
                network_block_all=True,  # G3: nothing in, nothing out
                labels={"antibody": "grader"},
            ),
            timeout=120,
        )
        try:
            grader.fs.upload_file(GRADER_SCRIPT.read_bytes(), "/tmp/score.py")
            _put_json(grader, "/tmp/job.json", grader_job(outcomes, answer_key))
            res = grader.process.exec("python /tmp/score.py /tmp/job.json", timeout=60)
            if res.exit_code != 0:
                raise WorldCommandFailed(f"grader exited {res.exit_code}: {res.result[-2000:]}")
            return json.loads(res.result)
        finally:
            grader.delete()

    def settle(self, outcomes: list[WorldOutcome], breached: set[str]) -> None:
        for outcome in outcomes:
            world = self._worlds.pop(outcome.job.world_id, None)
            if world is None:
                continue
            if outcome.job.world_id in breached:
                world.pause()  # A5: evidence
            else:
                world.delete()

    def commit_to_prod(self, plan: BluePlan) -> ProdCommitted:
        """V2. Only ever called after a passed exam AND a human yes (arena/graduation.py)."""
        snapshot = _sandbox_name("antibody-prod-pre-commit", time.strftime("%H%M%S"))
        self.prod.create_snapshot(snapshot, timeout=300)
        before = len(json.loads(_exec(self.prod, "python -m world.dump"))["provider_ledger"])
        _put_json(self.prod, f"{HP}/plan.json", plan)
        _exec(self.prod, f"python -m world.executor {HP}/plan.json", timeout=60)
        ledger = json.loads(_exec(self.prod, "python -m world.dump"))["provider_ledger"][before:]
        return ProdCommitted(
            plan_id=plan.id,
            snapshot=snapshot,
            refunds_issued=len(ledger),
            dollars_refunded=round(sum(float(e["amount"]) for e in ledger), 2),
            preview_url=self.prod.create_signed_preview_url(APP_PORT, expires_in_seconds=3600).url,
        )
