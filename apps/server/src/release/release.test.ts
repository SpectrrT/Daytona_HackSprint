import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BUFFER_PROMPT, type EvaluationResult, type FailureEvidence } from "@hollow-purple/shared/evolution";
import { EvolutionEngine } from "../engine/index.js";
import { RunStore } from "../store.js";
import { decide, ReleaseError, requestApproval, voiceSession } from "./index.js";

const failure: FailureEvidence = {
  id: "regression-1", testId: "simultaneous", testName: "Simultaneous read and write", seed: 42, cycle: 2,
  expected: 18, actual: 19, summary: "Expected oldest reading 18; got 19.", reproduced: true,
  sequence: [{ reset: true, write: false, read: false, data: 0 }, { reset: false, write: true, read: false, data: 18 }], trace: [],
};
// Same shape as engine.test.ts: acceptance needs every directed, regression and held-out check to pass.
function result(pass: boolean, regressionCount = 0): EvaluationResult {
  const ids = ["order", "simultaneous", "full-replace", "empty-concurrent", "reset-active", "red-seeded", ...Array.from({ length: regressionCount }, (_, i) => `regression-${i}`)];
  return {
    source: "module fifo; endmodule // measured test fixture", backend: "model", reproduced: !pass, cycles: 100,
    checks: [
      ...ids.map((id) => ({ id, name: id, passed: pass, hidden: false, cycles: 10, summary: "Directed check evidence." })),
      { id: "held-out", name: "Held-out check", passed: pass, hidden: true, cycles: 50, summary: "Held-out check evidence." },
    ],
    failure: pass ? undefined : failure,
  };
}

async function completedRun() {
  const dir = await mkdtemp(join(tmpdir(), "release-gate-"));
  const store = new RunStore(dir);
  const engine = new EvolutionEngine(store, async (request) => result(request.variant === "repair-atomic", request.regressions.length));
  const id = await engine.start({ prompt: BUFFER_PROMPT, provider: "local", maxCandidates: 5 });
  const run = await engine.wait(id);
  assert.equal(run.status, "completed");
  assert.ok(run.championId, "fixture run needs a verified champion");
  return { dir, store, id, dispose: () => rm(dir, { recursive: true, force: true }) };
}

test("dashboard approval releases the champion with its hashes; nothing ships before the yes", async () => {
  const ctx = await completedRun();
  try {
    const requested = await requestApproval(ctx.store, ctx.id, "dashboard");
    assert.equal(requested.approval?.status, "requested");
    assert.equal(requested.release, undefined, "requesting approval must not release anything");

    const run = await decide(ctx.store, ctx.id, "approve", "dashboard", ctx.dir);
    assert.equal(run.approval?.status, "approved");
    assert.equal(run.release?.candidateId, run.championId);
    assert.equal(run.release?.contractHash, run.contract.hash);
    assert.equal(run.release?.regressions, run.regressions.length);
    const manifest = JSON.parse(await readFile(join(ctx.dir, run.release!.bundlePath, "manifest.json"), "utf8"));
    assert.equal(manifest.sourceHash, run.release!.sourceHash);
    const source = await readFile(join(ctx.dir, run.release!.bundlePath, `${run.championId}.sv`), "utf8");
    assert.match(source, /module fifo/);
    assert.deepEqual(run.events.slice(-3).map((e) => e.type), ["approval.requested", "approval.decided", "design.released"]);
  } finally { await ctx.dispose(); }
});

test("a decline releases nothing and cannot be re-requested", async () => {
  const ctx = await completedRun();
  try {
    await requestApproval(ctx.store, ctx.id, "dashboard");
    const run = await decide(ctx.store, ctx.id, "decline", "dashboard", ctx.dir);
    assert.equal(run.approval?.status, "declined");
    assert.equal(run.release, undefined);
    await assert.rejects(requestApproval(ctx.store, ctx.id, "dashboard"), ReleaseError);
  } finally { await ctx.dispose(); }
});

test("only the requested channel can decide, and an unfinished run cannot be released", async () => {
  const ctx = await completedRun();
  try {
    await assert.rejects(decide(ctx.store, ctx.id, "approve", "dashboard", ctx.dir), /No approval is pending/);
    await requestApproval(ctx.store, ctx.id, "dashboard");
    await assert.rejects(decide(ctx.store, ctx.id, "approve", "phone", ctx.dir), /must come from the dashboard/);
    assert.equal(ctx.store.get(ctx.id)!.release, undefined);
  } finally { await ctx.dispose(); }

  const dir = await mkdtemp(join(tmpdir(), "release-gate-"));
  try {
    const store = new RunStore(dir);
    const engine = new EvolutionEngine(store, async (request) => result(false, request.regressions.length));
    const id = await engine.start({ prompt: BUFFER_PROMPT, provider: "local", maxCandidates: 3 });
    const run = await engine.wait(id);
    assert.equal(run.championId, undefined);
    await assert.rejects(requestApproval(store, id, "dashboard"), /verified champion/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("the release gate survives a restart: approval and release are replayed from the event log", async () => {
  const ctx = await completedRun();
  try {
    await requestApproval(ctx.store, ctx.id, "dashboard");
    await decide(ctx.store, ctx.id, "approve", "dashboard", ctx.dir);
    const reloaded = new RunStore(ctx.dir);
    await reloaded.load();
    const run = reloaded.get(ctx.id)!;
    assert.equal(run.approval?.status, "approved");
    assert.equal(run.release?.candidateId, run.championId);
  } finally { await ctx.dispose(); }
});

test("voice approval needs a conversation ElevenLabs confirms was held with the release agent", async () => {
  const saved = { key: process.env.ELEVENLABS_API_KEY, agent: process.env.ELEVENLABS_AGENT_ID, fetch: globalThis.fetch };
  process.env.ELEVENLABS_API_KEY = "test-key";
  process.env.ELEVENLABS_AGENT_ID = "agent_release";
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/convai/conversation/get-signed-url")) return new Response(JSON.stringify({ signed_url: "wss://example/signed" }), { status: 200 });
    if (url.endsWith("/convai/conversations/conv_good")) return new Response(JSON.stringify({ agent_id: "agent_release" }), { status: 200 });
    if (url.endsWith("/convai/conversations/conv_other")) return new Response(JSON.stringify({ agent_id: "agent_someone_else" }), { status: 200 });
    return new Response("{}", { status: 500 });
  }) as typeof fetch;
  const ctx = await completedRun();
  try {
    await requestApproval(ctx.store, ctx.id, "voice");
    const session = await voiceSession(ctx.store, ctx.id);
    assert.equal(session.signedUrl, "wss://example/signed");
    assert.match(session.summary, /Approve releasing it\?/);
    await assert.rejects(decide(ctx.store, ctx.id, "approve", "voice", ctx.dir), /conversation id/);
    await assert.rejects(decide(ctx.store, ctx.id, "approve", "voice", ctx.dir, { conversationId: "conv_other" }), /not held with the release agent/);
    await assert.rejects(decide(ctx.store, ctx.id, "approve", "dashboard", ctx.dir), /must come from the voice/);
    assert.equal(ctx.store.get(ctx.id)!.release, undefined);
    const run = await decide(ctx.store, ctx.id, "approve", "voice", ctx.dir, { conversationId: "conv_good" });
    assert.equal(run.approval?.status, "approved");
    assert.equal(run.approval?.conversationId, "conv_good");
    assert.equal(run.release?.approvedVia, "voice");
  } finally {
    globalThis.fetch = saved.fetch;
    if (saved.key === undefined) delete process.env.ELEVENLABS_API_KEY; else process.env.ELEVENLABS_API_KEY = saved.key;
    if (saved.agent === undefined) delete process.env.ELEVENLABS_AGENT_ID; else process.env.ELEVENLABS_AGENT_ID = saved.agent;
    await ctx.dispose();
  }
});
