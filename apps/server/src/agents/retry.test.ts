import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AgentCallError, type AgentFailureCategory, type CodexCall } from "./codex.js";
import { runCodexWithRetry } from "./retry.js";

const answer = { answer: { source: "test-only" }, agent: { role: "red" as const, provider: "codex-cli" as const,
  model: "test-model", startedAt: 1, durationMs: 2 } };
const input = (artifactPath: string): CodexCall => ({ binary: "unused", role: "red", prompt: "UNCHANGED_PROMPT",
  schema: { type: "object" }, artifactPath, timeoutMs: 5000 });

test("one transient retry preserves inputs, separates artifacts, and shares the original time budget", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hp-agent-retry-"));
  const calls: CodexCall[] = [];
  try {
    const request = input(dir);
    const result = await runCodexWithRetry(request, async (call) => {
      calls.push(call);
      if (calls.length === 1) {
        await new Promise(resolve => setTimeout(resolve, 25));
        throw new AgentCallError("process_error", "PRIVATE_FAILURE_SENTINEL", "network");
      }
      return answer;
    });
    assert.equal(calls.length, 2);
    assert.equal(result.agent.attempts, 2);
    assert.equal(result.agent.model, "test-model");
    assert.equal(calls[0]!.artifactPath, join(dir, "attempt-1"));
    assert.equal(calls[1]!.artifactPath, join(dir, "attempt-2"));
    assert.ok(calls[1]!.timeoutMs < calls[0]!.timeoutMs);
    for (const call of calls) { assert.equal(call.prompt, request.prompt); assert.equal(call.schema, request.schema); assert.equal(call.model, request.model); }
    const metadata = await readFile(join(dir, "attempts.json"), "utf8");
    assert.doesNotMatch(metadata, /PRIVATE_FAILURE_SENTINEL|UNCHANGED_PROMPT/);
    assert.deepEqual(JSON.parse(metadata).map((entry: { status: string }) => entry.status), ["process_error", "responded"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("authentication, quota, schema, content-policy, response, and budget failures are not retried", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hp-agent-no-retry-"));
  const cases: AgentCallError[] = [
    ...(["authentication", "usage_limit", "invalid_schema", "content_policy"] as AgentFailureCategory[]).map(category => new AgentCallError("process_error", "stop", category)),
    ...(["timeout", "aborted", "output_limit", "invalid_response"] as const).map(reason => new AgentCallError(reason, "stop")),
  ];
  try {
    for (const error of cases) {
      let count = 0;
      await assert.rejects(runCodexWithRetry(input(dir), async () => { count++; throw error; }), error);
      assert.equal(count, 1);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("repeated transient failures stop after two attempts and abort cannot launch a second process", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hp-agent-bounded-"));
  try {
    let count = 0;
    await assert.rejects(runCodexWithRetry(input(dir), async () => { count++; throw new AgentCallError("process_error", "stop", "unknown"); }));
    assert.equal(count, 2);
    const controller = new AbortController();
    count = 0;
    await assert.rejects(runCodexWithRetry({ ...input(dir), signal: controller.signal }, async () => {
      count++; controller.abort(); throw new AgentCallError("process_error", "stop", "network");
    }), (error: unknown) => error instanceof AgentCallError && error.reason === "aborted");
    assert.equal(count, 1);
    count = 0;
    await assert.rejects(runCodexWithRetry({ ...input(dir), timeoutMs: 1 }, async () => {
      count++; await new Promise(resolve => setTimeout(resolve, 5)); throw new AgentCallError("process_error", "stop", "network");
    }), (error: unknown) => error instanceof AgentCallError && error.reason === "timeout");
    assert.ok(count <= 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
