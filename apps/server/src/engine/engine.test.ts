import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BUFFER_PROMPT, type EvaluationResult, type FailureEvidence } from "@antibody/shared/evolution";
import { passesAcceptance } from "../arena/tools.js";
import { RunStore } from "../store.js";
import { EvolutionEngine } from "./index.js";
import { assertFrozenContract, freezeContract, supportsPrompt } from "./contract.js";

const failure: FailureEvidence = {
  id: "regression-1", testId: "simultaneous", testName: "Simultaneous read and write", seed: 42, cycle: 2,
  expected: 18, actual: 19, summary: "Expected oldest reading 18; got 19.", reproduced: true,
  sequence: [{ reset: true, write: false, read: false, data: 0 }, { reset: false, write: true, read: false, data: 18 }], trace: [],
};
function result(pass: boolean, regressionCount = 0): EvaluationResult {
  return { source: "// measured test fixture", backend: "model", reproduced: !pass, cycles: 100,
    checks: [...["order", "simultaneous", "full-replace", "empty-concurrent", "reset-active", "red-seeded", ...Array.from({ length: regressionCount }, (_, index) => `regression-${index}`)].map((id) => ({ id, name: id, passed: pass, hidden: false, cycles: 10, summary: "Directed check evidence." })), { id: "held-out", name: "Held-out check", passed: pass, hidden: true, cycles: 50, summary: "Held-out check evidence." }],
    failure: pass ? undefined : failure };
}
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "evolution-engine-"));
  return { dir, store: new RunStore(dir), dispose: () => rm(dir, { recursive: true, force: true }) };
}

test("contract is hashed, copies cannot rewrite it, unsupported numeric requirements are rejected", async () => {
  const contract = freezeContract(BUFFER_PROMPT, 0);
  assertFrozenContract(contract);
  const changed = structuredClone(contract); changed.depth = 16 as 32;
  assert.throws(() => assertFrozenContract(changed), /hash mismatch/);
  for (const prompt of ["Design a buffer for 8 sensor readings.", "Design a buffer for 64 readings.", "Design a 32-entry 8-bit FIFO buffer.", "Build a payment dashboard."]) assert.equal(supportsPrompt(prompt), false, prompt);
  const context = await fixture();
  try {
    await context.store.create({ id: "copy-test", prompt: BUFFER_PROMPT, provider: "local", status: "queued", contract,
      candidates: [], regressions: [], createdAt: 0, budget: { maxCandidates: 3, maxCycles: 1000, usedCandidates: 0, usedCycles: 0 } });
    const copy = context.store.get("copy-test")!; copy.contract.rules[0]!.description = "edited";
    assert.equal(context.store.get("copy-test")!.contract.rules[0]!.description, contract.rules[0]!.description);
  } finally { await context.dispose(); }
});

test("repairs branch from reproduced failure and inherit permanent regressions; all checks govern acceptance", async () => {
  const context = await fixture();
  const inherited: number[] = [];
  try {
    const engine = new EvolutionEngine(context.store, async (request) => {
      inherited.push(request.regressions.length);
      return result(request.variant === "repair-atomic", request.regressions.length);
    });
    const id = await engine.start({ prompt: BUFFER_PROMPT, provider: "local", maxCandidates: 5 });
    const run = await engine.wait(id);
    assert.equal(run.status, "completed"); assert.equal(run.candidates.length, 5);
    assert.equal(run.championId, "c5"); assert.equal(run.regressions.length, 1);
    assert.ok(inherited[3]! > 0 && inherited[4]! > 0);
    assert.equal(run.candidates[3]!.parentId, run.candidates[4]!.parentId);
    assert.equal(run.budget.usedCycles, 500);
    assertFrozenContract(run.contract);
  } finally { await context.dispose(); }
});

test("exhausted candidates and missing hidden checks never select a champion", async () => {
  const context = await fixture();
  try {
    const engine = new EvolutionEngine(context.store, async () => result(false));
    const id = await engine.start({ prompt: BUFFER_PROMPT, provider: "local", maxCandidates: 3 });
    const run = await engine.wait(id);
    assert.equal(run.status, "completed"); assert.equal(run.championId, undefined);
    assert.match(run.summary!, /budget exhausted/i); assert.equal(run.candidates.length, 3);
    const unqualified = new EvolutionEngine(context.store, async () => ({ ...result(true), checks: [{ id: "held-out", name: "Hidden-only partial response", passed: true, hidden: true, cycles: 100, summary: "Insufficient acceptance evidence." }] }));
    const second = await unqualified.start({ prompt: BUFFER_PROMPT, provider: "local", maxCandidates: 3 });
    assert.equal((await unqualified.wait(second)).championId, undefined);
  } finally { await context.dispose(); }
});

test("stop aborts in-flight work and preserves events without selecting a winner", async () => {
  const context = await fixture();
  let entered!: () => void;
  const evaluating = new Promise<void>((resolve) => { entered = resolve; });
  try {
    const engine = new EvolutionEngine(context.store, async ({ signal }) => {
      entered();
      await new Promise<void>((_resolve, reject) => signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
      return result(true);
    });
    const id = await engine.start({ prompt: BUFFER_PROMPT, provider: "local" });
    await evaluating; await engine.stop(id);
    const run = await engine.wait(id);
    assert.equal(run.status, "stopped"); assert.equal(run.championId, undefined);
    assert.ok(run.events.some((event) => event.type === "run.stopped"));
  } finally { await context.dispose(); }
});

test("JSONL reload reconstructs evidence, truncates a torn tail, and stops interrupted runs", async () => {
  const context = await fixture();
  try {
    await context.store.create({ id: "restart", prompt: BUFFER_PROMPT, provider: "local", status: "queued", contract: freezeContract(BUFFER_PROMPT),
      candidates: [], regressions: [], createdAt: 1, budget: { maxCandidates: 3, maxCycles: 1000, usedCandidates: 0, usedCycles: 0 } });
    await context.store.emit("restart", { type: "run.started", message: "started" });
    await appendFile(join(context.dir, "runs/restart.jsonl"), '{"seq":3,"broken"');
    const loaded = new RunStore(context.dir); await loaded.load();
    assert.equal(loaded.get("restart")!.status, "stopped");
    assert.deepEqual(loaded.events("restart").map((event) => event.seq), [1, 2, 3]);
    const lines = (await readFile(join(context.dir, "runs/restart.jsonl"), "utf8")).trim().split("\n");
    assert.equal(lines.length, 3); lines.forEach((line) => JSON.parse(line));
    const again = new RunStore(context.dir); await again.load();
    assert.equal(again.get("restart")!.events.length, 3);
  } finally { await context.dispose(); }
});

test("serialized terminal state wins a concurrent stop versus champion/completion race", async () => {
  const context = await fixture();
  try {
    await context.store.create({ id: "terminal-race", prompt: BUFFER_PROMPT, provider: "local", status: "queued", contract: freezeContract(BUFFER_PROMPT),
      candidates: [], regressions: [], createdAt: 1, budget: { maxCandidates: 3, maxCycles: 1000, usedCandidates: 0, usedCycles: 0 } });
    await context.store.emit("terminal-race", { type: "run.started", message: "started" });
    const writes = await Promise.allSettled([
      context.store.emit("terminal-race", { type: "run.stopped", message: "user stopped" }),
      context.store.emit("terminal-race", { type: "champion.selected", candidateId: "late", message: "late selection" }),
      context.store.emit("terminal-race", { type: "run.completed", message: "late completion" }),
    ]);
    assert.deepEqual(writes.map((write) => write.status), ["fulfilled", "rejected", "rejected"]);
    assert.equal(context.store.get("terminal-race")!.status, "stopped");
    assert.equal(context.store.get("terminal-race")!.championId, undefined);
    assert.equal(context.store.events("terminal-race").length, 3);
    const reloaded = new RunStore(context.dir); await reloaded.load();
    assert.equal(reloaded.get("terminal-race")!.status, "stopped");
  } finally { await context.dispose(); }
});


test("acceptance refuses omitted regressions, partial suites, duplicate IDs, and mislabeled hidden checks", () => {
  const complete = result(true, 2);
  assert.equal(passesAcceptance(complete, 2), true);
  assert.equal(passesAcceptance({ ...complete, checks: complete.checks.filter((check) => check.id !== "regression-1") }, 2), false);
  assert.equal(passesAcceptance({ ...complete, checks: complete.checks.filter((check) => check.hidden) }, 2), false);
  assert.equal(passesAcceptance({ ...complete, checks: [...complete.checks, complete.checks[0]!] }, 2), false);
  assert.equal(passesAcceptance({ ...complete, checks: complete.checks.map((check) => ({ ...check, hidden: false })) }, 2), false);
});
