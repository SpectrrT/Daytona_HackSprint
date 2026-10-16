import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { runSoftwareExperiment } from "../software/engine.js";
import type { SoftwareRunOptions } from "../software/engine.js";

const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());
const options: SoftwareRunOptions = { signal: controller.signal, onEvent: message => console.log(JSON.stringify({ event: message })) };
if (process.argv.includes("--prepared")) options.prepared = JSON.parse(await readFile("../../data/software-runs/prepared.json", "utf8"));
const run = await runSoftwareExperiment(options);
console.log(JSON.stringify({ id: run.id, status: run.status, championId: run.championId, videoPath: run.videoPath, error: run.error }));
if (run.status === "completed" && run.videoPath && process.argv.includes("--open")) {
  spawnSync("open", ["-a", "QuickTime Player", run.videoPath], { stdio: "ignore" });
}
if (run.status !== "completed") process.exitCode = 1;
