import { createHash } from "node:crypto";
import type { AgentInvocation, Candidate, EvolutionEvent, EvolutionRun, FailureEvidence } from "@hollow-purple/shared/evolution";
import { passesAcceptance } from "../arena/tools.js";
import { assertFrozenContract } from "../engine/contract.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const final = new Set(["verified", "failed", "rejected"]);
const directed = ["order", "simultaneous", "full-replace", "empty-concurrent", "reset-active"];

/** Strict, read-only reconstruction. Never use RunStore.load: it can stop runs or truncate logs. */
export function parseRunEvidence(text: string): EvolutionRun {
  let document: unknown;
  try { document = JSON.parse(text); } catch { /* A journal contains one object per line. */ }
  if (document && typeof document === "object" && "candidates" in document) {
    const run = document as EvolutionRun;
    if (!Array.isArray(run.candidates) || !Array.isArray(run.events) || !Array.isArray(run.regressions)) throw new Error("Incomplete run export.");
    assertFrozenContract(run.contract);
    return run;
  }
  const events = text.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line) as EvolutionEvent);
  const first = events[0];
  if (!first || first.type !== "run.created" || !first.payload) throw new Error("Journal requires a complete run.created event.");
  const run = structuredClone(first.payload) as EvolutionRun;
  run.events = events;
  for (const [index, event] of events.entries()) {
    if (event.seq !== index + 1 || event.runId !== run.id || !Number.isFinite(event.ts)) throw new Error("Journal sequence or run identity is invalid.");
    if (index && event.type === "run.created") throw new Error("Duplicate creation event.");
    if (event.type === "candidate.created") run.candidates.push(structuredClone(event.payload) as Candidate);
    if (event.type === "candidate.updated") {
      const candidate = event.payload as Candidate;
      const at = run.candidates.findIndex((item) => item.id === candidate.id);
      if (at < 0) throw new Error("Update refers to an unknown candidate.");
      run.candidates[at] = structuredClone(candidate);
    }
    if (event.type === "regression.added") {
      const failure = event.payload as FailureEvidence;
      if (!run.regressions.some((item) => item.id === failure.id)) run.regressions.push(structuredClone(failure));
    }
    if (event.type === "run.started") run.status = "running";
    if (event.type === "champion.selected") run.championId = event.candidateId;
    if (["run.completed", "run.failed", "run.stopped"].includes(event.type)) {
      run.status = event.type.slice(4) as EvolutionRun["status"];
      run.finishedAt = event.ts;
      if (run.status !== "completed") run.championId = undefined;
    }
  }
  assertFrozenContract(run.contract);
  if (new Set(run.candidates.map((item) => item.id)).size !== run.candidates.length) throw new Error("Duplicate candidate identity.");
  return run;
}

/** Aggregate provenance and observations without exposing prompts, source, traces or capabilities. */
export function summarizeRun(run: EvolutionRun) {
  assertFrozenContract(run.contract);
  const candidateEvents = run.events.filter((event) => event.type === "candidate.created" || event.type === "candidate.updated");
  const payload = (event: EvolutionEvent): Candidate | undefined => event.payload && typeof event.payload === "object" && Array.isArray((event.payload as Candidate).checks) ? event.payload as Candidate : undefined;
  const completeCandidateHistory = candidateEvents.length > 0 && candidateEvents.every((event) => !!payload(event));
  const snapshots = [...run.candidates, ...candidateEvents.flatMap((event) => payload(event) ? [payload(event)!] : [])];
  const calls = new Map<string, AgentInvocation>();
  const authored = new Map<string, number>();
  for (const candidate of snapshots) {
    for (const call of [candidate.agent, candidate.redAgent]) if (call) {
      const identity = `${candidate.id}:${call.role}:${call.startedAt ?? call.artifactPath ?? call.durationMs}`;
      calls.set(identity, call);
      if (call.role === "red") authored.set(identity, candidate.attacks?.length ?? 0);
    }
  }
  const evaluations = new Map<string, { candidate: Candidate; eventWindowMs: number | null }>();
  const pending = new Map<string, number>();
  for (const event of run.events) {
    if (event.type !== "candidate.updated") continue;
    const candidate = payload(event);
    if (!candidate) continue;
    if (candidate.status === "testing") pending.set(candidate.id, event.ts);
    if (!final.has(candidate.status) || !candidate.backend || !candidate.checks.length) continue;
    const key = `${candidate.id}:${candidate.cycles}:${candidate.sandboxId ?? "local"}:${candidate.redAgent?.startedAt ?? "fixture"}`;
    if (evaluations.has(key)) continue;
    const start = pending.get(candidate.id);
    evaluations.set(key, { candidate, eventWindowMs: start === undefined ? null : event.ts - start });
    pending.delete(candidate.id);
  }
  const lessonStates = new Map<string, string>();
  for (const event of run.events.filter((item) => item.type === "lesson.learned")) {
    const payload = event.payload as { memoryId?: string; status?: string } | undefined;
    if (payload?.memoryId && ["proposed", "validated"].includes(payload.status ?? "")) lessonStates.set(payload.memoryId, payload.status!);
  }
  const actualCalls = [...calls.values()];
  const hardware = [...evaluations.values()].filter(({ candidate }) => candidate.backend === "verilator");
  const successful = hardware.filter(({ candidate }) => !candidate.buildError);
  const champion = run.candidates.find((candidate) => candidate.id === run.championId);
  const ancestry: Candidate[] = [];
  if (champion) {
    let current: Candidate | undefined = champion;
    const seen = new Set<string>();
    while (current) {
      if (seen.has(current.id)) throw new Error("Candidate ancestry is cyclic.");
      seen.add(current.id); ancestry.unshift(current);
      if (!current.parentId) break;
      current = run.candidates.find((candidate) => candidate.id === current!.parentId);
      if (!current) throw new Error("Champion ancestry is incomplete.");
    }
  }
  const origin = ancestry.find((candidate) => candidate.checks.some((check) => !check.passed));
  const attacks = champion?.attacks?.map((attack) => `agent-red-${attack.id.replace(/^agent-red-/, "").toLowerCase()}`) ?? [];
  const acceptance = run.status === "completed" && run.provider === "daytona" && !!champion && champion.status === "verified" && champion.backend === "verilator" && !!champion.agent && attacks.length === 4 &&
    champion.sourceHash === sha(champion.source) && champion.regressionCount === run.regressions.length && passesAcceptance({
      ...champion, backend: "verilator", reproduced: !!champion.failure?.reproduced,
    }, run.regressions.length, attacks);
  return {
    schemaVersion: 1, runId: run.id, status: run.status, provider: run.provider,
    completeCandidateEventPayloads: completeCandidateHistory,
    provenance: run.verificationFixture ? "Imported manual faulty fixture with model-written repair children" : run.strategy === "curriculum" ? "Owned curriculum fixtures, not model-written designs" : "Agent experiment",
    wallMs: run.finishedAt === undefined ? null : run.finishedAt - run.createdAt,
    candidates: { total: run.candidates.length, modelWritten: run.candidates.filter((candidate) => !!candidate.agent).length, maximumRecordedGeneration: Math.max(0, ...run.candidates.map((candidate) => candidate.generation)) },
    repair: { verifiedModelWrittenChampion: acceptance, championId: champion?.id ?? null,
      ancestorId: origin?.id ?? null, failingAncestorChecks: origin?.checks.filter((check) => !check.passed).length ?? null,
      failingAncestorDirectedChecks: origin ? directed.filter((id) => origin.checks.some((check) => check.id === id && !check.passed)).length : null,
      championChecksPassed: champion?.checks.filter((check) => check.passed).length ?? null,
      repairEdges: acceptance && origin ? ancestry.length - 1 - ancestry.indexOf(origin) : null,
      completeCurrentRegressionsPassed: acceptance },
    coverage: {
      authoredRedSequences: [...authored.values()].reduce((a, b) => a + b, 0),
      completedHardwareEvaluationRecords: hardware.length,
      completedHardwareEvaluationsWithoutBuildError: successful.length,
      buildOrRuntimeRejections: hardware.filter(({ candidate }) => !!candidate.buildError).length,
      executedRedSequenceChecks: successful.reduce((sum, { candidate }) => sum + candidate.checks.filter((check) => check.id.startsWith("agent-red-")).length, 0),
      minimumSuccessfulSimulationBatches: successful.reduce((sum, { candidate }) => sum + 1 + Number(candidate.checks.some((check) => check.id === "reproduction")), 0),
      cyclesIncludingReplay: run.candidates.reduce((sum, candidate) => sum + candidate.cycles, 0),
      regressionsRetained: run.regressions.length,
      uniqueRetainedSequences: new Set(run.regressions.map((failure) => sha(JSON.stringify(failure.sequence)))).size,
      reproducedFailureEvents: run.events.filter((event) => event.type === "failure.reproduced").length,
      proposedLessonsStillPending: [...lessonStates.values()].filter((status) => status === "proposed").length,
      validatedLessonsInJournal: [...lessonStates.values()].filter((status) => status === "validated").length,
    },
    models: { completedBlueRedInvocations: actualCalls.length,
      durationMs: actualCalls.reduce((sum, call) => sum + call.durationMs, 0),
      observedInputTokens: actualCalls.reduce((sum, call) => sum + (call.inputTokens ?? 0), 0),
      observedOutputTokens: actualCalls.reduce((sum, call) => sum + (call.outputTokens ?? 0), 0),
      callsWithBothTokenCounts: actualCalls.filter((call) => call.inputTokens !== undefined && call.outputTokens !== undefined).length,
      recordedAdditionalAttempts: actualCalls.reduce((sum, call) => sum + Math.max(0, (call.attempts ?? 1) - 1), 0),
      callsMissingAttemptCounts: actualCalls.filter((call) => call.attempts === undefined).length,
      pricingDollars: null },
    evaluations: [...evaluations.values()].map(({ candidate, eventWindowMs }) => ({ candidateId: candidate.id, backend: candidate.backend, eventWindowMs })),
    limitations: ["Counts reflect retained records, not unrecorded failed attempts.", "Sanitized previews omit event payloads. Without completeCandidateEventPayloads, evaluation history, prior requalification calls and validated lessons may be unavailable; zero recorded events does not establish zero activity.", "Evaluation windows derive from testing/result event timestamps; they are not instrumented stage timings.", "Simulation batches are a lower bound; failed compiler/runtime attempts lack full process telemetry.", "Completed Blue/Red calls exclude lesson-writer calls not represented by full invocation metadata in the run journal.", "Token totals are observed subsets when usage fields are missing; dollar cost is unknown.", "Validated lesson counts come from journal transitions, not a fresh database audit.", "Seeded hidden checks are validation, not a one-time final exam.", "Repair edges follow champion ancestry; sibling candidates do not count as extra generations."],
  };
}
