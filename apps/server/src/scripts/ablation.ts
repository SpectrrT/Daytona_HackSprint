import { rowsFromTrials, writeTimeseries } from "../charts/series.js";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { config, REPO_ROOT } from "../config.js";
import { requireHardwareSnapshot } from "../daytona/client.js";
import { developCorpus } from "../ablation/develop.js";
import { armOrder, assertCorpus, digest, MODES, RETRIEVAL_K, RETRIEVAL_TOKEN_BUDGET, type Corpus } from "../ablation/memory.js";
import { runTrial, type Trial } from "../ablation/trial.js";
import { summarizeTrials, formatMetrics } from "../ablation/metrics.js";
import { flushTelemetry, telemetryStatus, traced } from "../telemetry/index.js";
import { buildTests } from "../lab/tests.js";

const args = process.argv.slice(2);
const option = (key: string) => { const i = args.indexOf(key); return i >= 0 ? args[i + 1] : undefined; };
const seedsCount = Number(option("--seeds") ?? 3); const generations = Number(option("--generations") ?? 2);
const developmentGenerations = Number(option("--development-generations") ?? 2);
if (!Number.isInteger(developmentGenerations) || developmentGenerations < 1 || developmentGenerations > 4) throw new Error("Use 1 to 4 development generations.");
if (!Number.isInteger(seedsCount) || seedsCount < 1 || seedsCount > 20 || !Number.isInteger(generations) || generations < 1 || generations > 4) throw new Error("Use 1 to 20 seeds and 1 to 4 generations.");
if (!["bedrock", "anthropic"].includes(config.AGENT_PROVIDER) || !config.BLUE_MODEL || config.BLUE_MODEL !== config.RED_MODEL || !/claude/i.test(config.BLUE_MODEL)) throw new Error("Ablation requires the same explicit Claude model for Blue and Red. No provider fallback is allowed.");
const runId = `abl-${randomUUID()}`; const directory = join(config.DATA_DIR, "ablation", runId);
await mkdir(directory, { recursive: true, mode: 0o700 });
const seeds = Array.from({ length: seedsCount }, (_, i) => 730201 + i * 7919);
const protocolPaths = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "--", "apps/server/src", "packages/shared/src", "lab", "telemetry", "pnpm-lock.yaml"], {cwd:REPO_ROOT,encoding:"utf8"}).trim().split("\n").filter(path=>/\.(?:ts|py|sv|cpp|yaml)$/.test(path));
const protocolHashes:Record<string,string>={};
for(const path of protocolPaths){const bytes=await readFile(join(REPO_ROOT,path));protocolHashes[path]=createHash("sha256").update(bytes).digest("hex");const target=join(directory,"protocol",path);await mkdir(dirname(target),{recursive:true});await writeFile(target,bytes,{mode:0o600});}
const manifest = { protocolHashes, protocolHash: digest(protocolHashes), runId, startedAt: Date.now(), model: config.BLUE_MODEL, provider: config.AGENT_PROVIDER, seeds, generations, developmentGenerations, orders: seeds.map(seed => ({ seed, order: armOrder(seed) })), retrievalK: RETRIEVAL_K, retrievalTokenBudget: RETRIEVAL_TOKEN_BUDGET, tokenCapMethod: "conservative UTF-8 byte upper bound", maxOutputTokensPerCall: config.AGENT_MAX_TOKENS, temperature: 0.2, modelSeedSupported: false, snapshot: config.PROD_SNAPSHOT, gitCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim(),
  frozenSuites: seeds.map(seed => ({ seed, baseSuiteHash: digest(buildTests(seed, [])), transferFamily: "empty_boundary", transferVersion: 1 })) };
await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });
const trials: Trial[] = [];
let corpus: Corpus | undefined; let failure: string | undefined; let arize: unknown;
const save = async (status: string, activeTrial?: Trial) => {
  const visibleTrials = activeTrial ? [...trials, activeTrial] : trials;
  const results = { schemaVersion: 1, ...manifest, status, contractHash: corpus?.contractHash ?? null, corpusHash: corpus?.corpusHash ?? null, development: corpus ? { runId: corpus.developmentRun.id, sourceFamily: corpus.trainingFamily, targetFamily: corpus.targetFamily, failures: corpus.failures.length, validatedLessons: corpus.graph.nodes.filter(n => n.kind === "lesson" && n.status === "validated").length } : null,
    trials: visibleTrials, summary: summarizeTrials(visibleTrials), telemetry: telemetryStatus(), arize: arize ?? null, error: failure ?? null,
    caveats: ["Small paired pilot, not a statistical superiority claim.", "Hidden checks never enter model prompts or selection decisions. Stopping uses only public gates.", "Development uses one manually planted training bug. Its lesson is validated against real child RTL and the complete gate suite.", "Transfer is measured on an unseen failure family, not an unknown contract rule.", "Token and wall costs exclude shared development; tokens are provider-reported and incomplete calls are not estimated."] };
  await writeFile(join(directory, "results.json"), JSON.stringify(results, null, 2), { mode: 0o600 });
  await writeTimeseries(runId, rowsFromTrials(runId, visibleTrials, manifest.startedAt));
  await writeFile(join(config.DATA_DIR, "ablation", "latest.json"), JSON.stringify({ runId }), { mode: 0o600 });
};
console.log(JSON.stringify({ runId, status: "development", seeds, model: manifest.model }));
await save("development");
try {
  await requireHardwareSnapshot();
  const corpusPath = option("--corpus");
  corpus = corpusPath ? JSON.parse(await readFile(resolve(REPO_ROOT, corpusPath), "utf8")) as Corpus : await traced("run", `${runId}-dev`, {}, () => developCorpus(runId, directory, developmentGenerations));
  assertCorpus(corpus); if (corpus.model !== manifest.model) throw new Error("Development corpus model differs from the experiment model.");
  await writeFile(join(directory, "corpus.json"), JSON.stringify(corpus, null, 2), { mode: 0o600 });
  if (!args.includes("--develop-only")) {
    for (const block of manifest.orders) for (const mode of block.order) {
      if (args.includes("--single-arm") && mode !== config.MEMORY_MODE) continue;
      console.log(JSON.stringify({ runId, seed: block.seed, mode, status: "running" }));
      const trial = await traced("run", `${runId}-${block.seed}-${mode}`, {}, () => runTrial({ runId: `${runId}-${block.seed}-${mode}`, seed: block.seed, mode, corpus: corpus!, generations, onEvaluation: partial => save("running", partial) }));
      trials.push(trial); await save("running");
      console.log(JSON.stringify({ seed: block.seed, mode, status: trial.status, evaluations: trial.evaluations.length, error: trial.error }));
    }
  }
} catch (error) { failure = error instanceof Error ? error.message.slice(0, 300) : "Study failed."; }
await flushTelemetry(); await save(failure ? "failed" : "hardware-complete");
if (!failure && trials.length && config.ARIZE_ENABLED) {
  arize = await new Promise(resolveResult => {
    const child = spawn(config.ARIZE_PYTHON ?? join(REPO_ROOT, "data/telemetry-venv/bin/python"), [join(REPO_ROOT, "telemetry/ablation_experiments.py"), join(directory, "results.json")], { env: { PATH: process.env.PATH, HOME: process.env.HOME, ARIZE_API_KEY: config.ARIZE_API_KEY, ARIZE_SPACE_ID: config.ARIZE_SPACE_ID }, stdio: ["ignore", "pipe", "ignore"] });
    let output = ""; const timer = setTimeout(() => child.kill("SIGKILL"), 180000);
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); if (output.length > 1024 * 1024) child.kill("SIGKILL"); });
    child.on("error", () => { clearTimeout(timer); resolveResult({ status: "missing", error: "Arize experiment worker could not start." }); });
    child.on("close", () => { clearTimeout(timer); try { resolveResult(JSON.parse(output.trim().split("\n").at(-1)!)); } catch { resolveResult({ status: "missing", error: "Arize experiment worker failed. Hardware evidence is retained." }); } });
  });
}
await save(failure ? "failed" : "completed");
console.log(formatMetrics(summarizeTrials(trials)));
console.log(JSON.stringify({ runId, results: join(directory, "results.json"), failure: failure ?? null, arize }));
if (failure || trials.some(t => t.status === "missing") || (config.ARIZE_ENABLED && trials.length > 0 && (arize as {status?:string}|undefined)?.status !== "submitted")) process.exitCode = 1;
