import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BUFFER_PROMPT, type AgentInvocation, type EvaluationResult } from "@hollow-purple/shared/evolution";
import { AgentCallError } from "../agents/codex.js";
import { RunStore } from "../store.js";
import { EvolutionEngine, type AgentTeam, type EvaluationRequest } from "./index.js";

const invocation = (role: "blue" | "red"): AgentInvocation => ({ role, provider: "codex-cli", model: "test-only-fake", startedAt: 0, durationMs: 1 });
const attacks = Array.from({ length: 4 }, (_, i) => ({ id: `attack-${i}`, name: `Attack ${i}`, hypothesis: "A bounded test hypothesis.", sequence: [{ reset: true, write: false, read: false, data: i }] }));
function passing(input: EvaluationRequest): EvaluationResult {
  return { source: input.source!, sourceHash: createHash("sha256").update(input.source!).digest("hex"), backend: "verilator", cycles: 100, reproduced: false,
    checks: [...["order", "simultaneous", "full-replace", "empty-concurrent", "reset-active", "red-seeded", ...input.regressions.map((_, i) => `regression-${i}`), ...input.attacks!.map((attack) => `agent-red-${attack.id}`)].map((id) => ({ id, name: id, passed: true, hidden: false, cycles: 10, summary: "measured" })), { id: "held-out", name: "Held-out", passed: true, hidden: true, cycles: 50, summary: "measured" }] };
}

test("a declined Red call or a Blue timeout rejects that design; the run continues and never accepts it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "resilience-test-"));
  try {
    const store = new RunStore(dir);
    const agents: AgentTeam = {
      async buildBlue(input) {
        if (input.candidateId === "c2") throw new AgentCallError("timeout", "blue model call exceeded its time budget.");
        return { label: `Generated ${input.candidateId}`, source: `// fixture ${input.candidateId}`, rationale: "Test fixture.", agent: invocation("blue") };
      },
      async searchRed(input) {
        if (input.candidateId === "c1") throw new AgentCallError("process_error", "red agent: declined", "content_policy");
        return { attacks, rationale: "Test Red fixture.", agent: invocation("red") };
      },
    };
    const engine = new EvolutionEngine(store, async (input) => passing(input), agents);
    const id = await engine.start({ prompt: BUFFER_PROMPT, provider: "daytona", maxCandidates: 3 });
    const run = await engine.wait(id);
    assert.equal(run.status, "completed", run.error ?? run.summary);
    assert.equal(run.championId, "c3");
    const byId = Object.fromEntries(run.candidates.map((c) => [c.id, c]));
    assert.equal(byId.c1!.status, "rejected");
    assert.match(byId.c1!.redRationale ?? "", /content policy/);
    assert.equal(byId.c2!.status, "rejected");
    assert.match(byId.c2!.rationale ?? "", /time budget/);
    assert.equal(byId.c3!.status, "verified");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
