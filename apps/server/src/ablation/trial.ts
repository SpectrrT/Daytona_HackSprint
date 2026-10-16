import { createHash } from "node:crypto";
import { passesAcceptance } from "../arena/tools.js";
import type { AgentInvocation, Candidate, EvaluationResult, FailureEvidence } from "@hollow-purple/shared/evolution";
import { buildBlue, searchRed } from "../agents/index.js";
import { evaluateCandidate } from "../lab/index.js";
import { retrieveContext, type Corpus, type MemoryMode } from "./memory.js";

export interface Trial {
  seed: number; mode: MemoryMode; status: "running" | "completed" | "missing"; error?: string;
  evaluations: { generation: number; completedAt?: number; result: EvaluationResult; blue: AgentInvocation; red: AgentInvocation; retrieval: { ids: string[]; bytes: number; path: string[] } }[];
  generationsUntilAllGates: number | null; regressionsReintroduced: number; wallMs: number;
}
export const publicPass = (result: EvaluationResult) => !result.buildError && result.checks.some(c => !c.hidden) && result.checks.filter(c => !c.hidden).every(c => c.passed);
export async function runTrial(input: { runId: string; seed: number; mode: MemoryMode; corpus: Corpus; generations: number; onEvaluation?: (trial: Trial) => Promise<void> }, dependencies = { buildBlue, searchRed, evaluateCandidate }): Promise<Trial> {
  const started = Date.now();
  const trial: Trial = { seed: input.seed, mode: input.mode, status: "running", evaluations: [], generationsUntilAllGates: null, regressionsReintroduced: 0, wallMs: 0 };
  const failures: FailureEvidence[] = []; let parent: Candidate | undefined;
  try {
    for (let generation = 0; generation < input.generations; generation++) {
      const id = `g${generation}`;
      const retrieval = await retrieveContext(input.corpus, input.mode, failures);
      const blue = await dependencies.buildBlue({ runId: input.runId, candidateId: id, contract: input.corpus.developmentRun.contract, parent, lessons: [], memoryContext: retrieval.items, failures, branch: 0, generation });
      const red = await dependencies.searchRed({ runId: input.runId, candidateId: id, contract: input.corpus.developmentRun.contract, candidate: blue, failures, round: generation, seed: input.seed, lessons: [], memoryContext: retrieval.items });
      const result = await dependencies.evaluateCandidate({ runId: input.runId, candidateId: id, source: blue.source, variant: "generated", provider: "daytona", seed: input.seed, regressions: [...input.corpus.failures, ...failures], attacks: red.attacks, suite: "ablation-exam" });
      if (result.backend !== "verilator" || result.source !== blue.source || result.sourceHash !== createHash("sha256").update(blue.source).digest("hex")) throw new Error("Evaluation source provenance differs from the executed Blue design.");
      trial.evaluations.push({ generation, completedAt: Date.now(), result, blue: blue.agent, red: red.agent, retrieval: { ids: retrieval.ids, bytes: retrieval.bytes, path: retrieval.path } });
      if (generation > 0) trial.regressionsReintroduced += result.checks.filter(c => /^regression-/.test(c.id) && !c.passed).length;
      const accepted = passesAcceptance(result, input.corpus.failures.length + failures.length, red.attacks.map(a => `agent-red-${a.id.replace(/^agent-red-/, "").toLowerCase()}`)) && result.checks.some(c => c.id === "transfer-empty-boundary" && c.hidden && c.passed);
      if (accepted && trial.generationsUntilAllGates === null) trial.generationsUntilAllGates = generation + 1;
      trial.wallMs = Date.now() - started;
      await input.onEvaluation?.(structuredClone(trial));
      // Selection and stopping use public evidence only. Hidden failures never cause another model call.
      if (publicPass(result)) break;
      if (result.failure?.reproduced) failures.push(result.failure);
      if (!result.failure?.reproduced && !result.buildError) break;
      parent = { id, parentId: parent?.id, generation, label: blue.label, variant: "generated", status: "failed", source: blue.source, sourceHash: result.sourceHash, checks: result.checks.filter(c => !c.hidden), failure: result.failure, buildError: result.buildError, lessons: [], cycles: result.cycles, score: 0, createdAt: Date.now() };
    }
  } catch (error) {
    trial.status = "missing";
    trial.error = error instanceof Error ? error.message.slice(0, 240) : "Trial failed without an evaluable result.";
  }
  trial.wallMs = Date.now() - started;
  if (trial.status !== "missing") trial.status = "completed";
  return trial;
}
