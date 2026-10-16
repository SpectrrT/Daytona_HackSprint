import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { AgentInvocation, EvolutionRun, EvolutionSystem, FailureEvidence } from "@hollow-purple/shared/evolution";
import { BUFFER_PROMPT } from "@hollow-purple/shared/evolution";
import { freezeContract } from "../engine/contract.js";
import { sanitizeRun, sanitizeSystem } from "./publish-evidence.js";

const PRIVATE_MARKERS = ["PRIVATE_BLUE_SESSION", "PRIVATE_RED_SESSION", "PRIVATE_BLUE_PROMPT", "PRIVATE_EVENT_PAYLOAD", "PRIVATE_BROWSER_CAPABILITY",
  "/private/unit-agent-blue", "/private/unit-agent-red", "/private/unit-candidate", "/private/unit-browser.png"];
const source = "// Public fixture source used only by sanitizer tests.\nmodule fifo; endmodule\n";
const sourceHash = createHash("sha256").update(source).digest("hex");
const sequence = [{ reset: true, write: false, read: false, data: 0 }, { reset: false, write: true, read: true, data: 18 }];

function invocation(role: "blue" | "red"): AgentInvocation {
  return { role, provider: "codex-cli", model: "unit-test-model", startedAt: 100, durationMs: 25, inputTokens: 12, outputTokens: 8,
    sessionId: role === "blue" ? "PRIVATE_BLUE_SESSION" : "PRIVATE_RED_SESSION",
    artifactPath: role === "blue" ? "/private/unit-agent-blue" : "/private/unit-agent-red" };
}
function fixture(): EvolutionRun {
  const failure: FailureEvidence = { id: "public-failure", testId: "agent-red-boundary", testName: "Public boundary test", seed: 42,
    cycle: 1, expected: null, actual: 18, summary: "An empty read incorrectly bypassed the new write.", sequence,
    trace: [{ ...sequence[1]!, cycle: 1, expected: null, actual: 18, occupancy: 1, actualOccupancy: 0, full: false, empty: true, mismatch: true }], reproduced: true };
  const blue = Object.assign(invocation("blue"), { privatePrompt: "PRIVATE_BLUE_PROMPT" });
  return {
    id: "public-unit-run", prompt: BUFFER_PROMPT, provider: "daytona", status: "completed", strategy: "agents", verificationFixture: true,
    contract: freezeContract(BUFFER_PROMPT, 100), regressions: [failure], championId: "c2", createdAt: 100, finishedAt: 200,
    budget: { maxCandidates: 3, maxCycles: 10000, usedCandidates: 2, usedCycles: 100 }, summary: "Public verification summary.",
    candidates: [{ id: "c2", parentId: "c1", generation: 1, label: "Public repaired child", variant: "generated", status: "verified",
      source, sourceHash, checks: [{ id: "regression-0", name: "Inherited regression", passed: true, cycles: 2, hidden: false, summary: "Matched the contract." }],
      failure, score: 100, lessons: ["Keep empty operations atomic."], sandboxId: "public-sandbox-id", artifactPath: "/private/unit-candidate",
      backend: "verilator", cycles: 100, createdAt: 101, agent: blue, redAgent: invocation("red"), regressionCount: 1,
      rationale: "Public implementation rationale.", redRationale: "Public attack rationale.",
      attacks: [{ id: "boundary", name: "Public attack", hypothesis: "Empty simultaneous operations may bypass.", sequence }] }],
    events: [{ seq: 1, ts: 110, runId: "public-unit-run", type: "candidate.updated", candidateId: "c2", message: "Public event summary.",
      payload: { privatePrompt: "PRIVATE_EVENT_PAYLOAD", agent: blue, cdpUrl: "wss://private.invalid/?token=PRIVATE_BROWSER_CAPABILITY" } }],
    browserAudit: { sessionId: "PRIVATE_BROWSER_CAPABILITY", passed: true, summary: "Private browser audit metadata.",
      liveViewUrl: "https://private.invalid/?token=PRIVATE_BROWSER_CAPABILITY", screenshotPath: "/private/unit-browser.png", checks: [] },
  };
}

test("published run retains measured evidence and explicit imported-fixture provenance", () => {
  const run = fixture();
  const publicRun = sanitizeRun(run);
  assert.equal(publicRun.verificationFixture, true);
  assert.equal(publicRun.strategy, "agents");
  assert.equal(publicRun.championId, "c2");
  assert.deepEqual(publicRun.contract, run.contract);
  assert.deepEqual(publicRun.regressions, run.regressions);
  const candidate = publicRun.candidates[0]!;
  assert.equal(candidate.source, source);
  assert.equal(candidate.sourceHash, sourceHash);
  assert.equal(candidate.regressionCount, 1);
  assert.equal(candidate.backend, "verilator");
  assert.deepEqual(candidate.attacks, run.candidates[0]!.attacks);
  assert.deepEqual(candidate.failure?.sequence, sequence);
  assert.equal(candidate.failure?.trace[0]?.actualOccupancy, 0);
  assert.deepEqual(candidate.checks, run.candidates[0]!.checks);
});

test("published run strips private invocation metadata, raw payloads, and browser capabilities", () => {
  const run = fixture();
  const before = structuredClone(run);
  const publicRun = sanitizeRun(run);
  const candidate = publicRun.candidates[0]!;
  for (const agent of [candidate.agent, candidate.redAgent]) {
    assert.ok(agent);
    assert.equal(Object.hasOwn(agent, "artifactPath"), false);
    assert.equal(Object.hasOwn(agent, "sessionId"), false);
    assert.equal(Object.hasOwn(agent, "privatePrompt"), false);
    assert.equal(agent.provider, "codex-cli");
    assert.equal(agent.model, "unit-test-model");
    assert.equal(agent.inputTokens, 12);
    assert.equal(agent.outputTokens, 8);
  }
  assert.equal(Object.hasOwn(candidate, "artifactPath"), false);
  assert.equal(Object.hasOwn(publicRun, "browserAudit"), false);
  assert.equal(Object.hasOwn(publicRun.events[0]!, "payload"), false);
  assert.deepEqual(publicRun.events[0], { seq: 1, ts: 110, runId: "public-unit-run", type: "candidate.updated", candidateId: "c2", message: "Public event summary." });
  const serialized = JSON.stringify(publicRun);
  for (const marker of PRIVATE_MARKERS) assert.equal(serialized.includes(marker), false, `${marker} escaped the public allowlist`);
  assert.deepEqual(run, before, "Sanitization must not modify the retained private evidence.");
});

test("imported source remains without a fabricated Blue invocation after sanitization", () => {
  const run = fixture();
  run.candidates[0]!.agent = undefined;
  run.candidates[0]!.rationale = "Imported manual integration fixture, NOT Blue-generated.";
  const publicRun = sanitizeRun(run);
  assert.equal(publicRun.verificationFixture, true);
  assert.equal(publicRun.candidates[0]!.agent, undefined);
  assert.equal(publicRun.candidates[0]!.redAgent?.role, "red");
  assert.match(publicRun.candidates[0]!.rationale!, /NOT Blue-generated/);
});

test("published system forces read-only mode and excludes private URLs and diagnostic details", () => {
  const system: EvolutionSystem = { providers: { daytona: true, anchor: true, model: false }, agentProvider: "codex-cli", agentsReady: true,
    agentModel: "unit-test-model", defaultProvider: "daytona", readOnly: false,
    publicDashboardUrl: "https://private.invalid/?token=PRIVATE_BROWSER_CAPABILITY",
    checks: [{ name: "Configured", ok: true, detail: "/private/unit-agent-blue" }, { name: "Unavailable", ok: false, detail: "PRIVATE_BLUE_SESSION" }] };
  const publicSystem = sanitizeSystem(system);
  assert.equal(publicSystem.readOnly, true);
  assert.deepEqual(publicSystem.providers, system.providers);
  assert.equal(publicSystem.agentProvider, "codex-cli");
  assert.equal(publicSystem.agentModel, "unit-test-model");
  assert.equal(publicSystem.defaultProvider, "daytona");
  assert.equal(publicSystem.agentsReady, true);
  assert.equal(Object.hasOwn(publicSystem, "publicDashboardUrl"), false);
  assert.deepEqual(publicSystem.checks, [{ name: "Configured", ok: true, detail: "Available at snapshot time" }, { name: "Unavailable", ok: false, detail: "Unavailable at snapshot time" }]);
  const serialized = JSON.stringify(publicSystem);
  for (const marker of PRIVATE_MARKERS) assert.equal(serialized.includes(marker), false);
  assert.equal(system.readOnly, false);
  assert.equal(system.checks![0]!.detail, "/private/unit-agent-blue");
});
