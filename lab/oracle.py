#!/usr/bin/env python3
"""Controller-owned FIFO oracle. Candidate sandboxes never receive this file.

Consumes {tests:[{id,name,hidden,sequence}],observations:[[{valid,data,full,empty,occupancy}]],seed}
on stdin and emits checks plus the first public counterexample on stdout.
The deque specification is independent of the RTL's pointers. No dependencies.
"""
import json
import sys
from collections import deque


def verify(payload):
    checks, first_failure = [], None
    tests, observations = payload["tests"], payload["observations"]
    if len(tests) != len(observations):
        raise ValueError("Observation test count differs from stimulus test count")
    for test, observed in zip(tests, observations):
        sequence = test["sequence"]
        if len(observed) != len(sequence):
            raise ValueError(f"Incomplete observations for {test['id']}")
        queue, trace, failure, last_output = deque(), [], None, 0
        for cycle, (stimulus, actual) in enumerate(zip(sequence, observed)):
            expected = None
            if stimulus["reset"]:
                queue.clear()
                last_output = 0
            else:
                accepted_read = stimulus["read"] and len(queue) > 0
                accepted_write = stimulus["write"] and (len(queue) < 32 or accepted_read)
                if accepted_read:
                    expected = queue.popleft()
                    last_output = expected
                if accepted_write:
                    queue.append(stimulus["data"] & 65535)
            actual_data = actual["data"] if actual["valid"] else None
            reasons = []
            if actual_data != expected:
                reasons.append(f"expected reading {expected}, observed {actual_data}")
            if actual["data"] != last_output:
                reasons.append(f"expected output register={last_output}, observed {actual['data']}")
            if actual["full"] != (len(queue) == 32):
                reasons.append(f"expected full={len(queue) == 32}, observed {actual['full']}")
            if actual["empty"] != (len(queue) == 0):
                reasons.append(f"expected empty={len(queue) == 0}, observed {actual['empty']}")
            if actual["occupancy"] != len(queue):
                reasons.append(f"expected occupancy={len(queue)}, observed {actual['occupancy']}")
            trace.append({**stimulus, "cycle": cycle, "expected": expected,
                          "actual": actual_data, "occupancy": len(queue),
                          "actualOccupancy": actual["occupancy"],
                          "full": actual["full"], "empty": actual["empty"],
                          "mismatch": bool(reasons)})
            if reasons and failure is None:
                failure = {"id": f"{test['id']}-cycle-{cycle}", "testId": test["id"],
                           "testName": test["name"], "seed": payload["seed"], "cycle": cycle,
                           "expected": expected, "actual": actual_data,
                           "summary": f"Cycle {cycle}: " + "; ".join(reasons),
                           "sequence": sequence[:cycle + 1], "trace": trace[-20:],
                           "reproduced": False}
        summary = ("All contract observations matched." if failure is None else
                   "Held-out contract check failed." if test["hidden"] else failure["summary"])
        checks.append({"id": test["id"], "name": test["name"], "passed": failure is None,
                       "cycles": len(sequence), "hidden": test["hidden"], "summary": summary})
        if failure and not test["hidden"] and first_failure is None:
            first_failure = failure
    return {"checks": checks, "failure": first_failure,
            "cycles": sum(len(t["sequence"]) for t in tests)}


if __name__ == "__main__":
    try:
        print(json.dumps(verify(json.load(sys.stdin)), separators=(",", ":")))
    except (ValueError, KeyError, TypeError) as error:
        print(f"Oracle rejected malformed simulation evidence: {error}", file=sys.stderr)
        sys.exit(2)
