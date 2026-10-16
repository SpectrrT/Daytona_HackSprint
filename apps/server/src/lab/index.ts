import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { CandidateVariant, EvaluationResult, FailureEvidence, RedAttack } from "@hollow-purple/shared/evolution";
import { config, REPO_ROOT } from "../config.js";
import { CANDIDATE_DIR, Computer, provisionCandidate } from "../daytona/computer.js";
import { observeModel, type Observation } from "./model.js";
import { buildTests, type LabTest } from "./tests.js";
import { CandidateBuildError, validateRtl } from "./validation.js";
import { traced } from "../telemetry/index.js";

export const MAX_EVALUATION_CYCLES = 20_000;
const LAB_DIR = join(REPO_ROOT, "lab");
const execFileAsync = promisify(execFile);
const DEFINES: Record<Exclude<CandidateVariant, "generated">, string> = {
  baseline: "`define BUG_COUNT_RACE\n",
  "reset-leak": "`define BUG_RESET_LEAK\n",
  "full-drop": "`define BUG_FULL_DROP\n",
  "repair-count": "`define BUG_EMPTY_BYPASS\n",
  "repair-atomic": "",
};

export function candidateSource(variant: CandidateVariant): string {
  if (variant === "generated" || !(variant in DEFINES)) throw new Error("Generated candidates require actual Blue-authored RTL source.");
  return `// Candidate: ${variant}\n${DEFINES[variant]}${readFileSync(join(LAB_DIR, "rtl/fifo.sv"), "utf8")}`;
}

function aborted(signal?: AbortSignal): void { signal?.throwIfAborted(); }
function safeId(value: string): string {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(value)) throw new Error("Invalid artifact identifier.");
  return value;
}

function pythonOracle(tests: LabTest[], observations: Observation[][], seed: number, signal?: AbortSignal): Promise<Pick<EvaluationResult, "checks" | "failure" | "cycles">> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.PYTHON_BIN || "python3", [join(LAB_DIR, "oracle.py")], { stdio: ["pipe", "pipe", "pipe"], signal });
    let output = "", error = "";
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { error += chunk.toString(); });
    child.on("error", (cause) => reject(new Error(`Independent verifier could not start. Install Python 3 or set PYTHON_BIN. ${cause.message}`)));
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`Independent verifier failed (${code}): ${error.slice(0, 1000)}`));
      try { resolve(JSON.parse(output)); } catch { reject(new Error("Independent verifier returned invalid JSON.")); }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify({ tests, observations, seed }));
  });
}

async function checked(computer: Computer, command: string, label: string, timeoutSec: number, signal?: AbortSignal): Promise<void> {
  aborted(signal);
  const result = await computer.exec(command, { cwd: CANDIDATE_DIR, timeoutSec });
  aborted(signal);
  if (result.exitCode !== 0) throw new Error(`${label} failed (${result.exitCode}): ${result.output.slice(-2000)}`);
}

async function candidateExec(computer: Computer, command: string, timeoutSec: number, label: string, signal?: AbortSignal) {
  aborted(signal);
  try {
    const result = await computer.exec(command, { cwd: CANDIDATE_DIR, timeoutSec });
    aborted(signal);
    return result;
  } catch (error) {
    aborted(signal);
    if (error instanceof Error && /timed?\s*out|timeout|execution.+terminated/i.test(error.message)) {
      throw new CandidateBuildError(`${label} exceeded its ${timeoutSec}-second execution budget. Simplify or repair the RTL before retrying.`);
    }
    throw error;
  }
}

async function prepare(computer: Computer, source: string, compiledSource: string, signal?: AbortSignal): Promise<void> {
  const directory = await computer.exec(`mkdir -p ${CANDIDATE_DIR}`);
  if (directory.exitCode !== 0) throw new Error("Cannot create Daytona candidate workspace.");
  await computer.writeFile(`${CANDIDATE_DIR}/proposal.sv`, source);
  await computer.writeFile(`${CANDIDATE_DIR}/fifo.sv`, compiledSource);
  await checked(computer, "if command -v verilator >/dev/null && command -v g++ >/dev/null && command -v make >/dev/null && command -v git >/dev/null; then exit 0; fi; if [ \"$(id -u)\" = 0 ]; then apt-get update -qq && apt-get install -y -qq verilator g++ make git; elif command -v sudo >/dev/null; then sudo -n apt-get update -qq && sudo -n apt-get install -y -qq verilator g++ make git; else echo 'Snapshot needs verilator, g++, make, and git. Build lab/Dockerfile and set PROD_SNAPSHOT.'; exit 78; fi", "Verilator toolchain bootstrap (set PROD_SNAPSHOT to a prepared snapshot if needed)", 240, signal);
  await checked(computer, "git init -q && git add fifo.sv proposal.sv && git -c core.hooksPath=/dev/null -c commit.gpgSign=false -c user.name='Blue' -c user.email='blue@hollow.local' commit -q -m 'Candidate RTL'", "Candidate version history", 30, signal);
  await computer.writeFile("/home/daytona/verilator_driver.cpp", readFileSync(join(LAB_DIR, "verilator_driver.cpp")));
  aborted(signal);
  const build = await candidateExec(computer, "ulimit -t 100; ulimit -f 8192; verilator --cc --exe --build -j 2 -Wno-fatal --top-module fifo --Mdir obj_dir fifo.sv /home/daytona/verilator_driver.cpp -CFLAGS '-std=c++17' > build.log 2>&1 || { tail -c 12000 build.log; exit 1; }", 120, "Verilator compilation", signal);
  aborted(signal);
  if (build.exitCode !== 0) throw new CandidateBuildError(`Verilator compilation failed (${build.exitCode}):\n${build.output.slice(-12000)}`);
}

function encodeTests(tests: LabTest[]): string {
  return tests.map((test) => `T\n${test.sequence.map((s) => `${Number(s.reset)} ${Number(s.write)} ${Number(s.read)} ${s.data}`).join("\n")}\n`).join("");
}

async function observeVerilator(computer: Computer, tests: LabTest[], signal?: AbortSignal): Promise<Observation[][]> {
  aborted(signal);
  await computer.writeFile("/home/daytona/stimuli.txt", encodeTests(tests));
  aborted(signal);
  const simulation = await candidateExec(computer, "ulimit -t 20; ulimit -f 2048; timeout 25s ./obj_dir/Vfifo < /home/daytona/stimuli.txt > /home/daytona/observations.txt 2>/home/daytona/simulation-error.txt", 35, "Verilator simulation", signal);
  aborted(signal);
  if (simulation.exitCode !== 0) {
    const diagnostics = await computer.readText("/home/daytona/simulation-error.txt", 16_384).catch(() => "No bounded simulator diagnostic was available.");
    throw new CandidateBuildError(`Compiled RTL simulation failed or exceeded its execution budget (${simulation.exitCode}). ${diagnostics.slice(0, 4000)}`);
  }
  const text = await computer.readText("/home/daytona/observations.txt");
  const groups: Observation[][] = [];
  for (const line of text.trim().split(/\r?\n/)) {
    if (line === "T") { groups.push([]); continue; }
    const values = line.split(" ").map(Number);
    if (values.length !== 5 || values.some((n) => !Number.isInteger(n)) || !groups.length) throw new CandidateBuildError("Malformed Verilator observations.");
    const [valid, data, full, empty, occupancy] = values as [number, number, number, number, number];
    if (![valid, full, empty].every((n) => n === 0 || n === 1) || data < 0 || data > 65535 || occupancy < 0 || occupancy > 63) throw new CandidateBuildError("Out-of-range Verilator observations.");
    groups.at(-1)!.push({ valid: Boolean(valid), data, full: Boolean(full), empty: Boolean(empty), occupancy });
  }
  return groups;
}

export interface EvaluateCandidateInput {
  runId: string;
  candidateId: string;
  variant: CandidateVariant;
  provider: "local" | "daytona";
  seed: number;
  regressions: FailureEvidence[];
  source?: string;
  attacks?: RedAttack[];
  suite?: "development-simultaneous" | "ablation-exam";
  signal?: AbortSignal;
}

/** Execute candidate observations, then grade and replay them outside its sandbox. */
export function evaluateCandidate(input: EvaluateCandidateInput): Promise<EvaluationResult> {
  return traced("verifier", input.runId, { "hollow.candidate_id": input.candidateId }, () => evaluateCandidateUntraced(input), (result) => ({
    "hollow.backend": result.backend, "hollow.source_hash": result.sourceHash, "hollow.checks_passed": result.checks.filter((check) => check.passed).length,
    "hollow.checks_total": result.checks.length, "hollow.cycles": result.cycles, "hollow.reproduced": result.reproduced,
    "hollow.score": result.checks.length ? result.checks.filter((check) => check.passed).length / result.checks.length : undefined,
  }));
}
async function evaluateCandidateUntraced(input: EvaluateCandidateInput): Promise<EvaluationResult> {
  const { runId, candidateId, variant, provider, seed, regressions, signal } = input;
  aborted(signal);
  if ((input.source !== undefined || variant === "generated") && provider !== "daytona") throw new Error("Blue-authored RTL requires Daytona Verilator execution; a behavioral model cannot verify arbitrary source.");
  if (variant === "generated" && input.source === undefined) throw new Error("Generated candidates require Blue-authored source.");
  let tests = buildTests(seed, regressions, input.attacks);
  if (input.suite === "development-simultaneous") tests = tests.filter(test => test.id === "simultaneous");
  if (input.suite === "ablation-exam") {
    const step = (write = false, read = false, data = 0, reset = false) => ({ write, read, data: data & 65535, reset });
    tests.push({ id: "transfer-empty-boundary", name: "Unseen sibling: empty boundary", hidden: true, sequence: [step(false, false, 0, true), ...Array.from({ length: 64 }, (_, i) => [step(true, true, (seed + i * 7919) & 65535), step(false, true), step(false, true), step(false, false)]).flat()] });
  }
  const suiteCycles = tests.reduce((total, test) => total + test.sequence.length, 0);
  const maxReplay = Math.max(0, ...tests.filter((test) => !test.hidden).map((test) => test.sequence.length));
  if (suiteCycles + maxReplay > MAX_EVALUATION_CYCLES) throw new Error(`Candidate evaluation exceeds ${MAX_EVALUATION_CYCLES} cycle budget.`);
  const source = input.source ?? candidateSource(variant);
  const sourceHash = createHash("sha256").update(source).digest("hex");
  const artifactPath = join(config.DATA_DIR, "runs", safeId(runId), "candidates", safeId(candidateId));
  await mkdir(artifactPath, { recursive: true });
  await writeFile(join(artifactPath, "fifo.sv"), source);
  if (provider === "local") {
    // Each demo candidate gets its own reviewable revision, as remote candidates do.
    const git = (args: string[]) => execFileAsync("git", ["-C", artifactPath, "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args], { timeout: 15_000, signal });
    await git(["init", "-q"]);
    await git(["add", "fifo.sv"]);
    await git(["-c", "user.name=Blue", "-c", "user.email=blue@hollow.local", "commit", "-q", "--allow-empty", "-m", `Candidate ${variant}`]);
  }
  let computer: Computer | undefined;
  let primaryError: unknown;
  try {
    const compiledSource = input.source !== undefined ? validateRtl(source) : source;
    if (provider === "daytona") {
      computer = await provisionCandidate(runId, candidateId);
      aborted(signal);
      await prepare(computer, source, compiledSource, signal);
    }
    const observe = (suite: LabTest[]) => computer ? observeVerilator(computer, suite, signal) : Promise.resolve(observeModel(variant, suite));
    const observations = await observe(tests);
    await writeFile(join(artifactPath, "observations.json"), JSON.stringify({ backend: computer ? "verilator" : "model", sourceHash,
      tests: tests.flatMap((test, index) => test.hidden ? [] : [{ id: test.id, name: test.name, sequence: test.sequence, observations: observations[index] }]) }));
    const result = await pythonOracle(tests, observations, seed, signal);
    let reproduced = false;
    if (result.failure) {
      const replayTest: LabTest = { id: result.failure.testId, name: result.failure.testName, hidden: false, sequence: result.failure.sequence };
      const replay = await pythonOracle([replayTest], await observe([replayTest]), seed, signal);
      reproduced = Boolean(replay.failure && replay.failure.cycle === result.failure.cycle && replay.failure.summary === result.failure.summary);
      result.failure.id = `${candidateId}-${result.failure.id}`;
      result.failure.reproduced = reproduced;
      result.cycles += replay.cycles;
      result.checks.push({ id: "reproduction", name: "Independent counterexample replay", passed: reproduced, cycles: replay.cycles, hidden: false,
        summary: reproduced ? "The complete input sequence reproduced the same contract violation from a fresh model." : "The reported violation did not reproduce; it must not become a regression." });
    }
    const report: EvaluationResult = { ...result, failure: result.failure ?? undefined, source, sourceHash, reproduced,
      backend: computer ? "verilator" : "model", sandboxId: computer?.id, artifactPath };
    // Only safe verdicts/public evidence persist. Held-out stimuli stay controller-private.
    await writeFile(join(artifactPath, "report.json"), JSON.stringify(report, null, 2));
    return report;
  } catch (error) {
    if (error instanceof CandidateBuildError) {
      const report: EvaluationResult = { checks: [{ id: "build", name: "Build and executable RTL validation", passed: false, cycles: 0, hidden: false, summary: error.message }],
        cycles: 0, source, sourceHash, reproduced: false, backend: "verilator", sandboxId: computer?.id, artifactPath, buildError: error.message };
      await writeFile(join(artifactPath, "report.json"), JSON.stringify(report, null, 2));
      return report;
    }
    primaryError = error;
    throw error;
  } finally {
    if (computer && !config.KEEP_FORKS) {
      try { await computer.sandbox.delete(60, true); }
      catch (error) {
        const detail = `Daytona cleanup failed for sandbox ${computer.id}. Delete it in the Daytona dashboard.`;
        if (!primaryError) throw new Error(detail);
        console.error(detail);
      }
    }
  }
}
