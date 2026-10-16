"""Contract tests for the pinned Arize SDK. No remote calls or model requests."""
import json
import unittest
from arize._generated.api_client import ExperimentRunInput, InsertExperimentRunsRequest
from arize.experiments.evaluators.types import EvaluationResult
from ablation_experiments import held_out, first_try_transfer, all_gates


class MetricsContractTests(unittest.TestCase):
    def test_append_keeps_scored_metrics_in_generated_dto(self):
        row = {"output": "unit-only", "eval.heldout_pass_rate.score": 1.0, "row_key": "unit", "row_sha256": "unit"}
        request = InsertExperimentRunsRequest(experiment_runs=[ExperimentRunInput.from_dict(row)])
        actual = request.to_dict()["experiment_runs"][0]
        self.assertEqual(actual, {"example_id": None, **row})

    def test_evaluators_return_real_numeric_scores_and_preserve_missing(self):
        output = {"evaluations": [{"status": "evaluated", "generation": 0, "checks": [{"id": "held-out", "hidden": True, "passed": True}, {"id": "transfer-empty-boundary", "hidden": True, "passed": False}]}]}
        self.assertEqual(EvaluationResult(**held_out(output)).score, 1.0)
        self.assertEqual(EvaluationResult(**first_try_transfer(output)).score, 0.0)
        self.assertEqual(EvaluationResult(**all_gates(output)).score, 0.0)
        self.assertIsNone(EvaluationResult(**held_out({"evaluations": []})).score)

    def test_hidden_marker_is_required_for_heldout_credit(self):
        output = {"evaluations": [{"status": "evaluated", "checks": [{"id": "held-out", "hidden": False, "passed": True}]}]}
        self.assertNotIn("score", held_out(output))


if __name__ == "__main__":
    unittest.main()
