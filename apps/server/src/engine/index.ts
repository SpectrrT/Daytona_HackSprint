import { createHash, randomUUID } from "node:crypto";
import type { Candidate, CandidateVariant, CreateRunRequest, EvaluationResult, EvolutionRun, FailureEvidence, RedAttack } from "@hollow-purple/shared/evolution";
import { BUFFER_PROMPT } from "@hollow-purple/shared/evolution";
import { bestCandidate, lessonFor, passesAcceptance, scoreEvaluation } from "../arena/tools.js";
import { StoppedError, throwIfStopped } from "../arena/types.js";
import { config } from "../config.js";
import { MAX_EVALUATION_CYCLES, candidateSource, evaluateCandidate } from "../lab/index.js";
import { type InitialRun, RunStore, TerminalRunError } from "../store.js";
import { assertFrozenContract, freezeContract } from "./contract.js";
import { buildBlue, searchRed } from "../agents/index.js";
import { validateRtl } from "../lab/validation.js";

export interface EvaluationRequest {
  runId: string; candidateId: string; variant: CandidateVariant; provider: "local" | "daytona";
  seed: number; regressions: FailureEvidence[]; signal?: AbortSignal;
  source?: string; attacks?: RedAttack[];
}
type Evaluator = (request: EvaluationRequest) => Promise<EvaluationResult>;
interface ActiveRun { controller: AbortController; task: Promise<void> }
const labels: Record<CandidateVariant, string> = {
  baseline: "Blue A · pointer baseline", "reset-leak": "Blue B · reset variant", "full-drop": "Blue C · full-buffer variant",
  "repair-count": "Blue child · speculative bypass", "repair-atomic": "Blue child · atomic acceptance",
  generated: "Blue agent design",
};
export interface AgentTeam { buildBlue: typeof buildBlue; searchRed: typeof searchRed }
export interface RepairVerificationInput {
  source: string;
  label: string;
  prompt: string;
  maxCandidates?: 3;
  seed?: number;
}

export class CapacityError extends Error {}

/** Bounded live Blue/Red orchestration, plus an explicit local curriculum preview. The independent lab supplies every measured verdict. */
export class EvolutionEngine {
  private readonly active = new Map<string, ActiveRun>();
  private demoTask?: Promise<EvolutionRun>;
  constructor(private readonly store: RunStore, private readonly evaluate: Evaluator = evaluateCandidate, private readonly agents: AgentTeam = { buildBlue, searchRed }) {}

  async start(request: CreateRunRequest, id: string = randomUUID()): Promise<string> {
    return this.startRun(request, id);
  }

  /** Internal integration-test entry point. Never exposed by the HTTP run API.
   * The imported faulty source is explicit evidence provenance, not model output.
   */
  async startRepairVerification(input: RepairVerificationInput): Promise<string> {
    if (input.maxCandidates !== undefined && input.maxCandidates !== 3) throw new Error("Repair verification requires exactly one imported fixture and two model-written children.");
    if (typeof input.label !== "string" || input.label.trim().length < 3 || input.label.trim().length > 120) throw new Error("Verification fixture label must contain 3–120 characters.");
    validateRtl(input.source);
    return this.startRun({ prompt: input.prompt, provider: "daytona", maxCandidates: 3, seed: input.seed }, randomUUID(), { ...input, label: input.label.trim() });
  }

  private async startRun(request: CreateRunRequest, id: string, verification?: RepairVerificationInput): Promise<string> {
    if (this.active.size >= config.MAX_CONCURRENT_RUNS) throw new CapacityError("Run capacity reached. Stop an active run or wait for it to finish.");
    const maxCandidates = request.maxCandidates ?? 5;
    if (!Number.isInteger(maxCandidates) || maxCandidates < 3 || maxCandidates > 12) throw new Error("maxCandidates must be an integer between 3 and 12.");
    const contract = freezeContract(request.prompt);
    const control: ActiveRun = { controller: new AbortController(), task: Promise.resolve() };
    this.active.set(id, control); // Reserve before the first await so simultaneous requests share the same limit.
    try {
      const initial: InitialRun = {
        id, prompt: request.prompt, provider: request.provider, status: "queued", contract,
        candidates: [], regressions: [], createdAt: Date.now(), strategy: request.provider === "daytona" ? "agents" : "curriculum", verificationFixture: verification ? true : undefined,
        budget: { maxCandidates, maxCycles: 2_000_000, usedCandidates: 0, usedCycles: 0 },
      };
      await this.store.create(initial);
      await this.store.emit(id, { type: "contract.frozen", message: `Contract frozen: SHA-256 ${contract.hash}. Blue may change designs, never requirements.`, payload: { hash: contract.hash, seed: request.seed ?? 42 } });
      control.task = this.run(id, request.seed ?? 42, control.controller.signal, verification).finally(() => this.active.delete(id));
      // run() records operational failures; retain a catch for a persistence outage too.
      void control.task.catch((error: unknown) => console.error(`[engine] ${id}:`, error instanceof Error ? error.message : "Run failed."));
      return id;
    } catch (error) { this.active.delete(id); throw error; }
  }

  async stop(id: string): Promise<void> {
    const run = this.store.get(id);
    if (!run) throw new Error("Unknown run.");
    if (["completed", "failed", "stopped"].includes(run.status)) return;
    this.active.get(id)?.controller.abort();
    try {
      await this.store.emit(id, { type: "run.stopped", message: "Stopped by the user. Existing candidates, failure evidence, and regressions are retained." });
    } catch (error) { if (!(error instanceof TerminalRunError)) throw error; }
  }
  async wait(id: string): Promise<EvolutionRun> {
    await this.active.get(id)?.task;
    const run = this.store.get(id);
    if (!run) throw new Error("Unknown run.");
    return run;
  }
  async stopAll(): Promise<void> {
    await Promise.all([...this.active.keys()].map((id) => this.stop(id)));
    await Promise.all([...this.active.values()].map((item) => item.task));
  }
  activeCount(): number { return this.active.size; }
  async demo(): Promise<EvolutionRun> {
    const existing = this.store.get("demo");
    if (existing?.status === "completed" && existing.contract.hash === freezeContract(BUFFER_PROMPT).hash) return existing;
    this.demoTask ??= (async () => {
      // A stopped prior preview is still useful evidence; a new UUID preserves its history.
      const id = existing ? randomUUID() : "demo";
      await this.start({ prompt: BUFFER_PROMPT, provider: "local", maxCandidates: 5, seed: 42 }, id);
      return this.wait(id);
    })().catch((error) => { this.demoTask = undefined; throw error; });
    return this.demoTask;
  }

  private async run(id: string, seed: number, signal: AbortSignal, verification?: RepairVerificationInput): Promise<void> {
    try {
      throwIfStopped(signal);
      if (this.store.get(id)!.provider === "daytona") { await this.runAgents(id, seed, signal, verification); return; }
      await this.store.emit(id, { type: "run.started", message: "Blue creates three RTL variants. Red searches boundary, reset, concurrency, and seeded long-run sequences; the independent verifier judges the frozen contract." });
      for (const variant of ["baseline", "reset-leak", "full-drop"] as const) {
        await this.evaluateOne(id, variant, 0, undefined, seed, signal);
      }
      let generation = 1;
      while (true) {
        throwIfStopped(signal);
        const run = this.store.get(id)!;
        const verified = run.candidates.filter((candidate) => candidate.status === "verified");
        if (verified.length) {
          const winner = bestCandidate(verified)!;
          await this.store.emit(id, { type: "champion.selected", candidateId: winner.id, message: `${winner.label} passed every required check, all inherited regressions, and hidden checks.`, payload: { score: winner.score, contractHash: run.contract.hash } });
          await this.store.emit(id, { type: "run.completed", message: `Verified improvement after ${run.candidates.length} candidates and ${run.budget.usedCycles.toLocaleString()} measured cycles. ${run.regressions.length} reproducible failure sequences are retained. Evidence is simulation coverage, not a formal proof.` });
          return;
        }
        if (run.candidates.length >= run.budget.maxCandidates || run.budget.usedCycles + MAX_EVALUATION_CYCLES > run.budget.maxCycles) {
          await this.store.emit(id, { type: "run.completed", message: "Compute budget exhausted without an accepted candidate. No champion was selected; all failure evidence is retained." });
          return;
        }
        const parent = bestCandidate(run.candidates.filter((candidate) => candidate.failure?.reproduced));
        if (!parent) {
          await this.store.emit(id, { type: "run.completed", message: "No independently reproduced failure was available to guide repair. No champion was selected." });
          return;
        }
        await this.store.emit(id, { type: "log", candidateId: parent.id, message: `Branch generation ${generation} from ${parent.label}. Both repair children inherit ${run.regressions.length} permanent regression sequences; Red changes the deterministic search seed.` });
        for (const variant of ["repair-count", "repair-atomic"] as const) {
          const current = this.store.get(id)!;
          if (current.candidates.length >= current.budget.maxCandidates || current.budget.usedCycles + MAX_EVALUATION_CYCLES > current.budget.maxCycles) break;
          await this.evaluateOne(id, variant, generation, parent, seed, signal);
        }
        generation++;
      }
    } catch (error) {
      const run = this.store.get(id);
      if (run && ["completed", "failed", "stopped"].includes(run.status)) return;
      try {
        if (signal.aborted || error instanceof StoppedError) {
          await this.store.emit(id, { type: "run.stopped", message: "Run stopped. Retained all completed evidence." });
        } else {
          await this.store.emit(id, { type: "run.failed", message: error instanceof Error ? error.message : "Unexpected execution failure." });
        }
      } catch (terminalError) {
        // Another terminal event may have been durably queued while this handler awaited I/O.
        if (!(terminalError instanceof TerminalRunError)) throw terminalError;
      }
    }
  }

  /** Actual model proposals and adversarial sequences. No template enters this path. */
  private async runAgents(id: string, seed: number, signal: AbortSignal, verification?: RepairVerificationInput): Promise<void> {
    if (Boolean(this.store.get(id)!.verificationFixture) !== Boolean(verification)) throw new Error("Verification fixture provenance does not match the run.");
    await this.store.emit(id, { type: "run.started", message: verification
      ? "Controlled repair integration verification: the initial source is an explicitly imported, manually fault-seeded fixture, NOT Blue-generated. Real Red agents attack it; Daytona reproduces its failure before Blue writes two genuine repair children."
      : "Blue and Red agents are live. Blue writes independent RTL implementations; Red reads each source and proposes concrete attacks. Daytona runs the RTL; the controller-owned verifier decides every verdict." });
    if (verification) {
      const candidate: Candidate = { id: "c1", generation: 0, label: verification.label, variant: "generated", status: "building", source: verification.source,
        rationale: "Fault-seeded integration fixture, NOT Blue-generated. Manually authored to verify the live repair path; all failure verdicts still require real independent simulation and replay.",
        checks: [], score: 0, lessons: [], cycles: 0, createdAt: Date.now(), sourceHash: createHash("sha256").update(verification.source).digest("hex") };
      await this.store.emit(id, { type: "candidate.created", candidateId: candidate.id, message: "Imported an explicitly labelled manual fault-seeded integration fixture. No Blue model invocation is claimed for this source.", payload: candidate });
      await this.challengeGenerated(id, candidate, seed, signal);
      if (!this.store.get(id)!.candidates.find((item) => item.id === candidate.id)?.failure?.reproduced) throw new Error("The imported verification fixture did not yield an independently reproduced failure. Repair verification cannot proceed without real evidence.");
    } else {
      for (let branch = 0; branch < 3; branch++) await this.generateAndEvaluate(id, 0, branch, undefined, seed, signal);
    }
    let generation = 1;
    let finalAudits = 0;
    while (true) {
      throwIfStopped(signal);
      const run = this.store.get(id)!;
      assertFrozenContract(run.contract);
      const parent = bestCandidate(run.candidates.filter((c) => c.failure?.reproduced || c.buildError));
      const winners = run.candidates.filter((c) => c.status === "verified" && c.regressionCount === run.regressions.length);
      const room = run.candidates.length < run.budget.maxCandidates && run.budget.usedCycles + MAX_EVALUATION_CYCLES <= run.budget.maxCycles;
      // A witnessed failure merits a repair generation, even if a sibling already passed.
      if (winners.length && !(generation === 1 && parent && room)) {
        const winner = bestCandidate(winners)!;
        await this.store.emit(id, { type: "champion.selected", candidateId: winner.id, message: `${winner.label}: actual generated RTL passed all directed, Red-agent, hidden, and ${run.regressions.length} retained regression checks.`, payload: { contractHash: run.contract.hash, sourceHash: winner.sourceHash, backend: winner.backend } });
        await this.store.emit(id, { type: "run.completed", message: verification
          ? `Controlled repair verification evaluated one imported manual fault-seeded fixture and ${run.candidates.filter((candidate) => candidate.agent).length} model-written children in Daytona over ${run.budget.usedCycles.toLocaleString()} measured cycles. ${run.regressions.length} independently reproduced regressions retained. An actual model-written child passed all current gates. Simulation evidence only; no formal proof claimed.`
          : `Live agent experiment verified ${run.candidates.length} model-written designs in Daytona over ${run.budget.usedCycles.toLocaleString()} measured cycles. ${run.regressions.length} independently reproduced regressions retained. Simulation evidence only; no formal proof claimed.` });
        return;
      }
      if (parent && room) {
        await this.store.emit(id, { type: "log", candidateId: parent.id, message: `Blue branches from ${parent.label} using its actual ${parent.buildError ? "build diagnostics" : "reproduced failure"}. Red receives the public lessons and searches again; hidden stimuli remain private.` });
        for (let branch = 0; branch < 2; branch++) {
          const current = this.store.get(id)!;
          if (current.candidates.length >= current.budget.maxCandidates || current.budget.usedCycles + MAX_EVALUATION_CYCLES > current.budget.maxCycles) break;
          await this.generateAndEvaluate(id, generation, branch, parent, seed, signal);
        }
        generation++;
        continue;
      }
      // An earlier pass cannot graduate without regressions discovered by later candidates.
      const staleWinner = bestCandidate(run.candidates.filter((c) => c.status === "verified" && c.regressionCount !== run.regressions.length));
      if (staleWinner && finalAudits < 2 && run.budget.usedCycles + MAX_EVALUATION_CYCLES <= run.budget.maxCycles) {
        finalAudits++;
        await this.store.emit(id, { type: "log", candidateId: staleWinner.id, message: "Requalifying an earlier passing design against the complete current regression library and a fresh Red search." });
        await this.challengeGenerated(id, staleWinner, seed + finalAudits * 65537, signal, finalAudits);
        continue;
      }
      await this.store.emit(id, { type: "run.completed", message: verification
        ? "Controlled repair verification evaluated an imported manual fault-seeded fixture and model-written repair children but found no candidate satisfying every current acceptance check. No champion was selected; the experiment did not verify a successful repair."
        : "The bounded live agent experiment finished without a candidate satisfying every current acceptance check. No champion was selected; generated source, attacks, failures, and diagnostics are retained." });
      return;
    }
  }

  private async generateAndEvaluate(id: string, generation: number, branch: number, parent: Candidate | undefined, seed: number, signal: AbortSignal): Promise<void> {
    throwIfStopped(signal);
    const run = this.store.get(id)!;
    assertFrozenContract(run.contract);
    const candidateId = `c${run.candidates.length + 1}`;
    let candidate: Candidate = { id: candidateId, parentId: parent?.id, generation, label: `Blue agent · design ${candidateId}`, variant: "generated", status: "building", source: "", checks: [], score: 0, lessons: [...new Set(run.candidates.flatMap((c) => c.lessons))], cycles: 0, createdAt: Date.now() };
    await this.store.emit(id, { type: "candidate.created", candidateId, message: parent ? `Blue is writing repaired child ${candidateId} from ${parent.id}.` : `Blue is writing independent design ${candidateId} from the frozen contract.`, payload: candidate });
    const proposal = await this.agents.buildBlue({ runId: id, candidateId, contract: run.contract, parent, lessons: candidate.lessons, failures: run.regressions, generation, branch, signal });
    throwIfStopped(signal);
    assertFrozenContract(this.store.get(id)!.contract);
    candidate = { ...candidate, label: proposal.label, source: proposal.source, rationale: proposal.rationale, agent: proposal.agent, sourceHash: createHash("sha256").update(proposal.source).digest("hex") };
    await this.store.emit(id, { type: "candidate.updated", candidateId, message: `Blue returned ${proposal.source.length.toLocaleString()} characters of new RTL in ${(proposal.agent.durationMs / 1000).toFixed(1)}s. ${proposal.rationale}`, payload: candidate });
    await this.challengeGenerated(id, candidate, seed, signal);
  }

  private async challengeGenerated(id: string, candidate: Candidate, seed: number, signal: AbortSignal, round = 0): Promise<void> {
    throwIfStopped(signal);
    const run = this.store.get(id)!;
    const red = await this.agents.searchRed({ runId: id, candidateId: candidate.id, contract: run.contract, candidate: { source: candidate.source, label: candidate.label }, failures: run.regressions, round, seed, signal });
    throwIfStopped(signal);
    candidate = { ...candidate, status: "testing", redAgent: red.agent, attacks: red.attacks, redRationale: red.rationale };
    await this.store.emit(id, { type: "candidate.updated", candidateId: candidate.id, message: `Red authored ${red.attacks.length} new attacks: ${red.rationale}. Executing actual RTL with Verilator in Daytona.`, payload: candidate });
    if (red.attacks.length !== 4) throw new Error("Red must submit four validated attacks before hardware acceptance is evaluated.");
    const attackIds = red.attacks.map((attack) => `agent-red-${attack.id.replace(/^agent-red-/, "").toLowerCase()}`);
    const result = await this.evaluate({ runId: id, candidateId: candidate.id, variant: "generated", source: candidate.source, attacks: red.attacks, provider: "daytona", seed: (seed + run.candidates.length * 7919) >>> 0, regressions: run.regressions, signal });
    throwIfStopped(signal);
    assertFrozenContract(this.store.get(id)!.contract);
    if (result.backend !== "verilator" || result.source !== candidate.source) throw new Error("Generated candidate evidence did not match the submitted RTL and required Verilator backend.");
    const submittedSourceHash = createHash("sha256").update(candidate.source).digest("hex");
    if (result.sourceHash !== submittedSourceHash) throw new Error("Independent lab source hash was missing or did not match the exact submitted RTL.");
    if (!Number.isSafeInteger(result.cycles) || result.cycles < 0 || result.cycles > MAX_EVALUATION_CYCLES) throw new Error("Invalid or unbounded hardware evaluation cycle count.");
    const accepted = passesAcceptance(result, run.regressions.length, attackIds);
    const reproduced = Boolean(result.failure?.reproduced && result.reproduced);
    const failure = result.failure ? { ...result.failure, reproduced } : undefined;
    const lesson = reproduced && failure ? lessonFor(failure) : result.buildError ? `Build rejected by the independent lab: ${result.buildError.slice(0, 1800)}` : undefined;
    candidate = { ...candidate, status: accepted ? "verified" : reproduced || result.buildError ? "failed" : "rejected", checks: result.checks, failure, buildError: result.buildError, score: scoreEvaluation(result), backend: result.backend, sandboxId: result.sandboxId, artifactPath: result.artifactPath, cycles: candidate.cycles + result.cycles, regressionCount: run.regressions.length, lessons: lesson ? [...new Set([...candidate.lessons, lesson])] : candidate.lessons };
    await this.store.emit(id, { type: "candidate.updated", candidateId: candidate.id, message: accepted ? `${candidate.label} passed all hardware, Red-agent and current regression gates.` : result.buildError ? `${candidate.label} failed to build: ${result.buildError}` : `${candidate.label} failed acceptance; no model's self-assessment is used as a verdict.`, payload: candidate });
    if (failure && reproduced) {
      await this.store.emit(id, { type: "failure.reproduced", candidateId: candidate.id, message: failure.summary, payload: failure });
      if (!this.store.get(id)!.regressions.some((item) => JSON.stringify(item.sequence) === JSON.stringify(failure.sequence))) await this.store.emit(id, { type: "regression.added", candidateId: candidate.id, message: `Verified failure retained permanently: ${failure.testName}.`, payload: failure });
    }
    if (lesson) await this.store.emit(id, { type: "lesson.learned", candidateId: candidate.id, message: lesson, payload: { lesson } });
  }

  private async evaluateOne(id: string, variant: CandidateVariant, generation: number, parent: Candidate | undefined, seed: number, signal: AbortSignal): Promise<void> {
    throwIfStopped(signal);
    let run = this.store.get(id)!;
    assertFrozenContract(run.contract);
    const candidateId = `c${run.candidates.length + 1}`;
    let candidate: Candidate = {
      id: candidateId, parentId: parent?.id, generation, label: labels[variant], variant, status: "building",
      source: candidateSource(variant), checks: [], score: 0, lessons: parent ? [...new Set(run.candidates.flatMap((item) => item.lessons))] : [], cycles: 0, createdAt: Date.now(),
    };
    await this.store.emit(id, { type: "candidate.created", candidateId, message: `Blue builds ${candidate.label}${parent ? ` from ${parent.id}` : " in an isolated candidate workspace"}.`, payload: candidate });
    throwIfStopped(signal);
    candidate = { ...candidate, status: "testing" };
    await this.store.emit(id, { type: "candidate.updated", candidateId, message: "Red runs directed attacks, inherited regressions, and hidden seeded checks. A fresh verifier reproduces discrepancies.", payload: candidate });
    const result = await this.evaluate({ runId: id, candidateId, variant, provider: run.provider, seed: (seed + run.candidates.length * 7919 + run.regressions.length * 104729) >>> 0, regressions: run.regressions, signal });
    throwIfStopped(signal);
    assertFrozenContract(this.store.get(id)!.contract);
    if (!Number.isSafeInteger(result.cycles) || result.cycles < 0 || result.cycles > MAX_EVALUATION_CYCLES) throw new Error("Verifier returned an invalid or unbounded cycle count.");
    const accepted = passesAcceptance(result, run.regressions.length);
    const reproduced = Boolean(result.failure?.reproduced && result.reproduced);
    const failure = result.failure ? { ...result.failure, reproduced } : undefined;
    const lesson = failure && reproduced ? lessonFor(failure) : undefined;
    candidate = {
      ...candidate, status: accepted ? "verified" : reproduced ? "failed" : "rejected", source: result.source,
      checks: result.checks, failure, score: scoreEvaluation(result), cycles: result.cycles,
      sandboxId: result.sandboxId, artifactPath: result.artifactPath, backend: result.backend,
      lessons: lesson ? [...new Set([...candidate.lessons, lesson])] : candidate.lessons,
    };
    await this.store.emit(id, { type: "candidate.updated", candidateId, message: accepted ? `${candidate.label} passed all checks.` : `${candidate.label} did not satisfy acceptance (${candidate.score}% of checks passed).`, payload: candidate });
    if (failure && reproduced) {
      await this.store.emit(id, { type: "failure.reproduced", candidateId, message: failure.summary, payload: failure });
      run = this.store.get(id)!;
      if (!run.regressions.some((item) => JSON.stringify(item.sequence) === JSON.stringify(failure.sequence))) {
        await this.store.emit(id, { type: "regression.added", candidateId, message: `Permanent regression: ${failure.testName}. All descendants must pass the exact replay.`, payload: failure });
      }
      await this.store.emit(id, { type: "lesson.learned", candidateId, message: lesson!, payload: { lesson } });
    } else if (result.failure) {
      await this.store.emit(id, { type: "log", candidateId, message: "Discrepancy was not independently reproduced. It is not promoted to a trusted regression." });
    }
  }
}
