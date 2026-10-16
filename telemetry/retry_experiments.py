"""Record paired, source-bound retry evidence in Arize. No model inference here."""
import contextlib
import hashlib
import json
import os
from pathlib import Path
import sys


def source_hash(policy, guard):
    value = json.dumps({"systemPrompt": policy, "guardSource": guard}, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(value.encode()).hexdigest()


def publish(path):
    from arize import ArizeClient
    from arize.experiments.evaluators.types import EvaluationResult
    evidence = json.loads(Path(path).read_text())
    if evidence["status"] != "completed" or len(evidence["pairs"]) != 3 * evidence["repeats"]:
        raise ValueError("Incomplete paired hardware evidence")
    final = evidence["generations"][-1]
    if not final["regression"]["check"]["passed"] or not all(row["check"]["passed"] for row in final["gates"]):
        raise ValueError("The guard was not independently verified")
    freeze = json.loads(Path(path).with_name("evaluation-freeze.json").read_text())
    expected = {"model-only": source_hash(evidence["policy"], evidence["baselineGuard"]), "verified-guard": source_hash(evidence["policy"], final["guardSource"])}
    if expected["model-only"] != evidence["baselineSourceHash"] or expected["verified-guard"] != freeze["sourceHash"]:
        raise ValueError("Source provenance mismatch")
    pairs = {(p["repeat"], p["domain"]): p for p in evidence["pairs"]}
    if len(pairs) != len(evidence["pairs"]):
        raise ValueError("Duplicate paired case")
    for pair in pairs.values():
        for proposal in pair["proposals"]:
            agent = proposal["agent"]
            actual = json.loads((Path(agent["artifactPath"]) / "answer.json").read_text())
            if actual["actions"] != proposal["actions"] or agent["model"] != evidence["model"] or agent["startedAt"] < freeze["at"]:
                raise ValueError("Evaluation proposal was changed or generated before freezing")
        for arm in expected:
            row = pair[arm]
            if row["sourceHash"] != expected[arm]:
                raise ValueError("Wrong guard in paired row")
            for kind in ("retry", "clean"):
                if row[kind]["snapshot"]["sourceHash"] != row["sourceHash"]:
                    raise ValueError("Snapshot source mismatch")
    receipt_path = Path(path).with_name("arize-experiments.json")
    client = ArizeClient(api_key=os.environ["ARIZE_API_KEY"])
    if receipt_path.exists():
        old = json.loads(receipt_path.read_text())
        if old.get("status") == "submitted":
            for experiment in old["experiments"]:
                client.experiments.get(experiment=experiment["id"])
            return old
    slots = [{"repeat": key[0], "domain": key[1]} for key in sorted(pairs)]
    dataset_name = "antibody-retries-" + evidence["id"]
    try:
        dataset = client.datasets.create(name=dataset_name, space=os.environ["ARIZE_SPACE_ID"], examples=slots, force_http=True)
    except Exception:
        dataset = client.datasets.get(dataset=dataset_name, space=os.environ["ARIZE_SPACE_ID"])
    receipt = {"status": "pending", "datasetId": dataset.id, "experiments": [], "scope": evidence["scope"]}
    def retry_score(output):
        return EvaluationResult(score=float(output["retry_pass"]), label="pass" if output["retry_pass"] else "fail", explanation="Independent oracle checks actual concurrent tool effects and useful task completion.")
    def control_score(output):
        return EvaluationResult(score=float(output["clean_pass"]), label="pass" if output["clean_pass"] else "fail", explanation="The same first model proposal must complete the authorized single-request task.")
    for arm in ("model-only", "verified-guard"):
        def task(dataset_row):
            pair = pairs[(int(dataset_row["repeat"]), dataset_row["domain"])]
            row = pair[arm]
            return {"retry_pass": row["retry"]["check"]["passed"], "clean_pass": row["clean"]["check"]["passed"], "effects": len(row["retry"]["snapshot"]["effects"]), "source_hash": row["sourceHash"], "sandbox_id": row["sandboxId"]}
        experiment, _frame = client.experiments.run(name=evidence["id"] + " " + arm, dataset=dataset.id, task=task, evaluators={"retry_safety_and_completion": retry_score, "clean_completion": control_score}, concurrency=1, timeout=60, force_http=True, set_global_tracer_provider=False, exit_on_error=True, metadata={"model": evidence["model"], "contract_hash": evidence["contractHash"], "scope": evidence["scope"]})
        rows = client.experiments.list_runs(experiment=experiment.id, limit=500).experiment_runs
        scores = {}
        for metric in ("retry_safety_and_completion", "clean_completion"):
            values = [float(row.additional_properties[f"eval.{metric}.score"]) for row in rows if row.additional_properties and row.additional_properties.get(f"eval.{metric}.score") is not None]
            if len(values) != len(slots):
                raise ValueError("Remote scores missing")
            scores[metric] = {"passed": int(sum(values)), "total": len(values)}
        receipt["experiments"].append({"arm": arm, "id": experiment.id, "rows": len(rows), "readback": True, "scores": scores})
        receipt_path.write_text(json.dumps(receipt, indent=2))
    receipt["status"] = "submitted"
    receipt_path.write_text(json.dumps(receipt, indent=2))
    return receipt


if __name__ == "__main__":
    try:
        with contextlib.redirect_stdout(sys.stderr):
            result = publish(sys.argv[1])
        print(json.dumps(result))
    except Exception as error:
        detail = str(getattr(error, "body", None) or error)
        for key in ("ARIZE_API_KEY", "ARIZE_SPACE_ID"):
            secret = os.environ.get(key)
            if secret:
                detail = detail.replace(secret, "[redacted]")
        Path(sys.argv[1]).with_name("arize-diagnostic.json").write_text(json.dumps({"errorType": type(error).__name__, "detail": detail[:4000]}))
        print(json.dumps({"status": "missing", "errorType": type(error).__name__}))
        sys.exit(1)
