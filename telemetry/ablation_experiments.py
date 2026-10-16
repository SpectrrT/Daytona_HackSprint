"""Arize experiments score recorded, source-bound independent Verilator evidence.

This does not rerun model inference. Deterministic evaluators run inside the Arize
experiment workflow over hardware evidence already captured by the controller.
Missing designs receive a label and no numeric score.
"""
import contextlib
import hashlib
import json
import logging
import os
from pathlib import Path
import sys


def check_score(output, check_id):
    if output.get("status") != "evaluated":
        return {"label": output.get("status", "missing"), "explanation": "No hardware score exists for this slot."}
    found = [c for c in output["checks"] if c["id"] == check_id and c["hidden"]]
    if len(found) != 1:
        return {"label": "missing", "explanation": "The requested hidden check was not executed."}
    return {"score": float(found[0]["passed"]), "label": "pass" if found[0]["passed"] else "fail", "explanation": "Independent oracle verdict on actual Daytona Verilator observations."}


def held_out(output):
    return check_score(output, "held-out")


def first_try_transfer(output):
    if output.get("generation") != 0:
        return {"label": "not_first_try", "explanation": "Only the initial design counts for transfer."}
    return check_score(output, "transfer-empty-boundary")


def all_gates(output):
    if output.get("status") != "evaluated" or not output.get("checks"):
        return {"label": "missing"}
    passed = all(c["passed"] for c in output["checks"]) and not output.get("build_error")
    return {"score": float(passed), "label": "pass" if passed else "fail", "explanation": "All independent verifier checks, including hidden checks and inherited regressions."}


def publish(path):
    from arize import ArizeClient
    results = json.loads(Path(path).read_text())
    space = os.environ["ARIZE_SPACE_ID"]
    client = ArizeClient(api_key=os.environ["ARIZE_API_KEY"])
    receipt_path = Path(path).with_name("arize-experiments.json")
    if receipt_path.exists():
        prior = json.loads(receipt_path.read_text())
        if prior.get("status") == "submitted":
            for item in prior["experiments"]:
                client.experiments.get(experiment=item["id"])
            return prior
    slots = [{"seed": seed, "generation": generation, "contract_hash": results["contractHash"], "corpus_hash": results["corpusHash"]} for seed in results["seeds"] for generation in range(results["generations"])]
    dataset_name = "hollow-purple-" + results["runId"]
    try:
        dataset = client.datasets.create(name=dataset_name, space=space, examples=slots, force_http=True)
    except Exception:
        dataset = client.datasets.get(dataset=dataset_name, space=space)
    receipt = {"status": "pending", "datasetId": dataset.id, "runId": results["runId"], "experiments": [], "errors": [], "evidenceMode": "recorded hardware evidence; Arize SDK deterministic evaluators"}
    for mode, label in [("none", "A Claude alone"), ("flat", "B Raw retrieval"), ("graph", "C Hollow Purple graph")]:
        trials = {t["seed"]: t for t in results["trials"] if t["mode"] == mode}

        def task(dataset_row):
            seed = int(dataset_row["seed"])
            generation = int(dataset_row["generation"])
            trial = trials.get(seed)
            if not trial:
                return {"status": "missing", "generation": generation}
            evaluations = [e for e in trial["evaluations"] if e["generation"] == generation]
            if not evaluations:
                return {"status": "missing" if trial["status"] == "missing" else "not_generated", "generation": generation}
            result = evaluations[0]["result"]
            artifact = Path(result["artifactPath"]) / "report.json"
            actual = json.loads(artifact.read_text())
            if actual != result or actual["backend"] != "verilator":
                raise ValueError("Verifier artifact does not match recorded hardware evidence")
            source_hash = hashlib.sha256(actual["source"].encode()).hexdigest()
            if source_hash != actual["sourceHash"]:
                raise ValueError("Source provenance mismatch")
            return {"status": "evaluated", "generation": generation, "checks": [{"id": c["id"], "passed": c["passed"], "hidden": c["hidden"]} for c in actual["checks"]], "source_hash": source_hash, "sandbox_id": actual.get("sandboxId"), "build_error": bool(actual.get("buildError")), "report_sha256": hashlib.sha256(artifact.read_bytes()).hexdigest()}

        try:
            experiment, frame = client.experiments.run(name=f"{results['runId']} {label}", dataset=dataset.id, task=task, evaluators={"held_out_pass": held_out, "first_try_transfer": first_try_transfer, "all_gates": all_gates}, concurrency=1, timeout=60, force_http=True, set_global_tracer_provider=False, metadata={"model": results["model"], "corpus_hash": results["corpusHash"], "contract_hash": results["contractHash"], "evidence_mode": "recorded independent Verilator evidence"})
            confirmed = client.experiments.get(experiment=experiment.id)
            item = {"mode": mode, "id": confirmed.id, "name": confirmed.name, "rows": len(frame), "readback": True}
            score_columns = [c for c in frame.columns if str(c).endswith(".score")]
            item["scores"] = {str(column): {"count": int(frame[column].notna().sum()), "mean": None if frame[column].dropna().empty else float(frame[column].dropna().astype(float).mean())} for column in score_columns}
            receipt["experiments"].append(item)
        except Exception as error:
            receipt["errors"].append({"mode": mode, "errorType": type(error).__name__})
        receipt_path.write_text(json.dumps(receipt, indent=2))
    receipt["status"] = "submitted" if len(receipt["experiments"]) == 3 and not receipt["errors"] else "partial"
    receipt_path.write_text(json.dumps(receipt, indent=2))
    return receipt


if __name__ == "__main__":
    logging.basicConfig(level=logging.ERROR)
    try:
        with contextlib.redirect_stdout(sys.stderr):
            receipt = publish(sys.argv[1])
        print(json.dumps(receipt))
    except Exception as error:
        print(json.dumps({"status": "missing", "errorType": type(error).__name__, "error": "Arize experiments unavailable. Hardware evidence is retained."}))
        sys.exit(1)
