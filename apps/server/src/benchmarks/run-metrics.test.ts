import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { BUFFER_PROMPT, type AgentInvocation, type Candidate, type EvolutionEvent, type EvolutionRun } from "@antibody/shared/evolution";
import { freezeContract } from "../engine/contract.js";
import { parseRunEvidence, summarizeRun } from "./run-metrics.js";

const call = (role: "blue" | "red", startedAt: number): AgentInvocation => ({ role, startedAt, durationMs: 50, provider: "codex-cli", model: "pinned-test", inputTokens: 10, outputTokens: 20, attempts: 1 });
function candidate(id: string, parentId?: string): Candidate {
  const source = `owned fixture ${id}`;
  return { id, parentId, generation: parentId ? 1 : 0, label: id, variant: "generated", status: "verified", source,
    sourceHash: createHash("sha256").update(source).digest("hex"), lessons: [], backend: "verilator", cycles: 100, createdAt: 0, score: 100,
    agent: call("blue", id === "c1" ? 1 : 2), redAgent: call("red", id === "c1" ? 3 : 4), regressionCount: 0,
    attacks: [1, 2, 3, 4].map((n) => ({ id: `a${n}`, name: "Attack", hypothesis: "Unverified", sequence: [{ reset: true, write: false, read: false, data: 0 }] })),
    checks: ["order", "simultaneous", "full-replace", "empty-concurrent", "reset-active", "red-seeded", "held-out", "agent-red-a1", "agent-red-a2", "agent-red-a3", "agent-red-a4"].map((id) => ({ id, name: id, passed: true, hidden: id === "held-out", cycles: 1, summary: "observed" })),
  };
}
function run(): EvolutionRun {
  return { id: "test", prompt: BUFFER_PROMPT, contract: freezeContract(BUFFER_PROMPT, 0), provider: "daytona", strategy: "agents", status: "completed", createdAt: 0, finishedAt: 500,
    candidates: [], events: [], regressions: [], budget: { maxCandidates: 5, maxCycles: 10000, usedCandidates: 0, usedCycles: 0 } };
}
function event(seq: number, candidate: Candidate, ts: number): EvolutionEvent {
  return { seq, ts, runId: "test", type: "candidate.updated", candidateId: candidate.id, message: "test", payload: structuredClone(candidate) };
}

test("requalification is counted once per evaluation, while lesson-only updates and model calls are deduplicated", () => {
  const r = run();
  const first = candidate("c1");
  const second = { ...candidate("c1"), cycles: 200, redAgent: call("red", 5) };
  r.candidates = [second]; r.championId = "c1";
  r.events = [event(1, { ...first, status: "testing" }, 10), event(2, first, 20), event(3, { ...first, lessons: ["validated"] }, 21),
    event(4, { ...second, status: "testing" }, 30), event(5, second, 50)];
  const stats = summarizeRun(r);
  assert.equal(stats.coverage.completedHardwareEvaluationRecords, 2);
  assert.equal(stats.coverage.cyclesIncludingReplay, 200);
  assert.equal(stats.models.completedBlueRedInvocations, 3);
  assert.equal(stats.coverage.authoredRedSequences, 8);
  assert.deepEqual(stats.evaluations.map((e) => e.eventWindowMs), [10, 20]);
  assert.equal(stats.models.pricingDollars, null);
});

test("repair generations follow the champion's failing ancestry, not sibling count", () => {
  const r = run();
  const root = candidate("c1"); root.agent = undefined; root.checks[0]!.passed = false; root.status = "failed";
  const sibling = candidate("c2", "c1"), champion = candidate("c3", "c1");
  r.candidates = [root, sibling, champion]; r.championId = champion.id; r.verificationFixture = true;
  const stats = summarizeRun(r);
  assert.equal(stats.repair.verifiedModelWrittenChampion, true);
  assert.equal(stats.repair.repairEdges, 1);
  assert.equal(stats.repair.failingAncestorDirectedChecks, 1);
  assert.equal(stats.candidates.modelWritten, 2);
  assert.match(stats.provenance, /Imported/);
  champion.sourceHash = "different";
  assert.equal(summarizeRun(r).repair.verifiedModelWrittenChampion, false);
});

test("pending lessons and incomplete token usage cannot be reported as validated lessons or complete cost", () => {
  const r = run(); const c = candidate("c1"); delete c.agent!.inputTokens; delete c.redAgent!.attempts;
  r.candidates = [c];
  r.events = [
    { seq: 1, ts: 1, runId: "test", type: "lesson.learned", message: "", payload: { memoryId: "l1", status: "proposed" } },
    { seq: 2, ts: 2, runId: "test", type: "lesson.learned", message: "", payload: { memoryId: "l1", status: "validated" } },
    { seq: 3, ts: 3, runId: "test", type: "lesson.learned", message: "", payload: { memoryId: "l2", status: "proposed" } },
    { seq: 4, ts: 4, runId: "test", type: "lesson.learned", message: "", payload: { lesson: "legacy lesson without validation" } },
  ];
  const stats = summarizeRun(r);
  assert.equal(stats.coverage.validatedLessonsInJournal, 1);
  assert.equal(stats.coverage.proposedLessonsStillPending, 1);
  assert.equal(stats.models.callsWithBothTokenCounts, 1);
  assert.equal(stats.models.callsMissingAttemptCounts, 1);
  assert.equal(stats.coverage.completedHardwareEvaluationRecords, 0);
});

test("journal reconstruction is strict and read-only, including torn-tail and sequence rejection", () => {
  const initial = run(); initial.status = "queued"; delete initial.finishedAt;
  const c = candidate("c1");
  const events: EvolutionEvent[] = [
    { seq: 1, ts: 1, runId: "test", type: "run.created", message: "", payload: initial },
    { seq: 2, ts: 2, runId: "test", type: "candidate.created", candidateId: c.id, message: "", payload: c },
    { seq: 3, ts: 3, runId: "test", type: "champion.selected", candidateId: c.id, message: "" },
    { seq: 4, ts: 4, runId: "test", type: "run.completed", message: "" },
  ];
  const text = events.map((event) => JSON.stringify(event)).join("\n") + "\n";
  const before = structuredClone(events);
  const parsed = parseRunEvidence(text);
  assert.equal(parsed.candidates.length, 1);
  assert.equal(parsed.status, "completed");
  assert.equal(parsed.championId, c.id);
  assert.deepEqual(events, before);
  assert.throws(() => parseRunEvidence(text + '{"partial":'));
  assert.throws(() => parseRunEvidence(text.replace('"seq":2', '"seq":9')));
  assert.equal(parseRunEvidence(JSON.stringify(parsed)).id, "test");
});

test("sanitized preview exports with omitted event payloads do not invent complete history", () => {
  const r = run(); const c = candidate("c1"); r.candidates = [c]; r.championId = c.id;
  r.events = [{ seq: 1, ts: 1, runId: r.id, type: "candidate.updated", message: "public event without private payload" }];
  const stats = summarizeRun(parseRunEvidence(JSON.stringify(r)));
  assert.equal(stats.completeCandidateEventPayloads, false);
  assert.equal(stats.coverage.completedHardwareEvaluationRecords, 0);
  assert.equal(stats.models.completedBlueRedInvocations, 2);
  assert.equal(stats.repair.verifiedModelWrittenChampion, true);
});
