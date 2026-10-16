import assert from "node:assert/strict";
import { test } from "node:test";
import type { EvaluationResult } from "@antibody/shared/evolution";
import { benchmarkFixtures } from "./fixtures.js";
import { benchmarkCandidateId, boundedMap, pairedTiming, summarize, type Measurement } from "./metrics.js";
import { validateRtl, validateSequence } from "../lab/validation.js";

const report = (testId?: string): EvaluationResult => ({
  backend: "verilator", source: "fixture", sourceHash: "abc", cycles: 10, reproduced: !!testId,
  checks: [{ id: "order", name: "Order", passed: !testId, cycles: 10, hidden: false, summary: "test" }],
  failure: testId ? { id: "failure", testId, testName: "Test", seed: 1, cycle: 3, expected: 1, actual: 0, summary: "mismatch", sequence: [], trace: [], reproduced: true } : undefined,
});
const row = (id: string, result?: EvaluationResult): Measurement => ({ id, defective: id !== "control", wallMs: 20, result, attackIds: ["authored"] });

test("fixed tests cannot be credited as authored discoveries; unresolved cases stay in denominator", () => {
  const rows = [row("control", report()), row("hit", report("agent-red-authored")), row("fixed-only", report("order")), row("unavailable")];
  const stats = summarize(rows, 3, 1);
  assert.equal(stats.plannedMutants, 3);
  assert.equal(stats.witnessedMutants, 1);
  assert.equal(stats.mutantsFailingFixedPublicChecks, 2);
  assert.equal(stats.authoredDiscoveriesBeyondFixedPublicChecks, 0);
  assert.equal(stats.mutantsMissedByAuthoredSequences, 1);
  assert.equal(stats.infrastructureErrors, 1);
  assert.equal(stats.controlsPassed, 1);
  assert.equal(stats.controlClaimAvailable, true);
});

test("build errors, unreproduced failures and behavioral models are not hardware catches", () => {
  const build = { ...report(), buildError: "does not compile" };
  const unreproduced = { ...report("agent-red-authored"), reproduced: false };
  const model = { ...report("agent-red-authored"), backend: "model" as const };
  assert.equal(summarize([row("build", build), row("replay", unreproduced), row("model", model)], 3, 0).witnessedMutants, 0);
  assert.equal(summarize([row("control")], 0, 1).controlClaimAvailable, false);
  assert.equal(summarize([row("control", report("order"))], 0, 1).controlClaimAvailable, false);
});

test("speedup is unavailable when paired sources, verdicts or completion differ", () => {
  const serial = [row("control", report())];
  assert.equal(pairedTiming(serial, serial, 100, 50).speedup, 2);
  assert.equal(pairedTiming(serial, [row("control")], 100, 1).speedup, null);
  assert.equal(pairedTiming(serial, [row("control", { ...report(), sourceHash: "other" })], 100, 1).speedup, null);
  assert.equal(pairedTiming(serial, [row("control", report("order"))], 100, 1).speedup, null);
});

test("bounded workers retain order and never exceed the requested concurrency", async () => {
  let active = 0, peak = 0;
  const result = await boundedMap([1, 2, 3, 4, 5], 2, async (n) => {
    active++; peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active--; return n * 2;
  });
  assert.deepEqual(result, [2, 4, 6, 8, 10]);
  assert.equal(peak, 2);
  await assert.rejects(boundedMap([1], 0, async (n) => n));
  await assert.rejects(boundedMap([1], 1, async () => { throw new Error("failure"); }));
});

test("frozen suite has ten unique single-location mutants and one control with valid witnesses", () => {
  const fixtures = benchmarkFixtures();
  assert.equal(fixtures.length, 11);
  assert.equal(fixtures.filter((f) => f.defect === null).length, 1);
  assert.equal(new Set(fixtures.map((f) => f.sourceHash)).size, 11);
  for (const fixture of fixtures) {
    validateRtl(fixture.source);
    for (const witness of fixture.witnesses) {
      validateSequence(witness.sequence, "Witness", 256);
      assert.equal(witness.sequence[0]!.reset, true);
    }
  }
});

test("concurrent case and paired-arm names remain unique after provisioning truncates IDs", () => {
  const names = ["calibration", "pair-0-first", "pair-0-second", "pair-1-first", "pair-1-second"].flatMap((batch) =>
    benchmarkFixtures().map((fixture) => benchmarkCandidateId(fixture.id, batch).slice(0, 18)));
  assert.equal(new Set(names).size, names.length);
});
