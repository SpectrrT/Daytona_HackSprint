import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Candidate, FailureEvidence } from "@hollow-purple/shared/evolution";
import { BUFFER_PROMPT } from "@hollow-purple/shared/evolution";
import { freezeContract } from "../engine/contract.js";
import { codexChildEnv, AgentCallError, classifyCodexFailure, runCodexStructured } from "./codex.js";
import { buildBluePrompt, buildRedPrompt } from "./index.js";
import { parseBlueAnswer, parseRedAnswer, blueAnswerSchema, outputSchema } from "./schemas.js";

const source = "module fifo(); // test-only structured source returned by a fake CLI\nendmodule\n";
const blue = { label: "Independent RTL source", source, rationale: "This unit fixture verifies transport and schema validation, not hardware correctness." };
const attacks = Array.from({ length: 4 }, (_, index) => ({ id: `attack-${index}`, name: `Boundary ${index}`, hypothesis: "Explore an independent source-specific boundary transition.", sequence: [{ reset: true, write: false, read: false, data: 0 }, { reset: false, write: true, read: Boolean(index & 1), data: index }] }));
const red = { attacks, rationale: "Four distinct and bounded public input sequences." };
async function fixture(body: string) {
  const dir = await mkdtemp(join(tmpdir(), "evolution-agent-"));
  const binary = join(dir, "fake-codex");
  await writeFile(binary, `#!/usr/bin/env node\n${body}`, { mode: 0o700 });
  return { dir, binary, artifactPath: join(dir, "artifacts"), dispose: () => rm(dir, { recursive: true, force: true }) };
}

test("child environment includes CLI auth location but excludes every service and model API credential", () => {
  const environment = codexChildEnv({ HOME: "/safe/home", PATH: "/safe/bin", CODEX_HOME: "/safe/codex", TMPDIR: "/tmp", DAYTONA_API_KEY: "forbidden", ANCHOR_API_KEY: "forbidden", ANTHROPIC_API_KEY: "forbidden", OPENAI_API_KEY: "forbidden", CODEX_API_KEY: "forbidden", DATABASE_URL: "forbidden", NODE_OPTIONS: "forbidden" });
  assert.deepEqual(environment, { PATH: "/safe/bin", HOME: "/safe/home", CODEX_HOME: "/safe/codex", TMPDIR: "/tmp" });
});

test("structured schemas require generated Blue source and four unique bounded valid Red sequences", () => {
  assert.deepEqual(parseBlueAnswer(blue), blue);
  assert.throws(() => parseBlueAnswer({ ...blue, source: `${source}// Unicode \u03bb` }));
  assert.throws(() => parseBlueAnswer({ label: "Choose baseline", variant: "baseline", rationale: "Select a fixed implementation." }));
  assert.equal(parseRedAnswer(red).attacks.length, 4);
  assert.throws(() => parseRedAnswer({ ...red, attacks: attacks.map((attack) => ({ ...attack, id: "a".repeat(51) })) }));
  assert.throws(() => parseRedAnswer({ ...red, attacks: attacks.map((attack, index) => ({ ...attack, id: `agent-red-${index}` })) }));
  assert.throws(() => parseRedAnswer({ ...red, attacks: attacks.slice(0, 3) }));
  assert.throws(() => parseRedAnswer({ ...red, attacks: attacks.map((attack) => ({ ...attack, id: "same-id" })) }));
  assert.throws(() => parseRedAnswer({ ...red, attacks: attacks.map((attack) => ({ ...attack, sequence: attacks[0]!.sequence })) }));
  assert.throws(() => parseRedAnswer({ ...red, attacks: attacks.map((attack) => ({ ...attack, sequence: [{ reset: false, write: false, read: false, data: 0 }] })) }));
  assert.throws(() => parseRedAnswer({ ...red, attacks: attacks.map((attack) => ({ ...attack, sequence: Array.from({ length: 257 }, () => ({ reset: true, write: true, read: false, data: 0 })) })) }));
  assert.throws(() => parseRedAnswer({ ...red, attacks: attacks.map((attack) => ({ ...attack, sequence: [{ reset: true, write: "true", read: false, data: 65536 }] })) }));
  assert.equal(outputSchema(blueAnswerSchema).additionalProperties, false);
});

test("role prompts include public source and repair feedback while withholding hidden checks and hidden failures", () => {
  const contract = freezeContract(BUFFER_PROMPT);
  const failure: FailureEvidence = { id: "failure", testId: "public-reset", testName: "Reset check", summary: "PUBLIC_FAILURE", expected: 1, actual: 2, seed: 1, cycle: 1, reproduced: true, trace: [], sequence: [{ reset: true, write: false, read: false, data: 0 }] };
  const parent: Candidate = { id: "c1", label: "Parent", variant: "generated", source: "PUBLIC_SOURCE", generation: 0, score: 10, status: "failed", lessons: [], cycles: 1, createdAt: 1, buildError: "PUBLIC_COMPILER_FEEDBACK", checks: [{ id: "held-out", name: "Private", hidden: true, passed: false, cycles: 1, summary: "HIDDEN_CHECK_SENTINEL" }] };
  const hidden = { ...failure, testId: "held-out", summary: "HIDDEN_FAILURE_SENTINEL" };
  const bluePrompt = buildBluePrompt({ runId: "r", candidateId: "c2", contract, parent, failures: [failure, hidden], lessons: ["PUBLIC_LESSON"], branch: 0, generation: 1 });
  const redPrompt = buildRedPrompt({ runId: "r", candidateId: "c2", contract, candidate: parent, failures: [failure, hidden], round: 1, seed: 42 });
  for (const prompt of [bluePrompt, redPrompt]) { assert.match(prompt, /PUBLIC_SOURCE/); assert.match(prompt, /PUBLIC_FAILURE/); assert.doesNotMatch(prompt, /HIDDEN_(CHECK|FAILURE)_SENTINEL/); }
  assert.match(bluePrompt, /PUBLIC_COMPILER_FEEDBACK/); assert.match(bluePrompt, /PUBLIC_LESSON/);
  assert.match(bluePrompt, /Do not use tools/); assert.match(redPrompt, /exactly 4/);
});

test("Codex transport uses safe flags and stdin, captures sanitized usage/session only, and removes raw response", async () => {
  const context = await fixture(`
const fs = require('node:fs');
const args = process.argv.slice(2);
let prompt = ''; process.stdin.on('data', chunk => prompt += chunk); process.stdin.on('end', () => {
 const output = args[args.indexOf('--output-last-message') + 1];
 fs.writeFileSync(output, ${JSON.stringify(JSON.stringify(blue))});
 fs.writeFileSync('observed.json', JSON.stringify({ args, prompt, hasDaytona: !!process.env.DAYTONA_API_KEY, hasAnchor: !!process.env.ANCHOR_API_KEY, hasModelKey: !!process.env.ANTHROPIC_API_KEY }));
 console.log('null');
 console.log(JSON.stringify({ type: 'thread.started', thread_id: 'safe-session-123' }));
 console.log(JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', aggregated_output: 'RAW_TOOL_OUTPUT_SENTINEL' } }));
 console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 77, output_tokens: 33 }, unexpected: 'RAW_METADATA_SENTINEL' }));
 console.error('RAW_STDERR_SENTINEL');
});`);
  try {
    const result = await runCodexStructured({ binary: context.binary, artifactPath: context.artifactPath, role: "blue", prompt: "ROLE_PROMPT", schema: outputSchema(blueAnswerSchema), timeoutMs: 3000 });
    assert.deepEqual(result.answer, blue);
    assert.equal(result.agent.provider, "codex-cli"); assert.equal(result.agent.model, "codex-default");
    assert.equal(result.agent.inputTokens, 77); assert.equal(result.agent.outputTokens, 33); assert.equal(result.agent.sessionId, "safe-session-123");
    const observed = JSON.parse(await readFile(join(context.artifactPath, "observed.json"), "utf8"));
    assert.equal(observed.prompt, "ROLE_PROMPT"); assert.equal(observed.hasDaytona, false); assert.equal(observed.hasAnchor, false); assert.equal(observed.hasModelKey, false);
    const args: string[] = observed.args;
    assert.deepEqual(args.slice(0, 8), ["exec", "-s", "read-only", "--ephemeral", "--skip-git-repo-check", "--ignore-user-config", "-C", context.artifactPath]);
    assert.ok(args.includes("features.shell_tool=false") && args.includes("features.hooks=false") && args.includes('web_search="disabled"'));
    assert.ok(args.includes("--json") && args.includes("--output-schema")); assert.equal(args.at(-1), "-"); assert.equal(args.includes("--model"), false);
    assert.equal((await stat(context.artifactPath)).mode & 0o777, 0o700);
    const metadata = await readFile(join(context.artifactPath, "invocation.json"), "utf8");
    assert.doesNotMatch(metadata, /RAW_(TOOL_OUTPUT|METADATA|STDERR)_SENTINEL/);
    assert.equal((await stat(join(context.artifactPath, "invocation.json"))).mode & 0o777, 0o600);
    assert.equal((await readdir(context.artifactPath)).includes("response.raw.json"), false);
  } finally { await context.dispose(); }
});

test("Codex model override is passed only when explicitly configured", async () => {
  const context = await fixture(`const fs=require('node:fs'); const args=process.argv.slice(2); process.stdin.resume(); process.stdin.on('end',()=>{fs.writeFileSync(args[args.indexOf('--output-last-message')+1], '{}'); fs.writeFileSync('args.json', JSON.stringify(args));});`);
  try {
    await runCodexStructured({ binary: context.binary, artifactPath: context.artifactPath, role: "blue", prompt: "role", schema: {}, timeoutMs: 3000, model: "explicit-test-model" });
    const args: string[] = JSON.parse(await readFile(join(context.artifactPath, "args.json"), "utf8"));
    assert.equal(args[args.indexOf("--model") + 1], "explicit-test-model");
  } finally { await context.dispose(); }
});

test("Codex timeout kills a process group that ignores SIGTERM within a bounded grace period", async () => {
  const context = await fixture("process.on('SIGTERM', () => {}); process.stdin.resume(); setInterval(() => {}, 1000);");
  const started = Date.now();
  try {
    await assert.rejects(runCodexStructured({ binary: context.binary, artifactPath: context.artifactPath, role: "red", prompt: "role", schema: {}, timeoutMs: 1000 }), (error: unknown) => error instanceof AgentCallError && error.reason === "timeout");
    assert.ok(Date.now() - started >= 1900, "SIGTERM-ignoring child should require the SIGKILL grace period");
    assert.ok(Date.now() - started < 5000);
    assert.equal(JSON.parse(await readFile(join(context.artifactPath, "invocation.json"), "utf8")).status, "timeout");
  } finally { await context.dispose(); }
});

test("Codex abort, output budget, and invalid JSON fail explicitly without retaining raw logs or final payload", async () => {
  for (const mode of ["abort", "output", "invalid"] as const) {
    const body = mode === "abort" ? "process.stdin.resume(); setInterval(() => {}, 1000);"
      : mode === "output" ? "process.stdin.resume(); process.stdout.write('x'.repeat(3 * 1024 * 1024)); setInterval(()=>{},1000);"
      : "const fs=require('node:fs'); const args=process.argv.slice(2); process.stdin.resume(); process.stdin.on('end',()=>fs.writeFileSync(args[args.indexOf('--output-last-message')+1], 'RAW_INVALID_PAYLOAD_SENTINEL'));";
    const context = await fixture(body);
    const controller = new AbortController();
    const timer = mode === "abort" ? setTimeout(() => controller.abort(), 100) : undefined;
    try {
      await assert.rejects(runCodexStructured({ binary: context.binary, artifactPath: context.artifactPath, role: "red", prompt: "role", schema: {}, timeoutMs: 3000, signal: controller.signal }), (error: unknown) => error instanceof AgentCallError && error.reason === (mode === "abort" ? "aborted" : mode === "output" ? "output_limit" : "invalid_response"));
      assert.equal((await readdir(context.artifactPath)).includes("response.raw.json"), false);
      assert.doesNotMatch(await readFile(join(context.artifactPath, "invocation.json"), "utf8"), /RAW_INVALID_PAYLOAD_SENTINEL/);
    } finally { if (timer) clearTimeout(timer); await context.dispose(); }
  }
});


test("Codex diagnostics reduce in-memory messages to a fixed failure category", () => {
  const cases = [
    ["You have hit your usage limit. SECRET_RAW_CREDENTIAL https://private.invalid/token", "usage_limit"],
    ["insufficient_quota", "usage_limit"],
    ["HTTP 401 Unauthorized: SECRET_RAW_CREDENTIAL", "authentication"],
    ["Access token expired", "authentication"],
    ["Too many requests; HTTP 429", "rate_limit"],
    ["invalid_json_schema: SECRET_RAW_CREDENTIAL", "invalid_schema"],
    ["Output schema rejected", "invalid_schema"],
    ["stream disconnected before completion: transport error ECONNRESET", "network"],
    ["HTTP 503 service_unavailable", "service"],
    ["server_error", "service"],
    ["connection_error", "network"],
    ["Unrecognized diagnostic SECRET_RAW_CREDENTIAL", "unknown"],
  ] as const;
  for (const [diagnostic, category] of cases) assert.equal(classifyCodexFailure(diagnostic), category);
});

test("Codex failure categories and fixed messages never retain raw structured errors, stderr, secrets, or URLs", async () => {
  const secret = "SECRET_DIAGNOSTIC_CREDENTIAL_SENTINEL";
  const url = "https://private.invalid/request?api_key=SECRET_URL_SENTINEL";
  const scenarios = [
    { event: { type: "turn.failed", model: "SECRET_ERROR_MODEL_SENTINEL", error: { message: `Usage limit reached ${secret} ${url}`, code: "usage_limit", other: secret } }, stderr: `transport error ${secret} ${url}`, category: "usage_limit", message: "red agent: Codex account usage limit reached." },
    { event: { type: "error", message: `Invalid API key ${secret} ${url}`, model: "SECRET_ERROR_MODEL_SENTINEL" }, stderr: "", category: "authentication", message: "red agent: Codex authentication failed." },
    { event: { type: "turn.failed", error: { code: "rate_limit_exceeded", message: `${secret} ${url}` } }, stderr: "", category: "rate_limit", message: "red agent: Codex request rate limit reached." },
    { event: { type: "error", message: `invalid_json_schema ${secret} ${url}` }, stderr: "", category: "invalid_schema", message: "red agent: Codex rejected the structured output schema." },
    { event: undefined, stderr: `Connection reset ECONNRESET ${secret} ${url}`, category: "network", message: "red agent: Codex connection failed." },
    { event: undefined, stderr: `HTTP 503 internal_server_error ${secret} ${url}`, category: "service", message: "red agent: Codex service reported an error." },
    { event: { type: "item.completed", item: { type: "agent_message", text: `usage_limit ${secret} ${url}` } }, stderr: `model: SECRET_STDERR_MODEL_SENTINEL\nUnrecognized failure ${secret} ${url}`, category: "unknown", message: "red agent: Codex subprocess failed; no supported diagnostic category was identified." },
  ] as const;
  for (const scenario of scenarios) {
    const context = await fixture(`process.stdin.resume(); process.stdin.on('end', () => { ${scenario.event ? `console.log(${JSON.stringify(JSON.stringify(scenario.event))});` : ""} process.stderr.write(${JSON.stringify(scenario.stderr)}); process.exitCode = 1; });`);
    try {
      let failure: AgentCallError | undefined;
      try { await runCodexStructured({ binary: context.binary, artifactPath: context.artifactPath, role: "red", prompt: "ROLE_PROMPT", schema: {}, timeoutMs: 3000 }); }
      catch (error) { assert.ok(error instanceof AgentCallError); failure = error; }
      assert.ok(failure); assert.equal(failure.reason, "process_error"); assert.equal(failure.failureCategory, scenario.category); assert.equal(failure.message, scenario.message);
      assert.doesNotMatch(failure.message, /SECRET_|https?:/);
      const metadata = JSON.parse(await readFile(join(context.artifactPath, "invocation.json"), "utf8"));
      assert.equal(metadata.failureCategory, scenario.category); assert.equal(metadata.status, "process_error"); assert.equal(metadata.model, "codex-default");
      for (const file of await readdir(context.artifactPath)) {
        assert.notEqual(file, "response.raw.json");
        assert.doesNotMatch(await readFile(join(context.artifactPath, file), "utf8"), /SECRET_|https?:/);
      }
    } finally { await context.dispose(); }
  }
});
