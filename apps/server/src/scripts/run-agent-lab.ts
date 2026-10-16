import { spawnSync } from "node:child_process";
import { runAgentLab } from "../agent-lab/engine.js";
const controller = new AbortController(); process.once("SIGINT", () => controller.abort()); process.once("SIGTERM", () => controller.abort());
const run = await runAgentLab({ signal: controller.signal, onEvent: message => console.log(JSON.stringify({ event: message })) });
console.log(JSON.stringify({ id: run.id, status: run.status, championId: run.championId, videoPath: run.videoPath, error: run.error }));
if (run.status === "completed" && run.videoPath && process.argv.includes("--open")) spawnSync("open", ["-a", "QuickTime Player", run.videoPath], { stdio: "ignore" });
if (run.status !== "completed") process.exitCode = 1;
