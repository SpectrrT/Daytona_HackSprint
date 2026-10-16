import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.js";
import { summarizeTrials } from "./metrics.js";
import type { Trial } from "./trial.js";
/** Public metrics contain no source, counterexample stimuli, prompts, or private paths. */
export async function readAblationSummary(id?: string) {
  if (!id) { const latest = JSON.parse(await readFile(join(config.DATA_DIR, "ablation/latest.json"), "utf8")); id = latest.runId; }
  if (!id || !/^abl-[a-zA-Z0-9_-]{1,95}$/.test(id)) throw new Error("Invalid ablation identifier.");
  const result = JSON.parse(await readFile(join(config.DATA_DIR, "ablation", id, "results.json"), "utf8"));
  const trials = result.trials as Trial[];
  return { runId: result.runId, status: result.status, model: result.model, contractHash: result.contractHash, corpusHash: result.corpusHash, plannedSeeds: result.seeds.length, generations: result.generations, summary: summarizeTrials(trials), development: result.development,
    graphTransfer: trials.filter(t => t.mode === "graph").flatMap(t => t.evaluations.slice(0, 1).map(e => ({ seed: t.seed, path: e.retrieval.path, lessonsRetrieved: e.retrieval.ids.length, passed: e.result.checks.find(c => c.id === "transfer-empty-boundary" && c.hidden)?.passed ?? null }))),
    arize: result.arize, caveats: result.caveats, failed: !!result.error };
}
