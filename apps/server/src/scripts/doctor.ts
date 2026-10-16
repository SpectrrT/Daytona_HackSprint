import { spawnSync } from "node:child_process";
import { config } from "../config.js";
import { checkAnchorKey } from "../browser/anchor.js";
import { daytona } from "../daytona/client.js";

const live = process.argv.includes("--live");
const python = spawnSync(process.env.PYTHON_BIN ?? "python3", ["--version"], { encoding: "utf8" });
const checks = [
  { name: "Node.js 22+", ok: Number(process.versions.node.split(".")[0]) >= 22, detail: process.version },
  { name: "Python verifier", ok: python.status === 0, detail: python.stdout.trim() || python.stderr?.trim() || "python3 unavailable" },
  { name: "Daytona", ok: Boolean(config.DAYTONA_API_KEY), detail: config.DAYTONA_API_KEY ? "key configured" : "optional; set DAYTONA_API_KEY for HDL execution" },
  { name: "Anchor Browser", ok: Boolean(config.ANCHOR_API_KEY), detail: config.ANCHOR_API_KEY ? "key configured" : "optional; set ANCHOR_API_KEY for cloud browser audit" },
  { name: "Public dashboard URL", ok: Boolean(config.PUBLIC_DASHBOARD_URL), detail: config.PUBLIC_DASHBOARD_URL ? "configured" : "optional; required for Anchor to reach the dashboard" },
];
if (live) {
  for (const [name, enabled, check] of [
    ["Daytona authentication", Boolean(config.DAYTONA_API_KEY), async () => { await daytona().snapshot.get(config.PROD_SNAPSHOT); }],
    ["Anchor authentication", Boolean(config.ANCHOR_API_KEY), checkAnchorKey],
  ] as const) {
    if (!enabled) continue;
    try { await check(); checks.push({ name, ok: true, detail: "verified" }); }
    catch { checks.push({ name, ok: false, detail: "credential or provider request failed; check configuration" }); }
  }
}
for (const check of checks) console.log(`${check.ok ? "✓" : "○"} ${check.name}: ${check.detail}`);
console.log(live ? "Live credential checks requested. No sandbox or browser session was created." : "Local checks only. Add --live to verify configured provider credentials.");
if (!checks[0]?.ok || !checks[1]?.ok) process.exitCode = 1;
