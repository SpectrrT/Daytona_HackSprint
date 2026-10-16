import { test } from "node:test";
import assert from "node:assert/strict";
import type { BrowserTrial, SoftwareCheck, SoftwareRun } from "@hollow-purple/shared/software";
import { checkOutcome, softwareProgress } from "@hollow-purple/shared/software-progress";
import { freezeSoftwareContract } from "./contract.js";

const check = (id: string, passed: boolean, recordedAt?: number): SoftwareCheck => ({ id, passed, summary: "Observed verdict", requests: 3, hidden: false, recordedAt });
function fixture(): SoftwareRun {
  const trial: BrowserTrial = {
    attack: { id: "retry", name: "Retry the original purchase", hypothesis: "A retry must return the original receipt.", actions: [{ kind: "click", target: "checkout" }, { kind: "click", target: "checkout" }] },
    batches: [], ledger: { stock: 0, orders: [], sourceHash: "baseline", runtimeHash: "runtime" }, check: check("retry", false), screenshotPath: "evidence.png",
  };
  return { id: "measured", status: "completed", createdAt: 1000, finishedAt: 5000, contract: freezeSoftwareContract(1000),
    candidates: [
      { id: "c1", label: "Manual fixture", source: "", sourceHash: "baseline", importedFixture: true, attacks: [], checks: [check("red-retry", false, 2000)], status: "rejected", evaluatedAt: 2100 },
      { id: "c2", parentId: "c1", label: "Repair", source: "", sourceHash: "repair", attacks: [], checks: [check("regression-c1-retry", true, 3000), check("purchase-and-price", true, 3200), { ...check("held-out-a", true, 3400), hidden: true }], status: "verified", evaluatedAt: 3500 },
      { id: "c3", parentId: "c1", label: "Other repair", source: "", sourceHash: "other", attacks: [], checks: [], status: "testing" },
    ], regressions: [{ id: "c1-retry", summary: "Receipt differed", reproduced: true, discovery: trial, replay: trial }], lessons: [], events: [],
    budget: { maxCandidates: 3, maxBrowserActions: 120, maxRequests: 300, usedBrowserActions: 5, usedRequests: 12 }, championId: "c2" };
}

test("compares the same regression, preserving unmeasured candidates and actual parents", () => {
  const progress = softwareProgress(fixture());
  assert.deepEqual(progress.candidates.map(point => point.remaining), [1, 0, null]);
  assert.deepEqual(progress.candidates.map(point => point.regressions[0]!.outcome), ["failed", "passed", "unmeasured"]);
  assert.deepEqual(progress.candidates.map(point => point.parentId), [undefined, "c1", "c1"]);
  assert.deepEqual(progress.candidates.map(point => [point.passed, point.total]), [[0, 1], [3, 3], [0, 0]]);
});
test("records cumulative execution counts at their actual times, keeping the historical failure", () => {
  assert.deepEqual(softwareProgress(fixture()).timeline, [
    { at: 1000, passed: 0, failed: 0, total: 0 }, { at: 2000, passed: 0, failed: 1, total: 1 },
    { at: 3000, passed: 1, failed: 1, total: 2 }, { at: 3200, passed: 2, failed: 1, total: 3 }, { at: 3400, passed: 3, failed: 1, total: 4 },
  ]);
  assert.equal(softwareProgress(fixture()).historicalTiming, false);
});
test("legacy results are grouped only at recorded verdicts, without fabricated check times", () => {
  const run = fixture();
  for (const candidate of run.candidates) { delete candidate.evaluatedAt; for (const check of candidate.checks) delete check.recordedAt; }
  run.candidates[2]!.checks.push(check("purchase-and-price", true));
  run.events.push({ at: 2200, candidateId: "c1", message: "Independent replay reproduced Receipt differed" },
    { at: 3600, candidateId: "c2", message: "Repair: verified; 3/3 checks passed." },
    { at: 4000, candidateId: "c3", message: "Red is testing this candidate." });
  const progress = softwareProgress(run);
  assert.deepEqual(progress.timeline, [{ at: 1000, passed: 0, failed: 0, total: 0 }, { at: 2200, passed: 0, failed: 1, total: 1 }, { at: 3600, passed: 3, failed: 1, total: 4 }]);
  assert.equal(progress.historicalTiming, true);
  assert.equal(progress.untimedResults, 1);
  assert.equal(progress.candidates[2]!.at, null);
});
test("later discoveries prevent an earlier passing candidate from displaying zero known failures", () => {
  const run = fixture();
  const failure = run.regressions[0]!;
  run.regressions.push({ ...failure, id: "c3-new", discovery: { ...failure.discovery, ledger: { ...failure.discovery.ledger, sourceHash: "other" } } });
  const progress = softwareProgress(run);
  assert.equal(progress.candidates[1]!.remaining, null);
  assert.deepEqual(progress.candidates[1]!.regressions.map(result => result.outcome), ["passed", "unmeasured"]);
});
test("a verification label and zero checks are insufficient evidence of a passing regression", () => {
  const run = fixture();
  run.candidates[2]!.status = "verified";
  assert.equal(softwareProgress(run).candidates[2]!.remaining, null);
  run.regressions = [];
  assert.ok(softwareProgress(run).candidates.every(candidate => candidate.remaining === null));
  assert.equal(checkOutcome([check("same", false), check("same", true)]), "failed");
});
test("invalid timestamps never create invented progress points", () => {
  const run = fixture();
  run.candidates[0]!.evaluatedAt = 6000;
  run.candidates[0]!.checks[0]!.recordedAt = 999;
  const progress = softwareProgress(run);
  assert.equal(progress.candidates[0]!.at, null);
  assert.equal(progress.untimedResults, 1);
  assert.ok(progress.timeline.every(point => point.at >= run.createdAt && point.at <= run.finishedAt!));
});
