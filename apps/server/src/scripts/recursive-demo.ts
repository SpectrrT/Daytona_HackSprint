import { serve } from "@hono/node-server";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BUFFER_PROMPT } from "@hollow-purple/shared/evolution";
import { config, REPO_ROOT } from "../config.js";
import { requireHardwareSnapshot } from "../daytona/client.js";
import { EvolutionEngine } from "../engine/index.js";
import { createApp } from "../index.js";
import { configuredMemory } from "../memory/index.js";
import { RunStore } from "../store.js";

await requireHardwareSnapshot();
const memory = configuredMemory();
await memory?.backend.check();
// A fresh checkout/data directory owns this controller. Never call the recovery
// loader against another controller's journal while its agents may be running.
const store = new RunStore(config.DATA_DIR);
const engine = new EvolutionEngine(store, undefined, undefined, memory);
const server = serve({ fetch: createApp(store, engine).fetch, port: config.PORT, hostname: "127.0.0.1" });
let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  await engine.stopAll(); await store.flush(); server.close();
};
process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });
const source = await readFile(join(REPO_ROOT, "lab/fixtures/count-race.sv"), "utf8");
const id = await engine.startRecursiveDemo({ source, label: "Imported manual faulty starter, NOT Blue-generated", prompt: BUFFER_PROMPT, seed: 20261016, maxCandidates: 5, maxEvaluations: 8, challengePasses: 2 });
const directory = join(config.DATA_DIR, "runs", id);
await mkdir(directory, { recursive: true, mode: 0o700 });
const save = (file: string, data: unknown) => writeFile(join(directory, file), JSON.stringify(data, null, 2), { mode: 0o600 });
await writeFile(join(config.DATA_DIR, "recursive-demo.json"), JSON.stringify({ id, dashboard: `http://localhost:5173/?run=${id}`, controllerPort: config.PORT, status: "running" }, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ id, status: "running", graphMemory: !!memory, dashboard: `http://localhost:5173/?run=${id}` }));
const unsubscribe = store.subscribe(id, (event) => {
  if (["candidate.created", "failure.reproduced", "regression.added", "lesson.learned", "champion.selected", "run.completed", "run.failed", "run.stopped"].includes(event.type)) {
    console.log(JSON.stringify({ event: event.type, candidateId: event.candidateId, seq: event.seq }));
  }
});
const run = await engine.wait(id);
await store.flush(); unsubscribe();
await save("fullrun.json", run);
if (memory) {
  try { await save("memory.json", await memory.snapshot(run)); }
  catch { await save("memory-export-error.json", { exported: false, error: "Graph snapshot export failed. Inspect the configured provider; no graph result was substituted." }); }
}
await writeFile(join(config.DATA_DIR, "recursive-demo.json"), JSON.stringify({ id, dashboard: `http://localhost:5173/?run=${id}`, controllerPort: config.PORT, status: run.status, championId: run.championId, summary: run.summary, fullRunPath: join(directory, "fullrun.json") }, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ id, status: run.status, championId: run.championId, candidates: run.candidates.length, maximumGeneration: Math.max(...run.candidates.map((candidate) => candidate.generation)), regressions: run.regressions.length, cycles: run.budget.usedCycles, server: "Kept open for local inspection." }));
