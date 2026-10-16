import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.js";
import { formatMetrics, summarizeTrials } from "../ablation/metrics.js";
const id = process.argv[2]; if (!id || !/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error("Supply a valid ablation run ID.");
const results = JSON.parse(await readFile(join(config.DATA_DIR, "ablation", id, "results.json"), "utf8"));
console.log(formatMetrics(summarizeTrials(results.trials)));
console.log(`Task: ${results.task ?? "synthesis"}. Model: ${results.model}. Contract: ${results.contractHash}. Corpus: ${results.corpusHash}. Status: ${results.status}.`);
if (results.error) console.log(`Missing evidence: ${results.error}`);
