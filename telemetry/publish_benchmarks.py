"""Publish existing, measured FIFO benchmarks. Never substitute counts or quotas."""
import contextlib
import hashlib
import json
import logging
import os
from pathlib import Path
import sys


def publish(root):
    from arize import ArizeClient
    from arize.experiments.types import ExperimentTaskFieldNames
    from arize.experiments.evaluators.types import EvaluationResultFieldNames
    client = ArizeClient(api_key=os.environ["ARIZE_API_KEY"])
    space = os.environ["ARIZE_SPACE_ID"]
    base = Path(root) / "apps/server/src/benchmarks/results"
    red_path, timing_path = base / "2026-10-16-red.json", base / "2026-10-16-timing.json"
    red, timing = json.loads(red_path.read_text()), json.loads(timing_path.read_text())
    receipt_path = Path(root) / "data/verification/arize-benchmarks.json"
    receipt_path.parent.mkdir(parents=True, exist_ok=True)
    if receipt_path.exists():
        receipt = json.loads(receipt_path.read_text())
        if receipt.get("status") == "submitted":
            for experiment in receipt["experiments"]:
                client.experiments.get(experiment=experiment["id"])
            return receipt
    cases = red["cases"]
    def caught(case):
        normalized = {"agent-red-" + value.removeprefix("agent-red-").lower() for value in case.get("authoredAttackIds", [])}
        return case.get("backend") == "verilator" and case.get("reproduced") is True and case.get("failureTestId") in normalized
    bugs = [{"output": json.dumps({"case": c["id"], "source_hash": c["sourceHash"], "model": c.get("model"), "reproduced": c.get("reproduced")}), "catch_rate": float(caught(c))} for c in cases if c["defective"]]
    controls = [{"output": json.dumps({"case": c["id"], "source_hash": c["sourceHash"], "all_checks_passed": c.get("allChecksPassed")}), "false_alarm": float(c.get("backend") == "verilator" and c.get("reproduced") is True)} for c in cases if not c["defective"]]
    pairs = [{"output": json.dumps({"pair": p["pair"], "candidates": p["candidates"], "concurrency": p["concurrency"], "account_vcpu_limit": timing["snapshot"].get("accountVcpuLimit")}), "speedup": p["serialMs"] / p["parallelMs"], "serial_seconds": p["serialMs"] / 1000, "parallel_seconds": p["parallelMs"] / 1000} for p in timing["pairs"] if p["valid"]]
    specs = [(red["runId"] + " planted bug catch rate", bugs, ["catch_rate"]), (red["runId"] + " clean control false alarms", controls, ["false_alarm"]), (timing["runId"] + " paired Daytona timing", pairs, ["speedup", "serial_seconds", "parallel_seconds"])]
    receipt = {"status": "pending", "experiments": [], "sourceSha256": {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in [red_path, timing_path]}}
    for name, rows, metrics in specs:
        if not rows:
            continue
        try:
            experiment = client.experiments.create(name=name, space=space, experiment_runs=rows, task_fields=ExperimentTaskFieldNames(output="output"), evaluator_columns={key: EvaluationResultFieldNames(score=key) for key in metrics}, force_http=True)
        except Exception:
            experiment = client.experiments.get(experiment=name, space=space)
        confirmed = client.experiments.get(experiment=experiment.id)
        runs = client.experiments.list_runs(experiment=confirmed.id, limit=50)
        receipt["experiments"].append({"id": confirmed.id, "name": confirmed.name, "rows": len(runs.experiment_runs), "readback": True})
    receipt["status"] = "submitted" if len(receipt["experiments"]) == 3 else "partial"
    receipt_path.write_text(json.dumps(receipt, indent=2))
    return receipt


if __name__ == "__main__":
    logging.basicConfig(level=logging.ERROR)
    try:
        with contextlib.redirect_stdout(sys.stderr):
            result = publish(sys.argv[1])
        print(json.dumps(result))
    except Exception as error:
        print(json.dumps({"status": "missing", "errorType": type(error).__name__}))
        sys.exit(1)
