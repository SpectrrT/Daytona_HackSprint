import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BUFFER_PROMPT, type Candidate, type EvaluationResult, type EvolutionRun, type FailureEvidence } from "@hollow-purple/shared/evolution";
import { freezeContract } from "../engine/contract.js";
import { EvolutionEngine, type AgentTeam, type EvaluationRequest } from "../engine/index.js";
import { RunStore } from "../store.js";
import { createApp } from "../index.js";
import { buildLessonPrompt, groundedLesson, lessonTransition } from "../agents/lessons.js";
import { LessonMemory, name, type Entity, type GraphBackend, type GraphEdge, type GraphNode, type LessonWriter } from "./graph.js";

export class TestGraph implements GraphBackend {
  nodes = new Map<string, GraphNode>(); edges = new Map<string, GraphEdge>();
  async check() {}
  async write(_run: string, nodes: GraphNode[], edges: GraphEdge[]) {
    for (const node of nodes) this.nodes.set(node.id, structuredClone(node));
    for (const edge of edges) this.edges.set(JSON.stringify(edge), structuredClone(edge));
  }
  async entity(id: string): Promise<Entity | undefined> {
    const node = this.nodes.get(id);
    return node ? { node: structuredClone(node), edges: [...this.edges.values()].filter((e) => e.source === id || e.target === id) } : undefined;
  }
}
const writer: LessonWriter = async () => ({ text: "Derive accepted operations from pre-edge occupancy, then update occupancy once for the accepted read/write pair.", agent: { role: "blue", provider: "codex-cli", model: "unit-test-only", durationMs: 1 } });
function run(): EvolutionRun { return { id: "memory-test", prompt: BUFFER_PROMPT, provider: "daytona", status: "running", contract: freezeContract(BUFFER_PROMPT), candidates: [], regressions: [], events: [], createdAt: 0, budget: { maxCandidates: 5, maxCycles: 10000, usedCandidates: 0, usedCycles: 0 } }; }
function candidate(id: string, parentId?: string): Candidate {
  const source = `// Graph unit test source ${id}`;
  return { id, parentId, generation: parentId ? 1 : 0, label: id, variant: "generated", status: "testing", source, sourceHash: createHash("sha256").update(source).digest("hex"), checks: [], score: 0, lessons: [], cycles: 0, createdAt: 0 };
}
const failure: FailureEvidence = { id: "public-failure", testId: "simultaneous", testName: "Concurrent count", seed: 42, cycle: 2, expected: 1, actual: 2, summary: "Unit fixture: a simultaneous read/write changed the count.", reproduced: true, trace: [], sequence: [{ reset: true, read: false, write: false, data: 0 }, { reset: false, read: true, write: true, data: 2 }] };
function result(c: Candidate, regressions = 1): EvaluationResult { return { source: c.source, sourceHash: c.sourceHash, backend: "verilator", cycles: 20, reproduced: false,
  checks: [...["order", "simultaneous", "full-replace", "empty-concurrent", "reset-active", "red-seeded", ...Array.from({ length: regressions }, (_, i) => `regression-${i}`), "agent-red-a"].map((id) => ({ id, name: id, passed: true, hidden: false, cycles: 1, summary: "Unit verifier adapter." })), { id: "held-out", name: "Hidden", passed: true, hidden: true, cycles: 1, summary: "Unit verifier adapter." }] }; }
test("a public Red attack about held output is not mistaken for the held-out check", async () => {
  const r = run(), c = candidate("c1"), memory = new LessonMemory(new TestGraph(), writer);
  const red = { ...failure, id: "red-failure", testId: "agent-red-singleton-stream-with-held-output" };
  r.regressions = [red];
  await memory.recordCandidate(r, c);
  assert.equal((await memory.recordBreach(r, c, red)).status, "proposed");
  for (const testId of ["held-out", "held_out-2", "hidden"]) await assert.rejects(memory.recordBreach(r, c, { ...red, testId }), /public failures/);
});

async function proposed() {
  const r = run(), parent = candidate("c1"), child = candidate("c2", "c1"), backend = new TestGraph();
  r.candidates = [parent, child];
  const memory = new LessonMemory(backend, writer); r.regressions = [structuredClone(failure)];
  await memory.recordCandidate(r, parent); await memory.recordCandidate(r, child);
  const lesson = await memory.recordBreach(r, parent, failure);
  return { r, parent, child, backend, memory, lesson };
}

test("a Blue lesson stays proposed until a source-bound descendant passes all gates", async () => {
  const f = await proposed();
  assert.equal(f.lesson.status, "proposed"); assert.equal(f.lesson.family, "occupancy");
  assert.deepEqual(await f.memory.retrieve(f.r, ["empty_boundary"]), []);
  const validated = await f.memory.validate(f.r, f.child, result(f.child), ["agent-red-a"]);
  assert.equal(validated.length, 1); assert.equal(validated[0]!.validatedBy, "c2");
  // A lesson learned on simultaneous operations transfers through a real parent
  // edge to the different, previously unseen full/empty boundary branches.
  for (const family of ["empty_boundary", "full_boundary"] as const) {
    const found = await f.memory.retrieve(f.r, [family]); assert.equal(found.length, 1); assert.equal(found[0]!.id, f.lesson.id);
  }
  assert.deepEqual(await f.memory.retrieve(f.r, ["reset_integrity"]), []);
  const link = [...f.backend.edges.entries()].find(([, e]) => e.relation === "child_of" && e.source === name(f.r.id, "family", "empty_boundary"))!;
  f.backend.edges.delete(link[0]);
  assert.deepEqual(await f.memory.retrieve(f.r, ["empty_boundary"]), []);
  f.backend.edges.set(link[0], link[1]);
  const graph = await f.memory.snapshot(f.r);
  assert.ok(graph.edges.some((e) => e.relation === "supported_by"));
  assert.ok(graph.edges.some((e) => e.relation === "validated_by"));
});

test("unrelated passing candidates, failed or partial suites, substituted source and behavioral models cannot validate a lesson", async () => {
  const f = await proposed(), sibling = candidate("sibling"); await f.memory.recordCandidate(f.r, sibling);
  assert.deepEqual(await f.memory.validate(f.r, sibling, result(sibling), ["agent-red-a"]), []);
  const good = result(f.child);
  const bad: EvaluationResult[] = [
    { ...good, backend: "model" }, { ...good, sourceHash: "0".repeat(64) }, { ...good, source: "substituted" },
    { ...good, checks: good.checks.filter((c) => c.id !== "regression-0") },
    { ...good, checks: good.checks.filter((c) => c.id !== "held-out") },
    { ...good, checks: good.checks.map((c) => c.id === "held-out" ? { ...c, passed: false } : c) },
    { ...good, checks: [...good.checks, good.checks[0]!] }, { ...good, failure },
  ];
  for (const item of bad) assert.deepEqual(await f.memory.validate(f.r, f.child, item, ["agent-red-a"]), []);
  assert.deepEqual(await f.memory.retrieve(f.r), []);
});

test("hidden, unjournaled, unreproduced and mismatched-source evidence never reaches the lesson writer", async () => {
  const r = run(), c = candidate("c1"), backend = new TestGraph(); let calls = 0;
  const memory = new LessonMemory(backend, async () => { calls++; return writer({ run: r, candidate: c, failure, family: "occupancy" }); });
  await memory.recordCandidate(r, c);
  for (const f of [{ ...failure, reproduced: false }, { ...failure, testId: "held-out" }, failure]) await assert.rejects(memory.recordBreach(r, c, f));
  r.regressions = [failure]; await assert.rejects(memory.recordBreach(r, { ...c, source: "changed" }, failure));
  assert.equal(calls, 0);
});

test("graph reads reject changed contracts, cross-run payloads, dangling references and mutated support evidence", async () => {
  const f = await proposed();
  const item = f.backend.nodes.get(f.lesson.id)!;
  f.backend.nodes.set(f.lesson.id, { ...item, runId: "different-run" });
  await assert.rejects(f.memory.retrieve(f.r), /boundary/);
  f.backend.nodes.set(f.lesson.id, item);
  const changed = structuredClone(f.r); changed.contract.prompt += " changed";
  await assert.rejects(f.memory.retrieve(changed), /hash mismatch/);
  f.r.regressions[0]!.summary = "changed after evidence was journaled";
  assert.deepEqual(await f.memory.validate(f.r, f.child, result(f.child), ["agent-red-a"]), []);
  f.backend.nodes.delete(f.lesson.id); await assert.rejects(f.memory.snapshot(f.r), /dangling/);
});

test("repeated breach recording is idempotent and a stopped writer commits no lesson", async () => {
  const f = await proposed(); const again = await f.memory.recordBreach(f.r, f.parent, failure);
  assert.equal(again.id, f.lesson.id);
  assert.equal([...f.backend.nodes.values()].filter((n) => n.kind === "lesson").length, 1);
  const abort = new AbortController(); const backend = new TestGraph();
  const memory = new LessonMemory(backend, async () => { abort.abort(); return writer({ run: f.r, candidate: f.parent, failure, family: "occupancy" }); });
  await memory.recordCandidate(f.r, f.parent);
  await assert.rejects(memory.recordBreach(f.r, f.parent, failure, abort.signal));
  assert.equal([...backend.nodes.values()].some((n) => n.kind === "lesson"), false);
});

test("lesson prompts contain only their bounded public failure, never another run's hidden results or source", () => {
  const r = run(); r.summary = "PRIVATE_HIDDEN_RESULT_SENTINEL"; r.events = [{ seq: 1, runId: r.id, type: "log", ts: 0, message: "PRIVATE_HIDDEN_RESULT_SENTINEL" }];
  const prompt = buildLessonPrompt({ run: r, candidate: candidate("c1"), failure, family: "occupancy" });
  assert.doesNotMatch(prompt, /PRIVATE_HIDDEN_RESULT_SENTINEL/); assert.match(prompt, /parentFamily.*occupancy/);
  assert.match(prompt, /Do not claim the lesson has been validated/);
  assert.match(prompt, /failedSource/);
});

test("lesson facts distinguish pre-edge occupancy from the post-edge oracle trace", () => {
  const sequence = [{ reset: true, read: false, write: false, data: 0 }, ...Array.from({ length: 8 }, (_, i) => ({ reset: false, read: false, write: true, data: i })), { reset: false, read: true, write: true, data: 99 }];
  const f = { ...failure, cycle: 9, sequence, trace: [{ ...sequence[9]!, cycle: 9, occupancy: 8, actualOccupancy: 7, expected: 0, actual: 0, full: false, empty: false, mismatch: true }] };
  assert.deepEqual(lessonTransition(f), { preEdgeOccupancy: 8, readAccepted: true, writeAccepted: true, expectedPostOccupancy: 8, observedPostOccupancy: 7 });
  const corrupted = structuredClone(f); corrupted.trace[0]!.occupancy = 9;
  assert.throws(() => lessonTransition(corrupted), /contradicts/);
  const empty = { ...failure, cycle: 1, trace: [], sequence: [sequence[0]!, sequence[9]!] };
  assert.deepEqual(lessonTransition(empty), { preEdgeOccupancy: 0, readAccepted: false, writeAccepted: true, expectedPostOccupancy: 1, observedPostOccupancy: null });
});

test("a passing child causes a fresh source-grounded lesson review before retrieval", async () => {
  const f = await proposed(); const calls: Parameters<LessonWriter>[0][] = [];
  const memory = new LessonMemory(f.backend, async input => { calls.push(input); return { ...await writer(input), text: "Reviewed actual repair: replace competing count assignments with one accepted-operation update." }; });
  const validated = await memory.validate(f.r, f.child, result(f.child), ["agent-red-a"]);
  assert.equal(calls.length, 1); assert.equal(calls[0]!.candidate.source, f.parent.source); assert.equal(calls[0]!.repair?.source, f.child.source);
  assert.equal(validated[0]!.validationMethod, "source-grounded-repair");
  assert.match((await memory.retrieve(f.r, ["empty_boundary"]))[0]!.text!, /Reviewed actual repair/);
});

test("a failed lesson review cannot promote an unreviewed explanation", async () => {
  const f = await proposed();
  const memory = new LessonMemory(f.backend, async () => { throw new Error("Review unavailable"); });
  await assert.rejects(memory.validate(f.r, f.child, result(f.child), ["agent-red-a"]), /Review unavailable/);
  assert.deepEqual(await memory.retrieve(f.r), []);
});

test("ancestry transfers the invariant while the repair recipe stays on its originating family", async () => {
  const f = await proposed();
  const recipe = "Source-specific repair: replace the two competing count assignments in this implementation.";
  const principle = "When concurrent operations are accepted, their combined state change must match the contract. Audit unrelated rules separately.";
  const memory = new LessonMemory(f.backend, async input => ({ ...await writer(input), text: recipe, transferText: principle }));
  await memory.validate(f.r, f.child, result(f.child), ["agent-red-a"]);
  assert.equal((await memory.retrieve(f.r, ["simultaneous"]))[0]!.text, recipe);
  assert.equal((await memory.retrieve(f.r, ["empty_boundary"]))[0]!.text, principle);
  assert.equal((await memory.retrieve(f.r, ["full_boundary"]))[0]!.text, principle);
  assert.equal((await memory.snapshot(f.r)).nodes.find(n => n.kind === "lesson")!.text, recipe);
});

test("grounded lessons keep actual repair excerpts and reject invented citations", () => {
  const parent = candidate("parent"), repair = candidate("repair", "parent");
  parent.source = "assign occupancy = wrong_count;";
  repair.source = "assign occupancy = corrected_count;";
  const input = { run: run(), candidate: parent, failure, family: "occupancy" as const, repair };
  const answer = { text: "Expose the state register used to calculate accepted operations through the occupancy port.", transferText: "Status outputs must reflect the actual committed state; review every contract rule independently.", sourceLines: [1], repairLines: [1] };
  assert.match(groundedLesson(input, answer), /Passing descendant excerpt:\nassign occupancy = corrected_count;/);
  assert.throws(() => groundedLesson(input, { ...answer, sourceLines: [999] }), /citations/);
  assert.throws(() => groundedLesson(input, { ...answer, repairLines: [] }), /citations/);
  repair.source = "case ({take_write, take_read})\n2'b11: count <= count;\n2'b10: count <= count + 1;\n2'b01: count <= count - 1;\nendcase";
  assert.match(groundedLesson(input, { ...answer, repairLines: [1, 5] }), /2'b11: count <= count;/);
  repair.source = "// no executable statement\n// still a comment";
  assert.throws(() => groundedLesson(input, { ...answer, repairLines: [1, 2] }), /executable/);
});

test("engine gives Blue and Red only validated graph lessons, and a sibling cannot validate a proposal", async () => {
  // Integration orchestration test with explicit fake agents and evaluator.
  // Live graph and actual model transport are checked separately.
  const dir = await mkdtemp(join(tmpdir(), "graph-engine-")); const backend = new TestGraph();
  const memory = new LessonMemory(backend, writer); const seen: Record<string, string[]> = {};
  const agents: AgentTeam = {
    async buildBlue(input) { seen[input.candidateId] = input.lessons; const c = candidate(input.candidateId, input.parent?.id); return { label: c.label, source: c.source, rationale: "Graph integration test fixture.", agent: { role: "blue", provider: "codex-cli", model: "unit-test-only", startedAt: 0, durationMs: 1 } }; },
    async searchRed(input) { seen[`red-${input.candidateId}`] = input.lessons ?? []; return { attacks: ["a", "b", "c", "d"].map((id) => ({ id, name: id, hypothesis: "Unit test only.", sequence: [{ reset: true, write: false, read: false, data: 0 }] })), rationale: "Unit test only.", agent: { role: "red", provider: "codex-cli", model: "unit-test-only", startedAt: 0, durationMs: 1 } }; },
  };
  const evaluate = async (input: EvaluationRequest) => {
    const c = candidate(input.candidateId); c.source = input.source!; c.sourceHash = createHash("sha256").update(c.source).digest("hex");
    const measured = result(c, input.regressions.length);
    measured.checks.push(...["b", "c", "d"].map((id) => ({ id: `agent-red-${id}`, name: id, passed: true, hidden: false, cycles: 1, summary: "Unit test only." })));
    if (input.candidateId === "c1") return { ...measured, reproduced: true, failure, checks: measured.checks.map((c) => c.id === "simultaneous" ? { ...c, passed: false } : c) };
    return measured;
  };
  try {
    const store = new RunStore(dir), engine = new EvolutionEngine(store, evaluate, agents, memory);
    const id = await engine.start({ prompt: BUFFER_PROMPT, provider: "daytona", maxCandidates: 5 }); const finished = await engine.wait(id);
    assert.equal(finished.status, "completed", finished.error); assert.ok(finished.championId);
    assert.deepEqual(seen.c4, []); assert.deepEqual(seen.c2, []);
    assert.equal(seen.c5?.length, 1); assert.equal(seen["red-c5"]?.length, 1);
    const graph = await memory.snapshot(finished), lesson = graph.nodes.find((n) => n.kind === "lesson")!;
    assert.equal(lesson.status, "validated"); assert.equal(lesson.validatedBy, "c4");
    assert.ok(finished.events.some((e) => e.type === "lesson.learned" && (e.payload as { status?: string })?.status === "proposed"));
    const app = createApp(store, engine);
    assert.deepEqual(await (await app.request("/api/memory/status")).json(), { configured: true, connected: true });
    const response = await app.request(`/api/runs/${id}/memory`);
    assert.equal(response.status, 200);
    const body = await response.json() as { configured: boolean; nodes: GraphNode[]; edges: GraphEdge[] };
    assert.equal(body.configured, true); assert.ok(body.nodes.some((n) => n.status === "validated"));
    assert.ok(body.edges.some((e) => e.relation === "validated_by"));
    assert.equal((await app.request("/api/runs/unknown/memory")).status, 404);
    const disabled = createApp(store, new EvolutionEngine(store));
    assert.deepEqual(await (await disabled.request("/api/memory/status")).json(), { configured: false, connected: false });
    assert.deepEqual(await (await disabled.request(`/api/runs/${id}/memory`)).json(), { configured: false, nodes: [], edges: [] });
  } finally { await rm(dir, { recursive: true, force: true }); }
});


test("repeated counterexamples retain each source's lesson while sharing the canonical regression", async () => {
  const f = await proposed(), other = candidate("c3"), child = candidate("c4", "c3");
  f.r.candidates.push(other, child);
  await f.memory.recordCandidate(f.r, other); await f.memory.recordCandidate(f.r, child);
  const repeat = { ...failure, id: "c3-repeat" };
  await assert.rejects(f.memory.recordBreach(f.r, other, repeat), /journal/);
  f.r.events.push({ runId: f.r.id, seq: 1, ts: 0, type: "failure.reproduced", candidateId: other.id, message: repeat.summary, payload: repeat });
  const lesson = await f.memory.recordBreach(f.r, other, repeat);
  assert.notEqual(lesson.id, f.lesson.id);
  const validated = await f.memory.validate(f.r, child, result(child), ["agent-red-a"]);
  assert.equal(validated.length, 1); assert.equal(validated[0]!.candidateId, "c3");
  assert.equal(f.r.regressions.length, 1);
});
