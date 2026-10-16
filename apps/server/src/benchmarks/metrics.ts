import type { EvaluationResult } from "@antibody/shared/evolution";

export interface Measurement {
  id: string;
  defective: boolean;
  wallMs: number;
  result?: EvaluationResult;
  error?: string;
  attackIds: string[];
  model?: { provider: string; model: string; durationMs: number; attempts?: number };
}
const normalized = (id: string) => `agent-red-${id.replace(/^agent-red-/, "").toLowerCase()}`;
export const benchmarkCandidateId = (fixtureId: string, batch: string) => `${fixtureId}-${batch}`;
export function summarize(rows: Measurement[], expectedMutants: number, expectedControls: number) {
  const compiled = (row: Measurement) => !!row.result && !row.result.buildError && row.result.backend === "verilator";
  const witnessed = (row: Measurement) => compiled(row) && !!row.result!.failure?.reproduced &&
    row.result!.reproduced && row.attackIds.map(normalized).includes(row.result!.failure!.testId);
  const clean = (row: Measurement) => compiled(row) && !row.result!.failure && row.result!.checks.length > 0 && row.result!.checks.every((check) => check.passed);
  const controls = rows.filter((row) => !row.defective);
  const fixedIds = new Set(["order", "simultaneous", "full-replace", "empty-concurrent", "reset-active", "red-seeded"]);
  const fixedFailed = (row: Measurement) => compiled(row) && row.result!.checks.some((check) => fixedIds.has(check.id) && !check.passed);
  const fixedPassed = (row: Measurement) => compiled(row) && [...fixedIds].every((id) => row.result!.checks.some((check) => check.id === id && check.passed));
  return {
    plannedMutants: expectedMutants,
    plannedControls: expectedControls,
    completedEvaluations: rows.filter(compiled).length,
    infrastructureErrors: rows.filter((row) => !row.result).length,
    buildErrors: rows.filter((row) => !!row.result?.buildError).length,
    witnessedMutants: rows.filter((row) => row.defective && witnessed(row)).length,
    mutantsFailingFixedPublicChecks: rows.filter((row) => row.defective && fixedFailed(row)).length,
    authoredDiscoveriesBeyondFixedPublicChecks: rows.filter((row) => row.defective && witnessed(row) && fixedPassed(row)).length,
    mutantsMissedByAuthoredSequences: rows.filter((row) => row.defective && compiled(row) && !witnessed(row)).length,
    controlsPassed: controls.filter(clean).length,
    reproducedControlViolations: controls.filter(witnessed).length,
    controlClaimAvailable: controls.length === expectedControls && controls.every(clean),
    coverage: {
      authoredSequences: rows.reduce((n, row) => n + row.attackIds.length, 0),
      simulatedCyclesIncludingReplay: rows.reduce((n, row) => n + (row.result?.cycles ?? 0), 0),
      reproducedCounterexamples: rows.filter((row) => !!row.result?.failure?.reproduced).length,
    },
  };
}

/** One worker owns each item; failures cannot silently disappear from denominators. */
export async function boundedMap<T, R>(items: T[], concurrency: number, run: (item: T, index: number) => Promise<R>): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new Error("Benchmark concurrency must be 1 to 4.");
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await run(items[index]!, index);
    }
  }));
  return results;
}

export function pairedTiming(serial: Measurement[], parallel: Measurement[], serialMs: number, parallelMs: number) {
  const signature = (row: Measurement) => row.result && !row.result.buildError ? JSON.stringify({
    hash: row.result.sourceHash, checks: row.result.checks.map(({ id, passed }) => [id, passed]),
    failure: row.result.failure ? [row.result.failure.testId, row.result.failure.cycle, row.result.failure.summary, row.result.failure.reproduced] : null,
  }) : undefined;
  const valid = serial.length > 0 && serial.length === parallel.length && serial.every((row, i) =>
    row.id === parallel[i]!.id && signature(row) !== undefined && signature(row) === signature(parallel[i]!));
  return { valid, serialMs, parallelMs, speedup: valid && parallelMs > 0 ? serialMs / parallelMs : null };
}
