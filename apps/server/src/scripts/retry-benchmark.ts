import { runRetryBenchmark } from "../benchmarks/retries.js";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config, REPO_ROOT } from "../config.js";
const index = process.argv.indexOf("--repeats");
const publishIndex = process.argv.indexOf("--publish-only");
let result: { id: string; status: string; directory: string };
if (publishIndex >= 0) {
  const id = process.argv[publishIndex + 1];
  if (!id || !/^retry-[a-zA-Z0-9_-]{1,95}$/.test(id)) throw new Error("Supply a recorded retry benchmark ID.");
  const directory = join(config.DATA_DIR, "retry-benchmarks", id), evidence = JSON.parse(await readFile(join(directory, "results.json"), "utf8"));
  result = { id, directory, status: evidence.status };
} else result = await runRetryBenchmark(index >= 0 ? Number(process.argv[index + 1]) : 3);
if (result.status !== "completed") process.exitCode = 1;
if (result.status === "completed" && config.ARIZE_ENABLED) {
  const output = spawnSync(config.ARIZE_PYTHON ?? join(REPO_ROOT, "data/telemetry-venv/bin/python"), [join(REPO_ROOT, "telemetry/retry_experiments.py"), join(result.directory, "results.json")], { timeout: 180000, encoding: "utf8", env: { PATH: process.env.PATH, HOME: process.env.HOME, ARIZE_API_KEY: config.ARIZE_API_KEY, ARIZE_SPACE_ID: config.ARIZE_SPACE_ID } });
  let arize: unknown;
  try { arize = JSON.parse(output.stdout.trim().split("\n").at(-1)!); } catch { arize = { status: "missing" }; }
  const path = join(result.directory, "results.json"), evidence = JSON.parse(await readFile(path, "utf8"));
  const arizeUploadAttempts = [...(evidence.arizeUploadAttempts ?? []), ...(evidence.arize ? [evidence.arize] : [])];
  await writeFile(path, JSON.stringify({ ...evidence, arizeUploadAttempts, arize }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ arize, summary: evidence.summary }));
  if (output.status !== 0) process.exitCode = 1;
}
