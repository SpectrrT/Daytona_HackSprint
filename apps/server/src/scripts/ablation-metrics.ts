import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.js";
import { formatMetrics, summarizeTrials } from "../ablation/metrics.js";
const id = process.argv[2]; if (!id || !/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error("Supply a valid ablation run ID.");
const retry = id.startsWith("retry-");
const results = JSON.parse(await readFile(join(config.DATA_DIR, retry ? "retry-benchmarks" : "ablation", id, "results.json"), "utf8"));
if (retry) {
  const count = (passed: number, total: number) => total ? `${passed}/${total}` : "missing";
  console.log("| Arm | Retry safety and useful completion | Clean completion |\n|---|---|---|");
  for (const arm of results.summary) console.log(`| ${arm.arm} | ${count(arm.retryPass, arm.retryTotal)} | ${count(arm.cleanPass, arm.cleanTotal)} |`);
  console.log(`Retry safety: ${results.summary.map((arm: any) => `${arm.arm} ${count(arm.retryPass, arm.retryTotal)}`).join(", ")}. Clean completion: ${results.summary.map((arm: any) => `${arm.arm} ${count(arm.cleanPass, arm.cleanTotal)}`).join(", ")}.`);
  console.log(results.scope);
} else console.log(formatMetrics(summarizeTrials(results.trials)));
console.log(`Task: ${retry ? "paired concurrent retries" : results.task ?? "synthesis"}. Model: ${results.model}. Contract: ${results.contractHash}. Corpus: ${results.corpusHash ?? "not applicable"}. Status: ${results.status}.`);
if (results.error) console.log(`Missing evidence: ${results.error}`);
