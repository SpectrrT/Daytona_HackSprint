import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { BUFFER_PROMPT, type Candidate, type EvaluationResult } from "@antibody/shared/evolution";
import { freezeContract } from "../engine/contract.js";
import { EvolutionEngine } from "../engine/index.js";
import { RunStore } from "../store.js";
import { startArizeTracing } from "./arize.js";

function result(pass: boolean, regressionCount = 0): EvaluationResult {
  const ids = ["order", "simultaneous", "full-replace", "empty-concurrent", "reset-active", "red-seeded", ...Array.from({ length: regressionCount }, (_, i) => `regression-${i}`)];
  return {
    source: "// measured test fixture", backend: "model", reproduced: !pass, cycles: 100,
    checks: [...ids.map((id) => ({ id, name: id, passed: pass, hidden: false, cycles: 10, summary: "" })), { id: "held-out", name: "Held-out", passed: pass, hidden: true, cycles: 50, summary: "" }],
    failure: pass ? undefined : {
      id: "regression-1", testId: "simultaneous", testName: "Simultaneous read and write", seed: 42, cycle: 2, expected: 18, actual: 19,
      summary: "Expected oldest reading 18; got 19.", reproduced: true, sequence: [{ reset: true, write: false, read: false, data: 0 }], trace: [],
    },
  };
}

test("a run becomes one trace: run span, one span per candidate with the verifier's verdict", async () => {
  const dir = await mkdtemp(join(tmpdir(), "arize-"));
  const exporter = new InMemorySpanExporter();
  const store = new RunStore(dir);
  const telemetry = startArizeTracing(store, exporter)!;
  try {
    const engine = new EvolutionEngine(store, async (request) => result(request.variant === "repair-atomic", request.regressions.length));
    const id = await engine.start({ prompt: BUFFER_PROMPT, provider: "local", maxCandidates: 5 });
    const run = await engine.wait(id);
    await telemetry.flush();
    const spans = exporter.getFinishedSpans();
    const root = spans.find((s) => s.name === `run ${id}`)!;
    assert.ok(root, "run span exported");
    assert.equal(root.attributes["run.status"], "completed");
    const candidates = spans.filter((s) => s.name.startsWith("candidate "));
    assert.equal(candidates.length, run.candidates.length);
    for (const span of candidates) assert.equal(span.parentSpanContext?.spanId, root.spanContext().spanId);
    const champion = candidates.find((s) => s.attributes["candidate.id"] === run.championId)!;
    assert.equal(champion.attributes["candidate.status"], "verified");
    assert.equal(champion.attributes["verifier.checks_passed"], champion.attributes["verifier.checks_total"]);
  } finally { await telemetry.shutdown(); await rm(dir, { recursive: true, force: true }); }
});

test("Blue and Red model calls become LLM spans under their candidate, once each", async () => {
  const dir = await mkdtemp(join(tmpdir(), "arize-"));
  const exporter = new InMemorySpanExporter();
  const store = new RunStore(dir);
  const telemetry = startArizeTracing(store, exporter)!;
  try {
    await store.create({ id: "agents", prompt: BUFFER_PROMPT, provider: "daytona", status: "queued", contract: freezeContract(BUFFER_PROMPT, 0),
      candidates: [], regressions: [], createdAt: 0, budget: { maxCandidates: 3, maxCycles: 1000, usedCandidates: 0, usedCycles: 0 }, strategy: "agents" });
    const now = Date.now();
    const base: Candidate = { id: "c1", generation: 0, label: "Blue one", variant: "generated", status: "building", source: "module fifo; endmodule", checks: [], score: 0, lessons: [], cycles: 0, createdAt: now };
    const blue = { role: "blue" as const, provider: "codex-cli" as const, model: "gpt-test", startedAt: now, durationMs: 1200, inputTokens: 900, outputTokens: 400 };
    await store.emit("agents", { type: "candidate.created", candidateId: "c1", message: "created", payload: base });
    await store.emit("agents", { type: "candidate.updated", candidateId: "c1", message: "blue returned", payload: { ...base, status: "testing", agent: blue, rationale: "pointer-based ring buffer" } });
    await store.emit("agents", { type: "candidate.updated", candidateId: "c1", message: "verified", payload: { ...base, status: "verified", agent: blue, score: 100, checks: [{ id: "order", name: "order", passed: true, hidden: false, cycles: 10, summary: "" }] } });
    await telemetry.flush();
    const llm = exporter.getFinishedSpans().filter((s) => s.attributes["openinference.span.kind"] === "LLM");
    assert.equal(llm.length, 1, "the Blue call is traced once even though it appears in two updates");
    assert.equal(llm[0]!.attributes["llm.model_name"], "gpt-test");
    assert.equal(llm[0]!.attributes["llm.token_count.prompt"], 900);
    const candidate = exporter.getFinishedSpans().find((s) => s.name === "candidate Blue one")!;
    assert.equal(llm[0]!.parentSpanContext?.spanId, candidate.spanContext().spanId);
  } finally { await telemetry.shutdown(); await rm(dir, { recursive: true, force: true }); }
});
