import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BUFFER_PROMPT, type AgentInvocation, type EvaluationResult, type FailureEvidence } from "@hollow-purple/shared/evolution";
import { REPO_ROOT } from "../config.js";
import { RunStore } from "../store.js";
import { validateRtl } from "../lab/validation.js";
import { EvolutionEngine, type AgentTeam, type EvaluationRequest } from "./index.js";

const source = readFileSync(join(REPO_ROOT, "lab", "fixtures", "count-race.sv"), "utf8");
const invocation = (role: "blue" | "red"): AgentInvocation => ({ role, provider: "codex-cli", model: "test-only-fake", startedAt: 0, durationMs: 1 });
const failure: FailureEvidence = { id: "count-race", testId: "simultaneous", testName: "Concurrent operations", seed: 42, cycle: 2,
  expected: 18, actual: 19, summary: "Unit evaluator fixture: count changed on simultaneous accepted operations.", reproduced: true, trace: [],
  sequence: [{ reset: true, write: false, read: false, data: 0 }, { reset: false, write: true, read: false, data: 18 }, { reset: false, write: true, read: true, data: 19 }] };
function measured(input: EvaluationRequest, failed = false): EvaluationResult {
  return { source: input.source!, sourceHash: createHash("sha256").update(input.source!).digest("hex"), backend: "verilator", reproduced: failed, failure: failed ? failure : undefined, cycles: 100,
    checks: [...["order", "simultaneous", "full-replace", "empty-concurrent", "reset-active", "red-seeded", ...input.regressions.map((_, index) => `regression-${index}`), ...input.attacks!.map((attack) => `agent-red-${attack.id}`)].map((id) => ({ id, name: id, passed: !failed, hidden: false, cycles: 1, summary: "Unit-test-only injected evaluator result." })), { id: "held-out", name: "Hidden", passed: !failed, hidden: true, cycles: 1, summary: "Unit-test-only held-out result." }] };
}
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "repair-verification-"));
  return { store: new RunStore(dir), dispose: () => rm(dir, { recursive: true, force: true }) };
}
function team(onBlue: (input: Parameters<AgentTeam["buildBlue"]>[0]) => void, onRed: () => void): AgentTeam {
  return {
    async buildBlue(input) { onBlue(input); return { label: `Unit fake child ${input.candidateId}`, source: `${source}\n// Unit fake model output ${input.candidateId}\n`, rationale: "Unit-test adapter fixture; this is not live hardware evidence.", agent: invocation("blue") }; },
    async searchRed() { onRed(); return { rationale: "Unit-test adapter only.", agent: invocation("red"), attacks: Array.from({ length: 4 }, (_, index) => ({ id: `unit-${index}`, name: `Unit attack ${index}`, hypothesis: "Unit-test-only attack transport.", sequence: [{ reset: true, write: false, read: false, data: index }] })) }; },
  };
}

test("repair verification preserves imported provenance, defaults to three candidates, and creates only two model repair children", async () => {
  validateRtl(source);
  const f = await fixture(); let blueCalls = 0; let redCalls = 0; const branches: number[] = [];
  try {
    const agents = team((input) => {
      blueCalls++; branches.push(input.branch);
      assert.ok(input.parent?.id === "c1" && !input.parent.agent && input.parent.failure?.reproduced);
      assert.equal(input.generation, 1); assert.equal(input.failures.length, 1); assert.ok(input.lessons.length > 0);
    }, () => { redCalls++; });
    const engine = new EvolutionEngine(f.store, async (input) => {
      assert.equal(input.provider, "daytona"); assert.equal(input.variant, "generated"); assert.equal(input.attacks?.length, 4);
      return measured(input, input.candidateId === "c1");
    }, agents);
    const id = await engine.startRepairVerification({ source, label: "Imported manual count-race fixture", prompt: BUFFER_PROMPT });
    const run = await engine.wait(id);
    assert.equal(run.verificationFixture, true); assert.equal(run.budget.maxCandidates, 3); assert.equal(run.status, "completed");
    assert.equal(blueCalls, 2); assert.equal(redCalls, 3); assert.deepEqual(branches, [0, 1]); assert.equal(run.candidates.length, 3);
    assert.equal(run.candidates[0]!.agent, undefined); assert.match(run.candidates[0]!.rationale!, /NOT Blue-generated/); assert.equal(run.candidates[0]!.source, source);
    assert.ok(run.candidates.slice(1).every((candidate) => candidate.agent && candidate.redAgent && candidate.parentId === "c1" && candidate.sourceHash !== run.candidates[0]!.sourceHash));
    assert.ok(run.championId === "c2" || run.championId === "c3"); assert.match(run.summary!, /one imported.*2 model-written children/);
    assert.doesNotMatch(run.summary!, /3 model-written designs/);
  } finally { await f.dispose(); }
});

test("a fixture must independently fail before repair begins; no failure or template is substituted", async () => {
  const f = await fixture(); let blueCalls = 0;
  try {
    const engine = new EvolutionEngine(f.store, async (input) => measured(input), team(() => { blueCalls++; }, () => {}));
    const id = await engine.startRepairVerification({ source, label: "Imported fixture", prompt: BUFFER_PROMPT });
    const run = await engine.wait(id);
    assert.equal(run.status, "failed"); assert.equal(run.championId, undefined); assert.equal(blueCalls, 0); assert.equal(run.candidates.length, 1);
    assert.match(run.error!, /did not yield an independently reproduced failure/);
  } finally { await f.dispose(); }
});

test("verification source and exactly-three-candidate budget are checked before creating a run", async () => {
  const f = await fixture();
  try {
    const engine = new EvolutionEngine(f.store, async (input) => measured(input), team(() => {}, () => {}));
    await assert.rejects(engine.startRepairVerification({ source, label: "Fixture", prompt: BUFFER_PROMPT, maxCandidates: 5 as 3 }), /exactly one imported fixture and two/);
    await assert.rejects(engine.startRepairVerification({ source: "module invalid; endmodule", label: "Fixture", prompt: BUFFER_PROMPT }), /ANSI module fifo/);
    assert.equal(f.store.list().length, 0);
  } finally { await f.dispose(); }
});
