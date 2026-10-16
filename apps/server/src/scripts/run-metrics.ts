import { readFile, stat } from "node:fs/promises";
import { parseRunEvidence, summarizeRun } from "../benchmarks/run-metrics.js";

try {
  const path = process.argv[2];
  if (!path || process.argv.length !== 3) throw new Error("Usage: node --import tsx src/scripts/run-metrics.ts /path/to/run.json-or-jsonl");
  if ((await stat(path)).size > 64 * 1024 * 1024) throw new Error("Run export exceeds the 64 MiB read budget.");
  const summary = summarizeRun(parseRunEvidence(await readFile(path, "utf8")));
  console.log(JSON.stringify(summary, null, 2));
} catch {
  console.error("Could not summarize this run. Supply one complete JSON export or intact JSONL journal with a valid frozen contract. Input files were not modified.");
  process.exitCode = 1;
}
