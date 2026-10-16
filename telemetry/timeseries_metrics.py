"""Mirror each real generation row as scored metrics in an Arize experiment."""
import contextlib
import hashlib
import json
import logging
import os
from pathlib import Path
import sys

METRICS = ("generation", "t_elapsed_s", "breaches_new", "breaches_cumulative", "fixed_cumulative", "open_bugs", "heldout_pass", "heldout_total")


def mirror(path):
    from arize import ArizeClient
    from arize._generated.api_client import ExperimentRunInput
    from arize.experiments.types import ExperimentTaskFieldNames
    from arize.experiments.evaluators.types import EvaluationResultFieldNames
    source = Path(path)
    rows = [json.loads(line) for line in source.read_text().splitlines() if line.strip()]
    receipt_path = source.with_name("timeseries-arize.json")
    receipt = json.loads(receipt_path.read_text()) if receipt_path.exists() else {"experiments": {}, "rows": {}, "errors": []}
    client = ArizeClient(api_key=os.environ["ARIZE_API_KEY"])
    space = os.environ["ARIZE_SPACE_ID"]
    if receipt.get("formatVersion") != 2:
        verified = {}
        for experiment_id in receipt["experiments"].values():
            existing = client.experiments.list_runs(experiment=experiment_id, limit=500)
            for item in existing.experiment_runs:
                values = item.additional_properties or {}
                if values.get("row_key") and values.get("row_sha256") and all(values.get(f"eval.{name}.score") is not None for name in METRICS):
                    verified[values["row_key"]] = values["row_sha256"]
        receipt["rows"] = verified
        receipt["formatVersion"] = 2
    for row in rows:
        key = f"{row['pack']}:{row['arm']}:{row['seed']}:{row['generation']}"
        canonical = json.dumps(row, sort_keys=True)
        digest = hashlib.sha256(canonical.encode()).hexdigest()
        if receipt["rows"].get(key) == digest:
            continue
        group = f"{row['pack']}:{row['arm']}:{row['seed']}"
        metrics = {name: row[name] for name in METRICS}
        if row["heldout_total"]:
            metrics["heldout_pass_rate"] = row["heldout_pass"] / row["heldout_total"]
        run = {"output": canonical, **{f"eval.{name}.score": value for name, value in metrics.items()}, "row_key": key, "row_sha256": digest, "fix_generations": row["fix_generations"]}
        try:
            if group in receipt["experiments"]:
                client.experiments.append_runs(experiment=receipt["experiments"][group], experiment_runs=[ExperimentRunInput.from_dict(run)])
            else:
                experiment = client.experiments.create(name=f"{row['run']} generation metrics {group}", space=space, experiment_runs=[run], task_fields=ExperimentTaskFieldNames(output="output"), evaluator_columns={name: EvaluationResultFieldNames(score=f"eval.{name}.score") for name in metrics}, force_http=True)
                receipt["experiments"][group] = experiment.id
            remote = client.experiments.list_runs(experiment=receipt["experiments"][group], limit=500)
            confirmed = any((item.additional_properties or {}).get("row_sha256") == digest and all((item.additional_properties or {}).get(f"eval.{name}.score") == value for name, value in metrics.items()) for item in remote.experiment_runs)
            if not confirmed:
                raise RuntimeError("Metric row was not confirmed on readback")
            receipt["rows"][key] = digest
        except Exception as error:
            receipt["errors"].append({"row": key, "errorType": type(error).__name__})
        receipt_path.write_text(json.dumps(receipt, indent=2))
    receipt["status"] = "submitted" if all(f"{r['pack']}:{r['arm']}:{r['seed']}:{r['generation']}" in receipt["rows"] for r in rows) else "partial"
    receipt_path.write_text(json.dumps(receipt, indent=2))
    return receipt


if __name__ == "__main__":
    logging.basicConfig(level=logging.ERROR)
    try:
        with contextlib.redirect_stdout(sys.stderr):
            result = mirror(sys.argv[1])
        print(json.dumps({"status": result["status"], "rows": len(result["rows"]), "experiments": len(result["experiments"])}))
    except Exception as error:
        print(json.dumps({"status": "missing", "errorType": type(error).__name__}))
        sys.exit(1)
