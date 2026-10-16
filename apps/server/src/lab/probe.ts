import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO_ROOT } from "../config.js";
import { evaluateCandidate } from "./index.js";

try {
  const runId = `hardware-probe-${Date.now()}`;
  const source = await readFile(join(REPO_ROOT, "lab/probe_fifo.sv"), "utf8");
  const started = Date.now();
  const result = await evaluateCandidate({ runId, candidateId: "fifo-control", provider: "daytona", variant: "generated", source, seed: 301, regressions: [] });
  const passed = !result.buildError && result.checks.every((check) => check.passed);
  console.log(JSON.stringify({ runId, controlFixture: true, modelAuthored: false, passed, backend: result.backend, cycles: result.cycles,
    checks: result.checks.length, sandboxId: result.sandboxId, artifactPath: result.artifactPath, durationMs: Date.now() - started,
    buildError: result.buildError, sourceHash: result.sourceHash }));
  if (!passed) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : "Hardware integration probe failed.");
  process.exitCode = 1;
}
