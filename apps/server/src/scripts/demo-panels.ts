import type { LabRun, LabRunSummary } from "@antibody/shared/agent-lab";
import { demoVerdict, panelReceives, type DemoRole } from "@antibody/shared/agent-lab-presentation";

const role = process.argv[2] as DemoRole;
if (!["blue", "red", "verifier"].includes(role)) throw new Error("Choose blue, red or verifier.");
const afterIndex = process.argv.indexOf("--after");
const since = afterIndex < 0 ? Date.now() : Number(process.argv[afterIndex + 1]);
if (!Number.isSafeInteger(since) || since < 0) throw new Error("Invalid run start time.");
const origin = new URL(process.env.ANTIBODY_URL ?? "http://127.0.0.1:8787");
if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password || origin.search || origin.hash) throw new Error("Use a controller origin without credentials.");
const color = role === "blue" ? "\x1b[94m" : role === "red" ? "\x1b[91m" : "\x1b[92m";
const plain = (value: string) => value.replace(/[^\x20-\x7e]/g, " ");
const line = (value: string) => console.log(plain(value));
console.log(`${color}${role.toUpperCase()} | ANTIBODY\x1b[0m`);
line(role === "blue" ? "Writes repairs from reproduced failures." : role === "red" ? "Attacks the actual current candidate." : "Checks real tool effects and useful work.");
line("Waiting for a new run from Claude above.");
const get = async <T>(path: string): Promise<T> => {
  const response = await fetch(new URL(path, origin), { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error("Controller is unavailable.");
  return response.json() as Promise<T>;
};
let id: string | undefined, cursor = 0, settled = false, disconnected = false;
while (true) {
  try {
    const runs = await get<LabRunSummary[]>("/api/agent-lab/runs");
    const latest = runs.filter(run => run.createdAt >= since).sort((a, b) => b.createdAt - a.createdAt)[0];
    if (latest && latest.id !== id) {
      id = latest.id; cursor = 0; settled = false;
      line(`RUN ${id}`);
    }
    if (disconnected) { line("Controller reconnected."); disconnected = false; }
    if (id && !settled) {
      const run = await get<LabRun>(`/api/agent-lab/runs/${encodeURIComponent(id)}`);
      if (Array.isArray(run.events)) {
        for (const event of run.events.slice(cursor)) if (panelReceives(role, event.message)) line(`${event.candidateId ? `[${event.candidateId}] ` : ""}${event.message}`);
        cursor = run.events.length;
      }
      if (run.status !== "running") {
        settled = true;
        const verdict = demoVerdict(run);
        if (verdict.status === "success") {
          console.log(`\n\x1b[92mSUCCESS | VERIFIED REPAIR\x1b[0m`);
          line(`${verdict.candidate}: ${verdict.checks.passed}/${verdict.checks.total} checks passed`);
          if (role === "verifier") {
            for (const [name, count] of [["Old attacks", verdict.regressions], ["New Red attacks", verdict.newAttacks], ["Directed", verdict.directed], ["Hidden", verdict.heldout], ["Useful tasks", verdict.useful]] as const) line(`${name}: ${count.passed}/${count.total}`);
            line(`${verdict.reproducedFailures} reproduced failures; ${verdict.repairGenerations} Blue repair versions.`);
          }
        } else {
          console.log(`\n\x1b[91m${verdict.status.toUpperCase()} | NO VERIFIED RESULT\x1b[0m`);
          if (run.error) line(run.error);
        }
        line("Result retained. Waiting for another new run.");
      }
    }
  } catch { if (!disconnected) { line("Waiting for controller connection. No result inferred."); disconnected = true; } }
  await new Promise(resolve => setTimeout(resolve, 1000));
}
