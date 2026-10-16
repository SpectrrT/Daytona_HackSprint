import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BUFFER_PROMPT, type RedAttack } from "@hollow-purple/shared/evolution";
import { searchRed } from "../agents/index.js";
import { benchmarkFixtures, hash, type BenchmarkFixture } from "../benchmarks/fixtures.js";
import { boundedMap, pairedTiming, summarize, type Measurement } from "../benchmarks/metrics.js";
import { config, REPO_ROOT } from "../config.js";
import { daytona, requireHardwareSnapshot } from "../daytona/client.js";
import { freezeContract } from "../engine/contract.js";
import { evaluateCandidate } from "../lab/index.js";
import { validateRtl } from "../lab/validation.js";

// This CLI owns fresh benchmark IDs. It never loads or mutates another run's journal.
let reportDirectory: string | undefined;
let phase = "arguments";
async function main() {
  const args = new Map(process.argv.slice(2).map((arg) => {
    const match = /^--(mode|concurrency|limit|repeats|seed)=(.+)$/.exec(arg);
    if (!match) throw new Error("Use --mode=plan|calibrate|red|timing, --concurrency=1..4, --limit=1..11, --repeats=1..3, --seed=integer.");
    return [match[1]!, match[2]!] as const;
  }));
  const mode = args.get("mode") ?? "plan";
  if (!["plan", "calibrate", "red", "timing"].includes(mode)) throw new Error("Unknown benchmark mode.");
  const integer = (key: string, fallback: number, min: number, max: number) => {
    const raw = args.get(key);
    const n = raw === undefined ? fallback : Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`Invalid --${key}.`);
    return n;
  };
  const concurrency = integer("concurrency", 2, 1, 4);
  const limit = integer("limit", 11, 1, 11);
  const repeats = integer("repeats", 1, 1, 3);
  const seed = integer("seed", 20261016, 0, 0xffffffff);
  if (mode === "timing" && concurrency < 2) throw new Error("Timing mode requires concurrency >=2.");
  if (config.KEEP_FORKS && mode !== "plan") throw new Error("Benchmarks require KEEP_FORKS=false so wall time includes sandbox deletion.");
  const fixtures = benchmarkFixtures().slice(0, limit);
  for (const fixture of fixtures) validateRtl(fixture.source);
  const runId = `bench-${randomUUID()}`;
  const directory = join(config.DATA_DIR, "benchmarks", runId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  reportDirectory = directory;
  const save = (name: string, value: unknown) => writeFile(join(directory, name), JSON.stringify(value, null, 2), { mode: 0o600 });
  const contract = freezeContract(BUFFER_PROMPT, 0);
  const manifest = {
    schemaVersion: 1, runId, mode, createdAt: new Date().toISOString(), seed, concurrency, repeats,
    gitCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim(),
    protocolHashes: Object.fromEntries(["lab/oracle.py", "lab/verilator_driver.cpp", "apps/server/src/lab/tests.ts", "apps/server/src/benchmarks/fixtures.ts", "apps/server/src/benchmarks/metrics.ts", "apps/server/src/scripts/benchmark.ts"].map((path) => [path, hash(readFileSync(join(REPO_ROOT, path), "utf8"))])),
    contractHash: contract.hash, snapshot: config.PROD_SNAPSHOT,
    networkPolicy: "Existing candidate policy: private sandbox; outbound network block is not explicitly requested by this harness.",
    model: { provider: config.AGENT_PROVIDER, configuredModel: config.RED_MODEL ?? null, callsPerCandidate: mode === "red" ? 1 : 0, attacksPerCall: 4 },
    timingBoundary: "Await full evaluateCandidate: provision, toolchain bootstrap if needed, upload, compile, simulate, controller oracle, fresh-simulator replay, persist, delete. Model calls excluded.",
    fixtures: fixtures.map(({ id, defect, sourceHash, witnesses }) => ({ id, defect, sourceHash, witnessHash: hash(JSON.stringify(witnesses)) })),
    limitations: ["Manually seeded defects are not representative of all RTL bugs.", "Simulation is not formal verification.", "The existing held-out stream is validation used during selection, not an untouched final exam.", "One clean design cannot estimate a population false-positive rate.", "An alarm means a reproduced pipeline verdict, not a speculative Red hypothesis.", "Default images may bootstrap a toolchain at runtime. This is not a prewarmed snapshot benchmark.", "No cross-product comparison with SubStrata or Katena is implied."],
  };
  await save("manifest.json", manifest);
  console.log(JSON.stringify({ runId, mode, plannedCandidates: fixtures.length, reportDirectory: directory }));
  if (mode === "plan") return;
  phase = "snapshot-preflight";
  await requireHardwareSnapshot();
  const snapshot = await daytona().snapshot.get(config.PROD_SNAPSHOT);
  await save("snapshot.json", { name: snapshot.name, state: snapshot.state, cpu: snapshot.cpu, memoryGiB: snapshot.mem, disk: snapshot.disk, observedAt: new Date().toISOString(), accountVcpuLimit: null });
  const mutants = fixtures.filter((f) => f.defect !== null).length;
  const controls = fixtures.length - mutants;
  let serialNumber = 0;
  const evaluate = async (fixture: BenchmarkFixture, attacks: RedAttack[], batch: string): Promise<Measurement> => {
    const started = performance.now();
    try {
      // Provisioning truncates candidate IDs in sandbox names. Put the unique
      // fixture first so concurrent cases retain distinct names after truncation.
      const result = await evaluateCandidate({ runId, candidateId: `${fixture.id}-${batch}`, variant: "generated", provider: "daytona", source: fixture.source, seed, regressions: [], attacks });
      return { id: fixture.id, defective: fixture.defect !== null, wallMs: performance.now() - started, result, attackIds: attacks.map((attack) => attack.id) };
    } catch {
      return { id: fixture.id, defective: fixture.defect !== null, wallMs: performance.now() - started, error: "Evaluation did not complete. No bug catch or speedup credit. Check provider availability and cleanup in the Daytona dashboard.", attackIds: attacks.map((attack) => attack.id) };
    }
  };
  const calibration = async (width: number, label: string) => {
    const started = performance.now();
    const rows = await boundedMap(fixtures, width, async (fixture) => {
      // The existing evaluator accepts at most four extra sequences. The clean
      // control receives four concatenated groups covering every mutant witness.
      const witnesses = fixture.witnesses.length <= 4 ? fixture.witnesses : Array.from({ length: 4 }, (_, i) => ({
        id: `control-witness-${i}`, name: "Controller control calibration", hypothesis: "Hand-authored calibration, not Red.",
        sequence: fixture.witnesses.filter((_, n) => n % 4 === i).flatMap((witness) => witness.sequence),
      }));
      const row = await evaluate(fixture, witnesses, label);
      await save(`${label}-${fixture.id}.json`, row);
      console.log(JSON.stringify({ batch: label, case: row.id, completed: !!row.result, buildError: !!row.result?.buildError, wallMs: Math.round(row.wallMs) }));
      return row;
    });
    return { rows, wallMs: performance.now() - started, summary: summarize(rows, mutants, controls) };
  };
  if (mode === "calibrate") {
    phase = "calibration";
    const result = await calibration(concurrency, `calibration-${serialNumber++}`);
    await save("summary.json", { kind: "Fixed-verifier mutation calibration. Not Red discovery.", ...result });
    console.log(JSON.stringify(result.summary));
    if (result.summary.witnessedMutants !== mutants || !result.summary.controlClaimAvailable) process.exitCode = 1;
  } else if (mode === "timing") {
    phase = "paired-timing";
    const pairs = [];
    for (let i = 0; i < repeats; i++) {
      // Reverse order every other pair to reduce systematic cache/order bias.
      const firstParallel = i % 2 === 1;
      const first = await calibration(firstParallel ? concurrency : 1, `pair-${i}-first`);
      const second = await calibration(firstParallel ? 1 : concurrency, `pair-${i}-second`);
      const serial = firstParallel ? second : first;
      const parallel = firstParallel ? first : second;
      const comparison = { pair: i, firstParallel, candidates: fixtures.length, concurrency, ...pairedTiming(serial.rows, parallel.rows, serial.wallMs, parallel.wallMs) };
      pairs.push(comparison);
      await save(`pair-${i}.json`, { comparison, serial, parallel });
      await save("summary.json", { kind: "Paired end-to-end Daytona timing, no model calls.", pairs });
      console.log(JSON.stringify(comparison));
    }
    if (concurrency === 1 || pairs.some((pair) => !pair.valid)) process.exitCode = 1;
  } else {
    phase = "calibration";
    // Calibrate first, then make fresh model calls with only the opaque ID and
    // actual source. No witness, defect label, calibration result or failure leaks.
    const calibrated = await calibration(concurrency, "calibration");
    await save("calibration.json", calibrated);
    if (calibrated.summary.witnessedMutants !== mutants || !calibrated.summary.controlClaimAvailable) throw new Error("Calibration failed. Refusing a misleading Red denominator.");
    phase = "red-discovery";
    const rows = await boundedMap(fixtures, concurrency, async (fixture, index) => {
      let row: Measurement;
      try {
        const proposal = await searchRed({ runId, candidateId: `red-${fixture.id}`, contract, candidate: { source: fixture.source, label: fixture.id }, failures: [], round: 0, seed: seed + index });
        row = await evaluate(fixture, proposal.attacks, "red");
        const { provider, model, durationMs, attempts } = proposal.agent;
        row.model = { provider, model, durationMs, attempts };
      } catch {
        row = { id: fixture.id, defective: fixture.defect !== null, wallMs: 0, attackIds: [], error: "Red invocation did not complete. Counts as unresolved, not a catch or a clean control." };
      }
      await save(`red-${fixture.id}.json`, row);
      console.log(JSON.stringify({ batch: "red", case: fixture.id, completed: !!row.result }));
      return row;
    });
    const summary = summarize(rows, mutants, controls);
    await save("summary.json", { kind: "Actual Red-authored discovery on calibrated manual mutants. Hypotheses alone do not count as alarms.", summary, rows });
    console.log(JSON.stringify(summary));
    if (summary.infrastructureErrors || summary.buildErrors || !summary.controlClaimAvailable) process.exitCode = 1;
  }
}
main().catch(async () => {
  if (reportDirectory) await writeFile(join(reportDirectory, "failure.json"), JSON.stringify({ status: "failed", phase, headlineAvailable: false }, null, 2), { mode: 0o600 }).catch(() => {});
  console.error("Benchmark stopped before a valid headline could be produced. Check configuration, snapshot availability, calibration artifacts, and Daytona cleanup. No scores were substituted.");
  process.exitCode = 1;
});
