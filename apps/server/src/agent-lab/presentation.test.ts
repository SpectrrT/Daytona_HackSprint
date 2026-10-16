import assert from "node:assert/strict";
import { test } from "node:test";
import type { LabRun } from "@antibody/shared/agent-lab";
import { demoVerdict, panelReceives } from "@antibody/shared/agent-lab-presentation";

const example = () => ({
  status: "completed", championId: "c2", failures: [{}, {}],
  candidates: [{ id: "c1", importedFixture: true, checks: [] }, { id: "c2", status: "verified", blueAgent: { model: "test-only" }, checks: [
    { id: "regression-a", kind: "browser", passed: true, hidden: false },
    { id: "adapted-b", kind: "browser", passed: true, hidden: false },
    { id: "directed-c", kind: "tool-gate", passed: true, hidden: false },
    { id: "hidden-d", kind: "tool-gate", passed: true, hidden: true },
    { id: "useful-e", kind: "utility", passed: true, hidden: false },
  ] }],
} as unknown as LabRun);

test("success requires a completed model repair with actual passing checks", () => {
  const run = example();
  assert.equal(demoVerdict(run).status, "success");
  assert.deepEqual(demoVerdict(run).checks, { passed: 5, total: 5 });
  assert.deepEqual(demoVerdict(run).useful, { passed: 1, total: 1 });
  for (const status of ["running", "stopped", "failed"] as const) {
    run.status = status;
    assert.notEqual(demoVerdict(run).status, "success");
  }
  run.status = "completed";
  run.candidates[1]!.checks[3]!.passed = false;
  assert.equal(demoVerdict(run).status, "inconsistent");
  run.candidates[1]!.checks = [];
  assert.notEqual(demoVerdict(run).status, "success");
  run.championId = "c1";
  assert.notEqual(demoVerdict(run).status, "success");
});

test("panels separate role work while sharing real sandbox lifecycle events", () => {
  assert.equal(panelReceives("blue", "Blue is writing a repair."), true);
  assert.equal(panelReceives("red", "Blue is writing a repair."), false);
  assert.equal(panelReceives("red", "Anchor is testing engineering: forged approval"), true);
  assert.equal(panelReceives("verifier", "Replaying inherited engineering regression."), true);
  for (const role of ["blue", "red", "verifier"] as const) assert.equal(panelReceives(role, "Daytona: sandbox actual-id is started."), true);
});
