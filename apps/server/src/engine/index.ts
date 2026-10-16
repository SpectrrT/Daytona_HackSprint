import { createHash, randomUUID } from "node:crypto";
import type { Candidate, CandidateVariant, CreateRunRequest, EvaluationResult, EvolutionRun, FailureEvidence, RedAttack } from "@antibody/shared/evolution";
import { BUFFER_PROMPT } from "@antibody/shared/evolution";
import { bestCandidate, lessonFor, passesAcceptance, scoreEvaluation } from "../arena/tools.js";
import { StoppedError, throwIfStopped } from "../arena/types.js";
import { config } from "../config.js";
import { MAX_EVALUATION_CYCLES, candidateSource, evaluateCandidate } from "../lab/index.js";
import { type InitialRun, RunStore, TerminalRunError } from "../store.js";
import { assertFrozenContract, freezeContract } from "./contract.js";
import { buildBlue, searchRed } from "../agents/index.js";
import { AgentCallError } from "../agents/codex.js";
import { validateRtl } from "../lab/validation.js";
import type { LessonMemory } from "../memory/graph.js";
import { traced } from "../telemetry/index.js";

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
export interface RecursiveDemoInput {
  source: string; label: string; prompt: string; seed?: number;
  maxCandidates?: number; maxEvaluations?: number; challengePasses?: number;
}

export class CapacityError extends Error {}

/** Bounded live Blue/Red orchestration, plus an explicit local curriculum preview. The independent lab supplies every measured verdict. */
export class EvolutionEngine {
  private readonly active = new Map<string, ActiveRun>();
  private demoTask?: Promise<EvolutionRun>;
  constructor(private readonly store: RunStore, private readonly evaluate: Evaluator = evaluateCandidate, private readonly agents: AgentTeam = { buildBlue, searchRed }, readonly memory?: LessonMemory) {}

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

  /** Imported starting work, genuine model repairs, then fresh attacks on each pass. */
  async startRecursiveDemo(input: RecursiveDemoInput): Promise<string> {
    validateRtl(input.source);
    if (!input.label.trim() || input.label.length > 120) throw new Error("Give the imported starter a clear label of at most 120 characters.");
    const maxEvaluations = input.maxEvaluations ?? 8;
    const challengePasses = input.challengePasses ?? 2;
    if (!Number.isInteger(maxEvaluations) || maxEvaluations < 3 || maxEvaluations > 24) throw new Error("Recursive evaluation budget must be 3 to 24.");
    if (!Number.isInteger(challengePasses) || challengePasses < 1 || challengePasses > 4 || challengePasses + 2 > maxEvaluations) throw new Error("Reserve a starter, repair and 1 to 4 fresh passing audits.");
    const fixture = { source: input.source, label: input.label, prompt: input.prompt, seed: input.seed };
    return this.startRun({ prompt: input.prompt, provider: "daytona", maxCandidates: input.maxCandidates ?? 5, seed: input.seed }, randomUUID(), fixture, { maxEvaluations, challengePasses });
  }

  private async startRun(request: CreateRunRequest, id: string, verification?: RepairVerificationInput, recursive?: NonNullable<EvolutionRun["recursive"]>): Promise<string> {
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
        recursive,
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
    return traced("run", id, {}, () => this.runUntraced(id, seed, signal, verification), () => {
      const run = this.store.get(id)!;
      return { "hollow.run_status": run.status, "hollow.regressions": run.regressions.length, "hollow.cycles": run.budget.usedCycles };
    });
  }
  private async runUntraced(id: string, seed: number, signal: AbortSignal, verification?: RepairVerificationInput): Promise<void> {
    try {
      throwIfStopped(signal);
      if (this.store.get(id)!.recursive) { await this.runRecursive(id, seed, signal, verification!); return; }
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

  private async runRecursive(id: string, seed: number, signal: AbortSignal, fixture: RepairVerificationInput): Promise<void> {
    const options = this.store.get(id)!.recursive!;
    await this.store.emit(id, { type: "run.started", message: "Recursive engineering demo: imported manual starter, genuine Blue repair descendants, and fresh Red searches after each passing design. The independent verifier and contract stay fixed." });
    const root: Candidate = { id: "c1", generation: 0, label: fixture.label, variant: "generated", status: "building", source: fixture.source,
      rationale: "Imported manual faulty starter, NOT Blue-generated. All subsequent repairs require actual Blue model calls and Daytona execution.",
      checks: [], score: 0, lessons: [], cycles: 0, createdAt: Date.now(), sourceHash: createHash("sha256").update(fixture.source).digest("hex") };
    await this.store.emit(id, { type: "candidate.created", candidateId: root.id, message: root.rationale!, payload: root });
    await this.challengeGenerated(id, root, seed, signal, 0, "c1-e0");
    if (!this.store.get(id)!.candidates[0]!.failure?.reproduced) throw new Error("The starter did not produce a reproduced failure. No repair or improvement will be fabricated.");
    let evaluations = 1, currentId = root.id, passedAudits = 0;
    while (evaluations < options.maxEvaluations) {
      throwIfStopped(signal);
      const run = this.store.get(id)!;
      assertFrozenContract(run.contract);
      const current = run.candidates.find((candidate) => candidate.id === currentId)!;
      if (run.budget.usedCycles + MAX_EVALUATION_CYCLES > run.budget.maxCycles) break;
      if (current.failure?.reproduced || current.buildError) {
        if (run.candidates.length >= run.budget.maxCandidates) break;
        await this.store.emit(id, { type: "log", candidateId: current.id, message: `Recursive repair: generation ${current.generation + 1} inherits all ${run.regressions.length} confirmed regressions from ${current.id}.` });
        await this.generateAndEvaluate(id, current.generation + 1, 0, current, seed + evaluations * 104729, signal);
        currentId = this.store.get(id)!.candidates.at(-1)!.id;
        passedAudits = 0;
      } else if (current.status === "verified") {
        await this.store.emit(id, { type: "log", candidateId: current.id, message: `Fresh Red audit ${passedAudits + 1}/${options.challengePasses}: attack the passing design again before declaring success. No new generation is claimed for an unchanged design.` });
        await this.challengeGenerated(id, current, seed + evaluations * 104729, signal, evaluations, `${current.id}-e${evaluations}`, true);
        const audited = this.store.get(id)!.candidates.find((candidate) => candidate.id === currentId)!;
        passedAudits = audited.status === "verified" ? passedAudits + 1 : 0;
      } else {
        await this.store.emit(id, { type: "log", candidateId: current.id, message: "No reproduced public failure or compiler feedback is available. Hidden-check outcomes cannot be turned into invented repair evidence." });
        break;
      }
      evaluations++;
      const after = this.store.get(id)!;
      const candidate = after.candidates.find((item) => item.id === currentId)!;
      if (candidate.status === "verified" && candidate.regressionCount === after.regressions.length && passedAudits >= options.challengePasses) {
        await this.store.emit(id, { type: "champion.selected", candidateId: candidate.id, message: `Model-written generation ${candidate.generation} passed every gate, all ${after.regressions.length} retained regressions and ${passedAudits} fresh Red audits.`, payload: { sourceHash: candidate.sourceHash, backend: candidate.backend, contractHash: after.contract.hash } });
        await this.store.emit(id, { type: "run.completed", message: `Recursive demo completed: one imported starter, ${after.candidates.filter((item) => item.agent).length} genuine model-written descendants, ${evaluations} Daytona evaluations, ${after.regressions.length} retained regressions and ${passedAudits} fresh passing Red audits. Simulation coverage only, not formal proof.` });
        return;
      }
    }
    await this.store.emit(id, { type: "run.completed", message: `Recursive budget or available public evidence exhausted after ${evaluations} evaluations. No design completed the required fresh passing audits; no champion selected.` });
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

  /**
   * A declined or timed-out model call for one design rejects that design instead of failing the run: a design
   * Red could not challenge is never accepted, and the remaining designs continue to be built and attacked.
   */
  private async rejectUnchallenged(id: string, candidate: Candidate, role: "blue" | "red", error: AgentCallError): Promise<void> {
    const why = error.failureCategory === "content_policy" ? "the model provider declined the request under its content policy" : "the model call exceeded its time budget";
    const rejected: Candidate = {
      ...candidate,
      status: "rejected",
      ...(role === "red" ? { redRationale: `Red could not challenge this design: ${why}. An unchallenged design is never accepted.` } : { rationale: `Blue produced no design: ${why}.` }),
    };
    await this.store.emit(id, {
      type: "candidate.updated",
      candidateId: candidate.id,
      message: role === "red"
        ? `Red could not challenge ${candidate.label}: ${why}. The design is rejected rather than accepted unchallenged; the run continues.`
        : `Blue could not write ${candidate.id}: ${why}. The run continues with the remaining budget.`,
      payload: rejected,
    });
  }

  private async generateAndEvaluate(id: string, generation: number, branch: number, parent: Candidate | undefined, seed: number, signal: AbortSignal): Promise<void> {
    throwIfStopped(signal);
    const run = this.store.get(id)!;
    assertFrozenContract(run.contract);
    const candidateId = `c${run.candidates.length + 1}`;
    let candidate: Candidate = { id: candidateId, parentId: parent?.id, generation, label: `Blue agent · design ${candidateId}`, variant: "generated", status: "building", source: "", checks: [], score: 0, lessons: config.MEMORY_MODE === "none" || config.MEMORY_MODE === "flat" ? [] : this.memory ? (await this.memory.retrieve(run, undefined, signal)).map((lesson) => lesson.text!) : [...new Set(run.candidates.flatMap((c) => c.lessons))], cycles: 0, createdAt: Date.now() };
    await this.store.emit(id, { type: "candidate.created", candidateId, message: parent ? `Blue is writing repaired child ${candidateId} from ${parent.id}.` : `Blue is writing independent design ${candidateId} from the frozen contract.`, payload: candidate });
    let proposal: Awaited<ReturnType<AgentTeam["buildBlue"]>>;
    try {
      proposal = await this.agents.buildBlue({ runId: id, candidateId, contract: run.contract, parent, lessons: candidate.lessons, failures: run.regressions, generation, branch, signal });
    } catch (error) {
      if (!recoverableAgentFailure(error)) throw error;
      await this.rejectUnchallenged(id, candidate, "blue", error);
      return;
    }
    throwIfStopped(signal);
    assertFrozenContract(this.store.get(id)!.contract);
    candidate = { ...candidate, label: proposal.label, source: proposal.source, rationale: proposal.rationale, agent: proposal.agent, sourceHash: createHash("sha256").update(proposal.source).digest("hex") };
    await this.store.emit(id, { type: "candidate.updated", candidateId, message: `Blue returned ${proposal.source.length.toLocaleString()} characters of new RTL in ${(proposal.agent.durationMs / 1000).toFixed(1)}s. ${proposal.rationale}`, payload: candidate });
    try {
      await this.challengeGenerated(id, candidate, seed, signal);
    } catch (error) {
      if (!recoverableAgentFailure(error)) throw error;
      await this.rejectUnchallenged(id, candidate, "red", error);
    }
  }

  private async challengeGenerated(id: string, candidate: Candidate, seed: number, signal: AbortSignal, round = 0, executionId?: string, adaptive = false): Promise<void> {
    throwIfStopped(signal);
    const run = this.store.get(id)!;
    await this.memory?.recordCandidate(run, candidate, signal);
    const validatedLessons = this.memory ? (await this.memory.retrieve(run, undefined, signal)).map((lesson) => lesson.text!) : [];
    const history = new Map<string, RedAttack>();
    if (adaptive) for (const event of run.events) {
      const prior = event.type === "candidate.updated" && event.candidateId === candidate.id ? event.payload as Candidate : undefined;
      for (const attack of prior?.attacks ?? []) history.set(JSON.stringify(attack.sequence), attack);
    }
    const red = await this.agents.searchRed({ lessons: validatedLessons, priorAttacks: adaptive ? [...history.values()].slice(-8) : undefined, runId: id, candidateId: candidate.id, contract: run.contract, candidate: { source: candidate.source, label: candidate.label }, failures: run.regressions, round, seed, signal });
    throwIfStopped(signal);
    if (adaptive) {
      if (red.attacks.some((attack) => history.has(JSON.stringify(attack.sequence)))) throw new Error("Red repeated a previous sequence during a required fresh audit. No fresh-audit credit is awarded.");
    }
    candidate = { ...candidate, status: "testing", redAgent: red.agent, attacks: red.attacks, redRationale: red.rationale };
    await this.store.emit(id, { type: "candidate.updated", candidateId: candidate.id, message: `Red authored ${red.attacks.length} new attacks: ${red.rationale}. Executing actual RTL with Verilator in Daytona.`, payload: candidate });
    if (red.attacks.length !== 4) throw new Error("Red must submit four validated attacks before hardware acceptance is evaluated.");
    const attackIds = red.attacks.map((attack) => `agent-red-${attack.id.replace(/^agent-red-/, "").toLowerCase()}`);
    const result = await this.evaluate({ runId: id, candidateId: executionId ?? candidate.id, variant: "generated", source: candidate.source, attacks: red.attacks, provider: "daytona", seed: (seed + run.candidates.length * 7919) >>> 0, regressions: run.regressions, signal });
    throwIfStopped(signal);
    assertFrozenContract(this.store.get(id)!.contract);
    if (result.backend !== "verilator" || result.source !== candidate.source) throw new Error("Generated candidate evidence did not match the submitted RTL and required Verilator backend.");
    const submittedSourceHash = createHash("sha256").update(candidate.source).digest("hex");
    if (result.sourceHash !== submittedSourceHash) throw new Error("Independent lab source hash was missing or did not match the exact submitted RTL.");
    if (!Number.isSafeInteger(result.cycles) || result.cycles < 0 || result.cycles > MAX_EVALUATION_CYCLES) throw new Error("Invalid or unbounded hardware evaluation cycle count.");
    const accepted = passesAcceptance(result, run.regressions.length, attackIds);
    const reproduced = Boolean(result.failure?.reproduced && result.reproduced);
    const failure = result.failure ? { ...result.failure, reproduced } : undefined;
    const lesson = config.MEMORY_MODE === "graph" && !this.memory && reproduced && failure ? lessonFor(failure) : result.buildError ? `Build rejected by the independent lab: ${result.buildError.slice(0, 1800)}` : undefined;
    candidate = { ...candidate, status: accepted ? "verified" : reproduced || result.buildError ? "failed" : "rejected", checks: result.checks, failure, buildError: result.buildError, score: scoreEvaluation(result), backend: result.backend, sandboxId: result.sandboxId, artifactPath: result.artifactPath, cycles: candidate.cycles + result.cycles, regressionCount: run.regressions.length, lessons: lesson ? [...new Set([...candidate.lessons, lesson])] : candidate.lessons };
    await this.store.emit(id, { type: "candidate.updated", candidateId: candidate.id, message: accepted ? `${candidate.label} passed all hardware, Red-agent and current regression gates.` : result.buildError ? `${candidate.label} failed to build: ${result.buildError}` : `${candidate.label} failed acceptance; no model's self-assessment is used as a verdict.`, payload: candidate });
    if (failure && reproduced) {
      await this.store.emit(id, { type: "failure.reproduced", candidateId: candidate.id, message: failure.summary, payload: failure });
      if (!this.store.get(id)!.regressions.some((item) => JSON.stringify(item.sequence) === JSON.stringify(failure.sequence))) await this.store.emit(id, { type: "regression.added", candidateId: candidate.id, message: `Verified failure retained permanently: ${failure.testName}.`, payload: failure });
    }
    if (this.memory && failure && reproduced) {
      const current = this.store.get(id)!;
      const proposal = await this.memory.recordBreach(current, candidate, failure, signal);
      await this.store.emit(id, { type: "lesson.learned", candidateId: candidate.id, message: `Blue proposed a lesson on ${proposal.family}. Pending descendant validation: ${proposal.text}`, payload: { lesson: proposal.text, status: proposal.status, family: proposal.family, memoryId: proposal.id } });
    }
    if (this.memory && accepted) {
      const validated = await this.memory.validate(this.store.get(id)!, candidate, result, attackIds, signal);
      if (validated.length) {
        candidate = { ...candidate, lessons: [...new Set([...candidate.lessons, ...validated.map((item) => item.text!)])] };
        await this.store.emit(id, { type: "candidate.updated", candidateId: candidate.id, message: `Validated ${validated.length} Blue lessons against the complete acceptance and inherited regression suite.`, payload: candidate });
        for (const item of validated) await this.store.emit(id, { type: "lesson.learned", candidateId: candidate.id, message: `Validated parent-family lesson: ${item.text}`, payload: { lesson: item.text, status: "validated", family: item.family, memoryId: item.id } });
      }
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

function recoverableAgentFailure(error: unknown): error is AgentCallError {
  return error instanceof AgentCallError && (error.reason === "timeout" || error.failureCategory === "content_policy");
}
