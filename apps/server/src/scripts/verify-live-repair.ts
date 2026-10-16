import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BUFFER_PROMPT, type EvolutionRun } from "@hollow-purple/shared/evolution";
import { config, REPO_ROOT } from "../config.js";
import { EvolutionEngine } from "../engine/index.js";
import { passesAcceptance } from "../arena/tools.js";
import { RunStore } from "../store.js";

// Deliberately do not load the journal: another controller may own active runs.
// This process creates a fresh UUID and only writes its own run's event log.
const store = new RunStore(config.DATA_DIR);
const engine = new EvolutionEngine(store);
const fixturePath = join(REPO_ROOT, "lab", "fixtures", "count-race.sv");
const source = await readFile(fixturePath, "utf8");
const verificationDir = join(config.DATA_DIR, "verification");
await mkdir(verificationDir, { recursive: true, mode: 0o700 });
const markerPath = join(verificationDir, "repairing-run.json");
const fullRunPath = join(verificationDir, "fullrun.json");
const startedAt = Date.now();
const id = await engine.startRepairVerification({ source, label: "Imported manual count-race fixture · NOT Blue-generated", prompt: BUFFER_PROMPT, seed: 20261016 });
const metadata = { id, startedAt, fixturePath, fullRunPath, provenance: "One imported manually fault-seeded integration fixture, followed by two actual model-written repair children.", verificationFixture: true };
await writeFile(markerPath, JSON.stringify({ ...metadata, status: "running" }, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ id, status: "running", verificationFixture: true, metadata: markerPath }));
let run: EvolutionRun | undefined;
try {
  run = await engine.wait(id);
  await store.flush();
  await writeFile(fullRunPath, JSON.stringify(run, null, 2), { mode: 0o600 });
  assert.ok(run.verificationFixture && run.provider === "daytona" && run.strategy === "agents", "Missing explicit live verification fixture provenance.");
  assert.ok(run.status === "completed", run.error ?? "Repair verification did not complete.");
  assert.ok(run.candidates.length === 3, "Expected exactly one imported fixture and two model-written children.");
  const baseline = run.candidates[0]!;
  assert.ok(baseline.id === "c1" && !baseline.agent && baseline.source === source && /NOT Blue-generated/.test(baseline.rationale ?? ""), "The fixture must never be attributed to Blue.");
  assert.ok(baseline.backend === "verilator" && baseline.redAgent && baseline.attacks?.length === 4, "The imported fixture must receive a real Red search and Daytona RTL execution.");
  assert.ok(baseline.failure?.reproduced && run.regressions.length > 0, "The imported fixture failure was not independently reproduced and retained.");
  for (const child of run.candidates.slice(1)) {
    assert.ok(child.parentId === baseline.id && child.generation === 1, "Both repair children must branch from the witnessed fixture failure.");
    assert.ok(child.agent?.role === "blue" && child.redAgent?.role === "red" && child.attacks?.length === 4, "Repair children need actual Blue and Red invocation provenance.");
    assert.ok(child.backend === "verilator" && child.sourceHash && child.sourceHash !== baseline.sourceHash, "Each child must execute its own changed RTL in Daytona.");
    assert.ok(child.sourceHash === createHash("sha256").update(child.source).digest("hex"), "Child source hash does not match executed source.");
  }
  const championId = run.championId;
  const champion = run.candidates.find((candidate) => candidate.id === championId);
  assert.ok(champion?.agent && champion.parentId === baseline.id, "No model-written repair child qualified as champion.");
  assert.ok(champion.regressionCount === run.regressions.length, "Champion was not tested against every current regression.");
  assert.ok(passesAcceptance({ checks: champion.checks, cycles: champion.cycles, failure: champion.failure, buildError: champion.buildError, source: champion.source, backend: "verilator", reproduced: false }, run.regressions.length, champion.attacks!.map((attack) => `agent-red-${attack.id.replace(/^agent-red-/, "").toLowerCase()}`)), "Champion failed the fixed directed, Red, hidden, or inherited regression gates.");
  await writeFile(markerPath, JSON.stringify({ ...metadata, status: "completed", verified: true, finishedAt: Date.now(), championId: champion.id, regressions: run.regressions.length, cycles: run.budget.usedCycles }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ id, verified: true, importedFixtures: 1, modelWrittenChildren: 2, championId: champion.id, regressions: run.regressions.length, cycles: run.budget.usedCycles, fullRunPath }, null, 2));
} catch (error) {
  const message = error instanceof Error ? error.message : "Repair verification failed.";
  await writeFile(markerPath, JSON.stringify({ ...metadata, status: run?.status ?? "failed", verified: false, finishedAt: Date.now(), error: message }, null, 2), { mode: 0o600 });
  console.error(JSON.stringify({ id, verified: false, error: message, fullRunPath }));
  process.exitCode = 1;
}
