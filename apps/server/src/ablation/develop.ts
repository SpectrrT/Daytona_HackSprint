import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Candidate, EvaluationResult, EvolutionRun } from "@antibody/shared/evolution";
import { BUFFER_PROMPT } from "@antibody/shared/evolution";
import { config, REPO_ROOT } from "../config.js";
import { freezeContract } from "../engine/contract.js";
import { evaluateCandidate } from "../lab/index.js";
import { buildBlue } from "../agents/index.js";
import { configuredMemory } from "../memory/index.js";
import { failureFamily } from "../memory/graph.js";
import { passesAcceptance } from "../arena/tools.js";
import { digest, type Corpus } from "./memory.js";

const asCandidate = (id: string, generation: number, result: EvaluationResult, parentId?: string): Candidate => ({ id, parentId, generation, label: generation ? "Claude development repair" : "Manual single-bug development fixture", variant: "generated", status: result.failure ? "failed" : "verified", source: result.source, sourceHash: result.sourceHash, checks: result.checks, failure: result.failure, cycles: result.cycles, score: 0, lessons: [], createdAt: Date.now(), backend: result.backend, sandboxId: result.sandboxId, artifactPath: result.artifactPath });
/** Only simultaneous-family failures are released to development agents. Other gate failures abort freezing. */
export async function developCorpus(studyId: string, directory: string, maxGenerations = 2): Promise<Corpus> {
  const memory = configuredMemory(true); if (!memory) throw new Error("Development requires live SurrealDB graph memory.");
  await memory.backend.check();
  const run: EvolutionRun = { id: `${studyId}-dev`, prompt: BUFFER_PROMPT, contract: freezeContract(BUFFER_PROMPT, 0), provider: "daytona", strategy: "agents", status: "running", createdAt: Date.now(), candidates: [], regressions: [], events: [], budget: { maxCandidates: maxGenerations + 1, maxCycles: 2000000, usedCandidates: 0, usedCycles: 0 } };
  const source = await readFile(join(REPO_ROOT, "lab/fixtures/count-race.sv"), "utf8");
  const rootResult = await evaluateCandidate({ runId: run.id, candidateId: "dev0", source, variant: "generated", provider: "daytona", seed: 482901, regressions: [], suite: "development-simultaneous" });
  const root = asCandidate("dev0", 0, rootResult); run.candidates.push(root);
  if (!root.failure?.reproduced || failureFamily(root.failure) !== "simultaneous") throw new Error("Development fixture did not reproduce the declared training family.");
  run.regressions.push(root.failure);
  await memory.recordCandidate(run, root);
  await memory.recordBreach(run, root, root.failure);
  let parent = root; let validated = false;
  for (let generation = 1; generation <= maxGenerations; generation++) {
    const proposal = await buildBlue({ runId: run.id, candidateId: `dev${generation}`, contract: run.contract, parent, lessons: [], failures: run.regressions, branch: 0, generation });
    const result = await evaluateCandidate({ runId: run.id, candidateId: `dev${generation}`, source: proposal.source, variant: "generated", provider: "daytona", seed: 482901, regressions: run.regressions });
    const child = { ...asCandidate(`dev${generation}`, generation, result, parent.id), agent: proposal.agent }; run.candidates.push(child);
    await memory.recordCandidate(run, child);
    if (passesAcceptance(result, run.regressions.length)) { const lessons = await memory.validate(run, child, result, []); validated = lessons.length > 0; run.championId = child.id; break; }
    if (!result.failure?.reproduced || failureFamily(result.failure) !== "simultaneous") throw new Error("Development encountered another family or a build failure. Corpus was not frozen.");
    run.regressions.push(result.failure); await memory.recordBreach(run, child, result.failure); parent = child;
  }
  if (!validated) throw new Error("Development exhausted its budget without a validated lesson.");
  run.status = "completed"; run.finishedAt = Date.now();
  run.budget.usedCandidates = run.candidates.length; run.budget.usedCycles = run.candidates.reduce((n, c) => n + c.cycles, 0);
  const graph = await memory.snapshot(run);
  const body = { schemaVersion: 1 as const, model: config.BLUE_MODEL!, contractHash: run.contract.hash, trainingFamily: "simultaneous" as const, targetFamily: "empty_boundary" as const, frozenAt: new Date().toISOString(), developmentRun: run, graph, failures: run.regressions };
  const corpus = { ...body, corpusHash: digest(body) };
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, "corpus.json"), JSON.stringify(corpus, null, 2), { mode: 0o600 });
  return corpus;
}
