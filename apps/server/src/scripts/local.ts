import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// Project evidence commands must not inherit another application's DATA_DIR.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const commands: Record<string, string> = { ablation: "./ablation.js", metrics: "./ablation-metrics.js", charts: "./charts.js" };
const command = process.argv[2];
if (!command || !commands[command]) throw new Error("Choose ablation, metrics, or charts.");
process.env.DATA_DIR = resolve(root, process.env.HOLLOW_DATA_DIR ?? "data");
process.argv.splice(2, 1);
await import(commands[command]!);
