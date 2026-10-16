import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Candidate, EvolutionEvent, EvolutionRun } from "@hollow-purple/shared/evolution";
import { createServer } from "./server.js";

/** The MCP server against a stubbed controller: the same run log the dashboard reads, rendered for Claude. */

const t0 = Date.UTC(2026, 9, 16, 17, 0, 0);
const agent = (role: "blue" | "red") => ({ role, provider: "codex-cli" as const, model: "gpt-5-codex", startedAt: t0, durationMs: 42_000, inputTokens: 9000, outputTokens: 1200 });
const c1: Candidate = {
  id: "c1", generation: 0, label: "circular_fifo", variant: "generated", status: "building", source: "",
  checks: [], score: 0, lessons: [], cycles: 0, createdAt: t0,
};
const attacks = [{ id: "a1", name: "wrap at full", hypothesis: "Pointer wrap drops the oldest word", sequence: [{ reset: false, write: true, read: false, data: 7 }] }];
const checks = [{ id: "d1", name: "Directed fill", passed: true, cycles: 40, hidden: false, summary: "ok" }, { id: "h1", name: "Held-out", passed: true, cycles: 90, hidden: true, summary: "ok" }];
const step = (seq: number, type: EvolutionEvent["type"], message: string, payload?: Candidate) =>
  ({ seq, ts: t0 + seq * 1000, runId: "r1", type, message, ...(payload ? { candidateId: payload.id, payload } : {}) }) as EvolutionEvent;
const verified: Candidate = { ...c1, source: "module fifo; endmodule", status: "verified", agent: agent("blue"), rationale: "Count register keeps full and empty exact.", redAgent: agent("red"), redRationale: "Probing the wrap boundary.", attacks, checks, sourceHash: "ab".repeat(32) };

const run: EvolutionRun = {
  id: "r1", prompt: "32-entry FIFO", provider: "daytona", status: "completed", contract: { hash: "cd".repeat(32) } as EvolutionRun["contract"],
  candidates: [verified], regressions: [], championId: "c1", createdAt: t0, finishedAt: t0 + 9000,
  budget: { maxCandidates: 3, maxCycles: 100_000, usedCandidates: 1, usedCycles: 130 },
  events: [
    step(1, "run.started", "Run started."),
    step(2, "candidate.created", "Created c1.", c1),
    step(3, "candidate.updated", "Blue answered.", { ...c1, source: verified.source, agent: agent("blue"), rationale: verified.rationale }),
    step(4, "candidate.updated", "Red answered.", { ...c1, source: verified.source, agent: agent("blue"), rationale: verified.rationale, redAgent: agent("red"), redRationale: verified.redRationale, attacks }),
    step(5, "candidate.updated", "Testing.", { ...verified, status: "testing", checks: [] }),
    step(6, "candidate.updated", "Verified.", verified),
    step(7, "champion.selected", "c1 is the champion."),
    step(8, "run.completed", "Verified 1 design."),
  ],
};

let requests: { method: string; path: string }[] = [];
const realFetch = globalThis.fetch;

async function connect() {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer().connect(serverSide);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientSide);
  return client;
}
const text = (result: Awaited<ReturnType<Client["callTool"]>>) => (result.content as { text: string }[]).map((c) => c.text).join("\n");

beforeEach(() => {
  requests = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? "GET";
    requests.push({ method, path: url.pathname });
    if (method === "GET" && url.pathname === "/api/runs/r1") return Response.json(run);
    if (method === "POST" && url.pathname === "/api/runs/r1/approval/request") {
      return Response.json({ ...run, approval: { status: "requested", channel: "voice", candidateId: "c1", requestedAt: t0 } });
    }
    return Response.json({ error: "Run not found." }, { status: 404 });
  }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = realFetch; });

test("offers run tools, and none of them can approve a release", async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [
    "agent_lab_status", "get_agent_failures", "get_agent_repair", "get_agent_result", "get_agent_transcript",
    "get_design_source", "get_failure_evidence", "get_run", "lab_status", "list_agent_runs", "list_runs",
    "request_release_approval", "start_agent_hardening", "start_hardening_run", "stop_agent_run", "watch_agent_run", "watch_run",
  ].sort());
  await client.close();
});

test("watch_run returns what the agents said after the given sequence number", async () => {
  const client = await connect();
  const out = text(await client.callTool({ name: "watch_run", arguments: { run_id: "r1", after_seq: 2, wait_seconds: 0 } }));
  assert.match(out, /status: completed · next_after_seq: 8/);
  assert.match(out, /BLUE +c1 +Count register keeps full and empty exact\./);
  assert.match(out, /RED +c1 +Probing the wrap boundary\./);
  assert.match(out, /- wrap at full: Pointer wrap drops the oldest word \(1-cycle input\)/);
  assert.match(out, /VERIFIER c1 ✓ +c1 passed all 2 checks/);
  assert.doesNotMatch(out, /Writing design c1/, "seq 2 was already seen");
  await client.close();
});

test("get_agent_transcript filters to one speaker", async () => {
  const client = await connect();
  const out = text(await client.callTool({ name: "get_agent_transcript", arguments: { run_id: "r1", speaker: "red" } }));
  assert.match(out, /Probing the wrap boundary/);
  assert.doesNotMatch(out, /BLUE|VERIFIER/);
  await client.close();
});

test("an imported starter is never attributed to Blue", async () => {
  const starter: Candidate = { ...c1, id: "c1", label: "Imported manual faulty starter", source: "module fifo; endmodule" };
  const imported = { ...run, id: "r2", events: [{ ...step(1, "candidate.created", "Imported a manual fault-seeded starter. No Blue model invocation is claimed.", starter), runId: "r2" }] };
  globalThis.fetch = (async () => Response.json(imported)) as typeof fetch;
  const client = await connect();
  const out = text(await client.callTool({ name: "get_agent_transcript", arguments: { run_id: "r2" } }));
  assert.match(out, /LAB +c1 +Imported a manual fault-seeded starter/);
  assert.doesNotMatch(out, /BLUE/);
  await client.close();
});

test("request_release_approval only asks: it never posts a decision", async () => {
  const client = await connect();
  const out = text(await client.callTool({ name: "request_release_approval", arguments: { run_id: "r1", channel: "voice" } }));
  assert.match(out, /Talk to the release agent/);
  assert.deepEqual(requests, [{ method: "POST", path: "/api/runs/r1/approval/request" }]);
  await client.close();
});

test("explains an unreachable controller instead of failing silently", async () => {
  globalThis.fetch = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
  const client = await connect();
  const result = await client.callTool({ name: "get_run", arguments: { run_id: "r1" } });
  assert.equal(result.isError, true);
  assert.match(text(result), /not reachable.*pnpm dev/);
  await client.close();
});
