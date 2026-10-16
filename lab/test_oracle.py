import unittest

from oracle import verify


RESET = {"reset": True, "write": False, "read": False, "data": 0}
WRITE = {"reset": False, "write": True, "read": False, "data": 18}
READ = {"reset": False, "write": False, "read": True, "data": 0}
IDLE = {"reset": False, "write": False, "read": False, "data": 0}


def observation(valid=False, data=0, count=0):
    return {"valid": valid, "data": data, "full": count == 32,
            "empty": count == 0, "occupancy": count}


def grade(sequence, observations, hidden=False):
    return verify({"seed": 7, "tests": [{"id": "contract", "name": "Contract",
                   "hidden": hidden, "sequence": sequence}], "observations": [observations]})


class OracleTests(unittest.TestCase):
    def test_fifo_read_and_output_hold(self):
        result = grade([RESET, WRITE, READ, IDLE], [observation(), observation(count=1),
                       observation(True, 18), observation(data=18)])
        self.assertTrue(result["checks"][0]["passed"])
        self.assertIsNone(result["failure"])

    def test_wrong_read_has_complete_replay_prefix(self):
        result = grade([RESET, WRITE, READ], [observation(), observation(count=1), observation(True, 19)])
        self.assertEqual(result["failure"]["expected"], 18)
        self.assertEqual(result["failure"]["actual"], 19)
        self.assertEqual(result["failure"]["sequence"], [RESET, WRITE, READ])
        self.assertTrue(result["failure"]["trace"][-1]["mismatch"])

    def test_reset_clears_queued_data_and_takes_priority(self):
        active_reset = {**RESET, "write": True, "read": True, "data": 88}
        result = grade([RESET, WRITE, active_reset, READ], [observation(), observation(count=1),
                       observation(), observation()])
        self.assertTrue(result["checks"][0]["passed"])

    def test_status_failure_is_detected_without_read(self):
        result = grade([RESET], [observation(count=1)])
        self.assertFalse(result["checks"][0]["passed"])
        self.assertIn("occupancy=0", result["failure"]["summary"])
        self.assertEqual(result["failure"]["trace"][-1]["occupancy"], 0)
        self.assertEqual(result["failure"]["trace"][-1]["actualOccupancy"], 1)

    def test_invalid_read_must_hold_output(self):
        result = grade([RESET, WRITE, READ, IDLE], [observation(), observation(count=1),
                       observation(True, 18), observation(data=19)])
        self.assertIn("output register=18", result["failure"]["summary"])

    def test_hidden_counterexamples_do_not_escape(self):
        result = grade([RESET], [observation(count=1)], hidden=True)
        self.assertFalse(result["checks"][0]["passed"])
        self.assertIsNone(result["failure"])
        self.assertEqual(result["checks"][0]["summary"], "Held-out contract check failed.")

    def test_incomplete_observations_cannot_pass(self):
        with self.assertRaises(ValueError):
            grade([RESET, WRITE], [observation()])


if __name__ == "__main__":
    unittest.main()
