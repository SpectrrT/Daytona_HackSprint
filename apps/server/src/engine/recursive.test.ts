import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BUFFER_PROMPT, type AgentInvocation, type EvaluationResult, type FailureEvidence } from "@antibody/shared/evolution";
import { REPO_ROOT } from "../config.js";
import { RunStore } from "../store.js";
import { EvolutionEngine, type AgentTeam, type EvaluationRequest } from "./index.js";

const source = readFileSync(join(REPO_ROOT, "lab/fixtures/count-race.sv"), "utf8");
const call = (role: "blue" | "red"): AgentInvocation => ({ role, provider: "codex-cli", model: "unit-fake", startedAt: 0, durationMs: 1 });
const failure = (n: number): FailureEvidence => ({ id: `f-${n}`, testId: "simultaneous", testName: "Unit test violation", seed: n, cycle: 1, expected: n, actual: n + 1, reproduced: true, summary: "Injected unit-evaluator violation, not live hardware evidence.", trace: [],
  sequence: [{ reset: true, write: false, read: false, data: 0 }, { reset: false, write: true, read: true, data: n }] });
function measured(input: EvaluationRequest, violated?: FailureEvidence): EvaluationResult {
  const ids = ["order", "simultaneous", "full-replace", "empty-concurrent", "reset-active", "red-seeded", ...input.regressions.map((_, n) => `regression-${n}`), ...input.attacks!.map((attack) => `agent-red-${attack.id}`)];
  return { backend: "verilator", source: input.source!, sourceHash: createHash("sha256").update(input.source!).digest("hex"), cycles: 100, failure: violated, reproduced: !!violated,
    checks: [...ids.map((id) => ({ id, name: id, passed: !violated, hidden: false, cycles: 1, summary: "Unit-only evaluator." })), { id: "held-out", name: "Hidden", passed: !violated, hidden: true, cycles: 1, summary: "Unit-only evaluator." }] };
}
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "recursive-test-"));
  return { store: new RunStore(dir), dispose: () => rm(dir, { recursive: true, force: true }) };
}
function team(parents: string[] = []): AgentTeam {
  return {
    async buildBlue(input) {
      parents.push(input.parent!.id);
      return { label: `Unit child ${input.candidateId}`, source: `${source}\n// Unit fake child ${input.candidateId}`, rationale: "Unit adapter only.", agent: call("blue") };
    },
    async searchRed(input) {
      if (input.round > 0) assert.ok((input.priorAttacks?.length ?? 0) >= 4);
      return { rationale: "Unit attacks only.", agent: call("red"), attacks: Array.from({ length: 4 }, (_, n) => ({ id: `round-${input.round}-${n}`, name: "Unit attack", hypothesis: "Unit-only hypothesis.", sequence: [{ reset: true, write: false, read: false, data: input.round * 10 + n }] })) };
    },
  };
}

test("a new attack breaking a passing design creates a deeper child and retains both regressions", async () => {
  const f = await fixture(); const parents: string[] = [], requests: EvaluationRequest[] = [];
  try {
    const engine = new EvolutionEngine(f.store, async (input) => {
      requests.push(input);
      return measured(input, input.candidateId === "c1-e0" ? failure(1) : input.candidateId === "c2-e2" ? failure(2) : undefined);
    }, team(parents));
    const id = await engine.startRecursiveDemo({ source, label: "Imported unit fixture", prompt: BUFFER_PROMPT, maxEvaluations: 6, challengePasses: 2 });
    const run = await engine.wait(id);
    assert.equal(run.status, "completed"); assert.equal(run.championId, "c3");
    assert.deepEqual(parents, ["c1", "c2"]);
    assert.deepEqual(run.candidates.map((candidate) => candidate.generation), [0, 1, 2]);
    assert.equal(run.regressions.length, 2); assert.equal(run.candidates[2]!.regressionCount, 2);
    assert.deepEqual(requests.map((input) => input.regressions.length), [0, 1, 1, 2, 2, 2]);
    assert.equal(new Set(requests.map((input) => input.candidateId)).size, 6);
    assert.equal(run.candidates[0]!.agent, undefined);
    assert.match(run.summary!, /6 Daytona evaluations/);
  } finally { await f.dispose(); }
});

test("a passing repair does not graduate until fresh audits pass, and audits do not create fake generations", async () => {
  const f = await fixture(); let count = 0;
  try {
    const engine = new EvolutionEngine(f.store, async (input) => measured(input, count++ === 0 ? failure(1) : undefined), team());
    const id = await engine.startRecursiveDemo({ source, label: "Imported unit fixture", prompt: BUFFER_PROMPT, maxEvaluations: 4, challengePasses: 2 });
    const run = await engine.wait(id);
    assert.equal(run.championId, "c2"); assert.equal(count, 4); assert.equal(run.candidates.length, 2);
    assert.equal(run.candidates[1]!.generation, 1); assert.equal(run.candidates[1]!.cycles, 300);
  } finally { await f.dispose(); }
});

test("budget exhaustion after a new breach produces no champion or replacement failure", async () => {
  const f = await fixture(); let count = 0;
  try {
    const engine = new EvolutionEngine(f.store, async (input) => measured(input, count++ === 1 ? undefined : failure(count)), team());
    const id = await engine.startRecursiveDemo({ source, label: "Imported unit fixture", prompt: BUFFER_PROMPT, maxEvaluations: 3, challengePasses: 1 });
    const run = await engine.wait(id);
    assert.equal(run.championId, undefined); assert.equal(run.candidates.length, 2); assert.equal(count, 3);
    assert.match(run.summary!, /budget or available public evidence exhausted/);
  } finally { await f.dispose(); }
});

test("a clean starter cannot be reported as repaired", async () => {
  const f = await fixture(); let blue = 0; const agents = team();
  try {
    const engine = new EvolutionEngine(f.store, async (input) => measured(input), { ...agents, async buildBlue(input) { blue++; return agents.buildBlue(input); } });
    const id = await engine.startRecursiveDemo({ source, label: "Imported unit fixture", prompt: BUFFER_PROMPT });
    const run = await engine.wait(id);
    assert.equal(run.status, "failed"); assert.equal(blue, 0); assert.equal(run.championId, undefined);
    assert.match(run.error!, /No repair or improvement will be fabricated/);
  } finally { await f.dispose(); }
});

test("invalid recursive budgets are rejected before any run or provider operation", async () => {
  const f = await fixture();
  try {
    const engine = new EvolutionEngine(f.store, async (input) => measured(input), team());
    await assert.rejects(engine.startRecursiveDemo({ source, label: "Fixture", prompt: BUFFER_PROMPT, maxEvaluations: 3, challengePasses: 2 }));
    assert.equal(f.store.list().length, 0);
  } finally { await f.dispose(); }
});

test("repeating an older audit sequence cannot earn fresh-audit credit", async () => {
  const f = await fixture(); let count = 0; const agents = team();
  try {
    const engine = new EvolutionEngine(f.store, async (input) => measured(input, count++ === 0 ? failure(1) : undefined), {
      ...agents, async searchRed(input) {
        const result = await agents.searchRed(input);
        if (input.round === 3) result.attacks = result.attacks.map((attack, n) => ({ ...attack, sequence: [{ reset: true, write: false, read: false, data: n }] }));
        return result;
      },
    });
    const id = await engine.startRecursiveDemo({ source, label: "Fixture", prompt: BUFFER_PROMPT, maxEvaluations: 4, challengePasses: 2 });
    const run = await engine.wait(id);
    assert.equal(run.status, "failed"); assert.equal(run.championId, undefined);
    assert.match(run.error!, /repeated a previous sequence/); assert.equal(count, 3);
  } finally { await f.dispose(); }
});

test("Stop during a fresh audit cancels the chain without selecting a champion", async () => {
  const f = await fixture(); let count = 0;
  let began!: () => void;
  const reachedAudit = new Promise<void>((resolve) => { began = resolve; });
  try {
    const engine = new EvolutionEngine(f.store, async (input) => {
      count++;
      if (count === 1) return measured(input, failure(1));
      if (count === 2) return measured(input);
      began();
      return new Promise<EvaluationResult>((_resolve, reject) => input.signal!.addEventListener("abort", () => reject(new Error("Unit cancellation")), { once: true }));
    }, team());
    const id = await engine.startRecursiveDemo({ source, label: "Fixture", prompt: BUFFER_PROMPT });
    await reachedAudit; await engine.stop(id);
    const run = await engine.wait(id);
    assert.equal(run.status, "stopped"); assert.equal(run.championId, undefined); assert.equal(count, 3);
    assert.equal(run.candidates.length, 2); assert.equal(run.regressions.length, 1);
  } finally { await f.dispose(); }
});
