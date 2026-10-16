import type { Candidate, EvaluationResult, FailureEvidence } from "@antibody/shared/evolution";

/** One aggregate score is useful for branching, but never substitutes for acceptance. */
export function scoreEvaluation(result: EvaluationResult): number {
  if (!result.checks.length) return 0;
  return Math.round(100 * result.checks.filter((check) => check.passed).length / result.checks.length);
}
export function passesAcceptance(result: EvaluationResult, regressionCount = 0, attackIds: string[] = []): boolean {
  const requiredPublic = ["order", "simultaneous", "full-replace", "empty-concurrent", "reset-active", "red-seeded",
    ...Array.from({ length: regressionCount }, (_, index) => `regression-${index}`), ...attackIds];
  const checks = new Map(result.checks.map((check) => [check.id, check]));
  if (checks.size !== result.checks.length || result.failure || result.buildError) return false;
  if (!requiredPublic.every((id) => checks.has(id) && checks.get(id)!.hidden === false)) return false;
  if (checks.get("held-out")?.hidden !== true) return false;
  return result.checks.every((check) => check.passed);
}
export function bestCandidate(candidates: Candidate[]): Candidate | undefined {
  return [...candidates].sort((a, b) => b.score - a.score || a.cycles - b.cycles || a.id.localeCompare(b.id))[0];
}
export function lessonFor(failure: FailureEvidence): string {
  const name = failure.testName.toLowerCase();
  const edge = failure.sequence.at(-1);
  if (edge?.read && edge.write && failure.expected === null && failure.actual !== null) return "An empty FIFO cannot satisfy a read on the same edge as its first write. Derive read acceptance from pre-edge occupancy and enqueue the reading for a later edge.";
  if (edge?.reset) return "Reset must clear occupancy, pointers, output and read validity before any simultaneous request is considered.";
  if (/full|capacity/.test(name)) return "At full capacity, an accepted read frees a slot on the same edge; the matching write must be retained.";
  if (/simultaneous|concurrent/.test(name)) return "Derive accepted read and write from pre-edge occupancy, then update occupancy once for both operations.";
  return `Keep the verified ${failure.testName} sequence as a permanent regression and preserve the fixed FIFO contract.`;
}
