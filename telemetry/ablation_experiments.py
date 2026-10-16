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
    scored = [check_score(item, "held-out") for item in output.get("evaluations", [])]
    values = [item["score"] for item in scored if "score" in item]
    return {"score": sum(values) / len(values), "label": "measured", "explanation": f"{int(sum(values))}/{len(values)} designs passed the independent held-out check."} if values else {"label": "missing"}


def first_try_transfer(output):
    evaluations = output.get("evaluations", [])
    return check_score(evaluations[0], "transfer-empty-boundary") if evaluations else {"label": "missing"}


def all_gates(output):
    evaluations = output.get("evaluations", [])
    if not evaluations:
        return {"label": "missing"}
    passed = any(item.get("checks") and all(c["passed"] for c in item["checks"]) and not item.get("build_error") for item in evaluations)
    return {"score": float(passed), "label": "pass" if passed else "fail", "explanation": "At least one real design passed all independent gates."}


def heldout_pass_count(output):
    scores = [check_score(item, "held-out") for item in output.get("evaluations", [])]
    values = [score["score"] for score in scores if "score" in score]
    return {"score": sum(values), "label": "count"} if values else {"label": "missing"}


def heldout_design_count(output):
    values = [item for item in output.get("evaluations", []) if "score" in check_score(item, "held-out")]
    return {"score": len(values), "label": "count"} if values else {"label": "missing"}


def publish(path):
    from arize import ArizeClient
    from arize.experiments.evaluators.types import EvaluationResult
    def sdk_evaluator(function):
        def evaluate(output):
            return EvaluationResult(**{"explanation": "Deterministic evaluation of recorded independent hardware evidence.", **function(output)})
        return evaluate
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
    slots = [{"seed": seed, "contract_hash": results["contractHash"], "corpus_hash": results["corpusHash"]} for seed in results["seeds"]]
    dataset_name = "hollow-purple-paired-seeds-v2-" + results["runId"]
    try:
        dataset = client.datasets.create(name=dataset_name, space=space, examples=slots, force_http=True)
    except Exception:
        dataset = client.datasets.get(dataset=dataset_name, space=space)
    receipt = {"status": "pending", "datasetId": dataset.id, "runId": results["runId"], "experiments": [], "errors": [], "evidenceMode": "recorded hardware evidence; Arize SDK deterministic evaluators"}
    for mode, label in [("none", "A Claude alone"), ("flat", "B Raw retrieval"), ("graph", "C Hollow Purple graph")]:
        trials = {t["seed"]: t for t in results["trials"] if t["mode"] == mode}

        def task(dataset_row):
            seed = int(dataset_row["seed"])
            trial = trials.get(seed)
            if not trial or not trial["evaluations"]:
                return {"status": "missing", "evaluations": []}
            evaluations = []
            for evaluation in trial["evaluations"]:
                result = evaluation["result"]
                artifact = Path(result["artifactPath"]) / "report.json"
                actual = json.loads(artifact.read_text())
                if actual != result or actual["backend"] != "verilator":
                    raise ValueError("Verifier artifact does not match recorded hardware evidence")
                source_hash = hashlib.sha256(actual["source"].encode()).hexdigest()
                if source_hash != actual["sourceHash"]:
                    raise ValueError("Source provenance mismatch")
                evaluations.append({"status": "evaluated", "generation": evaluation["generation"], "checks": [{"id": c["id"], "passed": c["passed"], "hidden": c["hidden"]} for c in actual["checks"]], "source_hash": source_hash, "sandbox_id": actual.get("sandboxId"), "build_error": bool(actual.get("buildError")), "report_sha256": hashlib.sha256(artifact.read_bytes()).hexdigest()})
            return {"status": trial["status"], "seed": seed, "evaluations": evaluations}

        try:
            experiment, frame = client.experiments.run(name=f"{results['runId']} {label}", dataset=dataset.id, task=task, evaluators={name: sdk_evaluator(function) for name, function in {"held_out_pass": held_out, "first_try_transfer": first_try_transfer, "all_gates": all_gates, "heldout_pass_count": heldout_pass_count, "heldout_design_count": heldout_design_count}.items()}, exit_on_error=True, concurrency=1, timeout=60, force_http=True, set_global_tracer_provider=False, metadata={"model": results["model"], "corpus_hash": results["corpusHash"], "contract_hash": results["contractHash"], "evidence_mode": "recorded independent Verilator evidence"})
            confirmed = client.experiments.get(experiment=experiment.id)
            item = {"mode": mode, "id": confirmed.id, "name": confirmed.name, "rows": len(frame), "readback": True}
            score_columns = [c for c in frame.columns if str(c).endswith(".score")]
            item["scores"] = {str(column): {"count": int(frame[column].notna().sum()), "mean": None if frame[column].dropna().empty else float(frame[column].dropna().astype(float).mean())} for column in score_columns}
            remote = client.experiments.list_runs(experiment=confirmed.id, limit=500)
            item["remoteRows"] = len(remote.experiment_runs)
            remote_values = [row.additional_properties or {} for row in remote.experiment_runs]
            item["remoteScores"] = {name: {"count": len(values), "sum": sum(values), "mean": sum(values) / len(values) if values else None} for name in ["held_out_pass", "first_try_transfer", "all_gates", "heldout_pass_count", "heldout_design_count"] if (values := [float(row[f"eval.{name}.score"]) for row in remote_values if row.get(f"eval.{name}.score") is not None])}
            if item["remoteRows"] != len(results["seeds"]) or "held_out_pass" not in item["remoteScores"]:
                raise RuntimeError("Arize experiment scores were not confirmed on readback")
            receipt["experiments"].append(item)
        except Exception as error:
            receipt["errors"].append({"mode": mode, "errorType": type(error).__name__})
            diagnostic = str(getattr(error, "body", None) or error)
            for credential in [os.environ.get("ARIZE_API_KEY", ""), os.environ.get("ARIZE_SPACE_ID", "")]:
                if credential:
                    diagnostic = diagnostic.replace(credential, "[redacted]")
            Path(path).with_name(f"arize-{mode}-diagnostic.json").write_text(json.dumps({"errorType": type(error).__name__, "detail": diagnostic[:4000]}))
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
