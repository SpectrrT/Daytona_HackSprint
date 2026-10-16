import type { SoftwareCandidate, SoftwareCheck, SoftwareRun } from "./software.js";

export type CheckOutcome = "passed" | "failed" | "unmeasured";
export interface CheckCounts { passed: number; failed: number; total: number }
export interface CandidateProgress extends CheckCounts {
  id: string;
  label: string;
  parentId?: string;
  at: number | null;
  regressions: { id: string; name: string; outcome: CheckOutcome }[];
  remaining: number | null;
}
export interface VerificationPoint extends CheckCounts { at: number }
export interface SoftwareProgress {
  candidates: CandidateProgress[];
  timeline: VerificationPoint[];
  historicalTiming: boolean;
  untimedResults: number;
}
export const DIRECTED_CHECKS = [
  ["purchase-and-price", "Receipt and price"],
  ["sequential-retries", "Repeated purchases"],
  ["changed-retry", "Changed purchase reference"],
  ["stock-exhaustion-and-retry", "Retry after stock exhaustion"],
  ["invalid-inputs-have-no-effects", "Invalid inputs leave no effects"],
  ["six-concurrent-duplicates", "Six simultaneous repeats"],
  ["concurrent-last-stock", "Competing for the last stock"],
] as const;

export function countChecks(checks: readonly SoftwareCheck[]): CheckCounts {
  const passed = checks.filter(check => check.passed).length;
  return { passed, failed: checks.length - passed, total: checks.length };
}

/** A failed execution remains visible even if the same immutable version later passes a retry. */
export function checkOutcome(checks: readonly SoftwareCheck[]): CheckOutcome {
  return checks.length ? checks.every(check => check.passed) ? "passed" : "failed" : "unmeasured";
}

function verdictTime(run: SoftwareRun, candidate: SoftwareCandidate): number | null {
  const valid = (at: number | undefined): at is number => Number.isFinite(at) && at! >= run.createdAt && (!run.finishedAt || at! <= run.finishedAt);
  if (valid(candidate.evaluatedAt)) return candidate.evaluatedAt;
  // Older runs saved whole-candidate verdict timestamps, not individual check timestamps.
  // Match only the controller's exact recorded message; never interpolate check times.
  const counts = countChecks(candidate.checks);
  const verdict = `${candidate.label}: ${candidate.status}; ${counts.passed}/${counts.total} checks passed.`;
  const events = run.events.filter(event => event.candidateId === candidate.id && valid(event.at));
  const explicit = events.filter(event => event.message === verdict).at(-1);
  if (explicit) return explicit.at;
  if (candidate.importedFixture) {
    const findings = run.regressions.filter(failure => failure.reproduced && failure.discovery.ledger.sourceHash === candidate.sourceHash);
    return events.filter(event => findings.some(failure => event.message === `Independent replay reproduced ${failure.summary}`)).at(-1)?.at ?? null;
  }
  return null;
}

/** Reporting only. The execution verifier remains the sole owner of pass/fail decisions. */
export function softwareProgress(run: SoftwareRun): SoftwareProgress {
  const knownFailures = run.regressions.filter(failure => failure.reproduced);
  const candidates = run.candidates.map((candidate): CandidateProgress => {
    const regressions = knownFailures.map(failure => {
      const checks = candidate.checks.filter(check => check.id === `regression-${failure.id}`);
      const foundHere = failure.discovery.ledger.sourceHash === candidate.sourceHash;
      return { id: failure.id, name: failure.discovery.attack.name, outcome: foundHere ? "failed" as const : checkOutcome(checks) };
    });
    return { id: candidate.id, label: candidate.label, parentId: candidate.parentId, at: verdictTime(run, candidate), ...countChecks(candidate.checks), regressions,
      remaining: !regressions.length || regressions.some(result => result.outcome === "unmeasured") ? null : regressions.filter(result => result.outcome === "failed").length };
  });
  const records: { at: number; passed: boolean }[] = [];
  let historicalTiming = false, untimedResults = 0;
  for (const candidate of run.candidates) {
    const fallback = candidates.find(point => point.id === candidate.id)!.at;
    for (const check of candidate.checks) {
      const exact = check.recordedAt !== undefined && Number.isFinite(check.recordedAt) && check.recordedAt >= run.createdAt && (!run.finishedAt || check.recordedAt <= run.finishedAt);
      const at = exact ? check.recordedAt! : fallback;
      if (at === null) { untimedResults++; continue; }
      if (!exact) historicalTiming = true;
      records.push({ at, passed: check.passed });
    }
  }
  records.sort((a, b) => a.at - b.at);
  const timeline: VerificationPoint[] = [{ at: run.createdAt, passed: 0, failed: 0, total: 0 }];
  for (const record of records) {
    const previous = timeline.at(-1)!;
    const point = { at: record.at, passed: previous.passed + Number(record.passed), failed: previous.failed + Number(!record.passed), total: previous.total + 1 };
    if (previous.at === point.at) timeline[timeline.length - 1] = point;
    else timeline.push(point);
  }
  return { candidates, timeline, historicalTiming, untimedResults };
}
