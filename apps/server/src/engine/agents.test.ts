import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BUFFER_PROMPT, type AgentInvocation, type EvaluationResult, type FailureEvidence } from "@hollow-purple/shared/evolution";
import { RunStore } from "../store.js";
import { EvolutionEngine, type AgentTeam, type EvaluationRequest } from "./index.js";

const invocation = (role: "blue" | "red"): AgentInvocation => ({ role, provider: "codex-cli", model: "test-only-fake", startedAt: 0, durationMs: 1 });
function team(onBlue?: (input: Parameters<AgentTeam["buildBlue"]>[0]) => void): AgentTeam {
  return {
    async buildBlue(input) { onBlue?.(input); return { label: `Generated ${input.candidateId}`, source: `// Test evaluator fixture ${input.candidateId}`, rationale: "Model interface test fixture, not hardware evidence.", agent: invocation("blue") }; },
    async searchRed() { return { attacks: Array.from({ length: 4 }, (_, i) => ({ id: `attack-${i}`, name: `Attack ${i}`, hypothesis: "A bounded test hypothesis.", sequence: [{ reset: true, write: false, read: false, data: i }] })), rationale: "Independent Red interface fixture.", agent: invocation("red") }; },
  };
}
function measured(input: EvaluationRequest, failure?: FailureEvidence): EvaluationResult {
  return { source: input.source!, sourceHash: createHash("sha256").update(input.source!).digest("hex"), backend: "verilator", cycles: 100, reproduced: Boolean(failure), failure,
    checks: [...["order", "simultaneous", "full-replace", "empty-concurrent", "reset-active", "red-seeded", ...input.regressions.map((_, i) => `regression-${i}`), ...input.attacks!.map((attack) => `agent-red-${attack.id}`)].map((id) => ({ id, name: id, passed: !failure, hidden: false, cycles: 1, summary: "Test-only evaluator evidence." })), { id: "held-out", name: "Hidden", hidden: true, passed: !failure, cycles: 1, summary: "Test-only held-out evidence." }] };
}
const violation = (n: number): FailureEvidence => ({ id: `f-${n}`, testId: "simultaneous", testName: "Concurrent operations", seed: n, cycle: 1, expected: n, actual: n + 1, summary: `Wrong reading ${n + 1}.`, reproduced: true, trace: [], sequence: [{ reset: true, write: false, read: false, data: 0 }, { reset: false, write: true, read: true, data: n }] });
async function fixture() { const dir = await mkdtemp(join(tmpdir(), "live-agents-test-")); return { store: new RunStore(dir), dispose: () => rm(dir, { recursive: true, force: true }) }; }

test("live engine uses generated source, separate Red attacks, and repairs from real public evidence", async () => {
  const f = await fixture(); let blueCalls = 0; const parents: string[] = [];
  try {
    const agents = team((input) => { blueCalls++; if (input.parent) { parents.push(input.parent.id); assert.ok(input.failures.length); } });
    const engine = new EvolutionEngine(f.store, async (input) => {
      assert.equal(input.variant, "generated"); assert.equal(input.provider, "daytona"); assert.equal(input.attacks?.length, 4); assert.ok(input.source?.includes(input.candidateId));
      return measured(input, input.candidateId === "c5" ? undefined : violation(Number(input.candidateId.slice(1))));
    }, agents);
    const id = await engine.start({ prompt: BUFFER_PROMPT, provider: "daytona", maxCandidates: 5 }); const run = await engine.wait(id);
    assert.equal(run.status, "completed"); assert.equal(run.strategy, "agents"); assert.equal(run.championId, "c5"); assert.equal(blueCalls, 5);
    assert.equal(parents.length, 2); assert.equal(parents[0], parents[1]); assert.equal(run.regressions.length, 4);
    assert.ok(run.candidates.every((candidate) => candidate.agent && candidate.redAgent && candidate.sourceHash?.length === 64));
  } finally { await f.dispose(); }
});

test("generated source cannot graduate using a behavioral model or substituted RTL", async () => {
  for (const mode of ["model", "substituted"] as const) {
    const f = await fixture();
    try {
      const engine = new EvolutionEngine(f.store, async (input) => ({ ...measured(input), ...(mode === "model" ? { backend: "model" as const } : { source: "substituted source" }) }), team());
      const id = await engine.start({ prompt: BUFFER_PROMPT, provider: "daytona", maxCandidates: 3 }); const run = await engine.wait(id);
      assert.equal(run.status, "failed"); assert.equal(run.championId, undefined); assert.match(run.error!, /submitted RTL|Verilator/);
    } finally { await f.dispose(); }
  }
});

test("an early passing design must requalify against failures discovered later", async () => {
  const f = await fixture(); const counts = new Map<string, number>();
  try {
    const engine = new EvolutionEngine(f.store, async (input) => {
      counts.set(input.candidateId, (counts.get(input.candidateId) ?? 0) + 1);
      return measured(input, input.candidateId === "c2" ? violation(2) : input.candidateId === "c5" ? violation(5) : undefined);
    }, team());
    const id = await engine.start({ prompt: BUFFER_PROMPT, provider: "daytona", maxCandidates: 5 }); const run = await engine.wait(id);
    assert.equal(run.championId, "c1"); assert.equal(counts.get("c1"), 2); assert.equal(run.regressions.length, 2);
    const champion = run.candidates.find((candidate) => candidate.id === run.championId)!;
    assert.equal(champion.regressionCount, 2); assert.ok(champion.checks.some((check) => check.id === "regression-1" && check.passed));
  } finally { await f.dispose(); }
});

test("missing Red attack checks cannot qualify a model-generated candidate", async () => {
  const f = await fixture();
  try {
    const engine = new EvolutionEngine(f.store, async (input) => ({ ...measured(input), checks: measured(input).checks.filter((check) => !check.id.startsWith("agent-red-")) }), team());
    const id = await engine.start({ prompt: BUFFER_PROMPT, provider: "daytona", maxCandidates: 3 }); const run = await engine.wait(id);
    assert.equal(run.championId, undefined); assert.ok(run.candidates.every((candidate) => candidate.status === "rejected"));
  } finally { await f.dispose(); }
});

test("generated RTL cannot graduate with a missing or mismatched independent lab source hash", async () => {
  for (const sourceHash of [undefined, "0".repeat(64)]) {
    const f = await fixture();
    try {
      const engine = new EvolutionEngine(f.store, async (input) => ({ ...measured(input), sourceHash }), team());
      const id = await engine.start({ prompt: BUFFER_PROMPT, provider: "daytona", maxCandidates: 3 });
      const run = await engine.wait(id);
      assert.equal(run.status, "failed");
      assert.equal(run.championId, undefined);
      assert.match(run.error!, /Independent lab source hash.*exact submitted RTL/);
      assert.equal(run.candidates.length, 1);
      assert.equal(run.candidates.some((candidate) => candidate.status === "verified"), false);
      assert.equal(run.events.some((event) => event.type === "champion.selected"), false);
    } finally { await f.dispose(); }
  }
});
