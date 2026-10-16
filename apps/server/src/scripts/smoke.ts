import assert from "node:assert/strict";
import { BUFFER_PROMPT, type EvolutionRun } from "@antibody/shared/evolution";
import { config } from "../config.js";

const origin = process.env.SMOKE_URL ?? `http://127.0.0.1:${config.PORT}`;
const provider = "daytona";
const response = await fetch(`${origin}/api/runs`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ prompt: BUFFER_PROMPT, provider, maxCandidates: 5, seed: 42 }),
});
assert.equal(response.status, 201, await response.clone().text());
const { id } = await response.json() as { id: string };
const deadline = Date.now() + 30 * 60_000;
let run: EvolutionRun | undefined;
while (Date.now() < deadline) {
  const result = await fetch(`${origin}/api/runs/${id}`);
  assert.equal(result.status, 200);
  run = await result.json() as EvolutionRun;
  if (["completed", "failed", "stopped"].includes(run.status)) break;
  await new Promise((resolve) => setTimeout(resolve, 5_000));
}
assert.equal(run?.status, "completed", run?.error ?? "run did not complete");
assert.ok(run.championId, "no accepted champion");
assert.equal(run.strategy, "agents");
assert.ok(run.candidates.every((candidate) => candidate.variant === "generated" && candidate.agent && candidate.redAgent && candidate.attacks?.length === 4), "missing real agent provenance");
assert.ok(run.regressions.every((failure) => failure.reproduced));
const champion = run.candidates.find((candidate) => candidate.id === run.championId);
assert.ok(champion, "champion does not exist");
assert.ok(champion.checks.every((check) => check.passed), "champion has a failing check");
assert.equal(champion.backend, "verilator");
assert.equal(champion.regressionCount, run.regressions.length);
const exported = await fetch(`${origin}/api/runs/${id}/export`);
assert.equal(exported.status, 200);
console.log(JSON.stringify({ id, provider, candidates: run.candidates.length, regressions: run.regressions.length, champion: champion.id, cycles: run.budget.usedCycles, exported: true }, null, 2));
