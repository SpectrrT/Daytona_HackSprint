import type { LabRun } from "./agent-lab.js";

export type DemoRole = "blue" | "red" | "verifier";

/** Shared infrastructure events identify actual newly provisioned sandboxes in every panel. */
export function panelReceives(role: DemoRole, message: string): boolean {
  if (/^(Daytona:|Anchor: connected|Frozen |Terminal:)/i.test(message)) return true;
  if (role === "blue") return /^Blue\b/i.test(message);
  if (role === "red") return /^(Red\b|Anchor is testing)/i.test(message);
  return /^(Fresh-process|Replaying inherited|The verifier|Independent verifier|Verifying useful|Selected |SUCCESS:)/i.test(message);
}

/** A status label alone cannot produce a successful verdict. */
export function demoVerdict(run: LabRun) {
  const candidate = run.candidates.find(item => item.id === run.championId);
  const success = run.status === "completed" && !!candidate?.blueAgent && !candidate.importedFixture
    && candidate.status === "verified" && candidate.checks.length > 0 && candidate.checks.every(check => check.passed);
  const checks = candidate?.checks ?? [];
  const count = (selected: typeof checks) => ({ passed: selected.filter(check => check.passed).length, total: selected.length });
  return {
    status: success ? "success" : run.status === "completed" ? "inconsistent" : run.status,
    candidate: success ? candidate.id : null,
    checks: count(checks),
    regressions: count(checks.filter(check => check.id.startsWith("regression-"))),
    newAttacks: count(checks.filter(check => check.id.startsWith("adapted-"))),
    directed: count(checks.filter(check => check.kind === "tool-gate" && !check.hidden)),
    heldout: count(checks.filter(check => check.hidden)),
    useful: count(checks.filter(check => check.kind === "utility")),
    reproducedFailures: run.failures.length,
    repairGenerations: run.candidates.filter(item => !!item.blueAgent).length,
  };
}
