# Quantitative evidence for Hollow Purple

Measure three different claims separately: Red discovers faults, memory improves Blue, and Daytona increases throughput. Numbers from satellite classification or cheating detection are useful presentation examples, not comparable FIFO baselines.

## Executable now

From `apps/server`, with the normal private `.env` and a writable `DATA_DIR`:

```sh
node --import tsx src/scripts/benchmark.ts --mode=plan
node --import tsx src/scripts/benchmark.ts --mode=calibrate --concurrency=1
node --import tsx src/scripts/benchmark.ts --mode=red --concurrency=1
node --import tsx src/scripts/benchmark.ts --mode=timing --limit=4 --concurrency=2 --repeats=2
```

Plan creates a manifest and makes no provider/model calls. Other modes create paid Daytona sandboxes. Red mode additionally makes one bounded Red invocation per design after calibration passes. It does not generate Blue designs or measure memory.

Artifacts are private, gitignored `data/benchmarks/bench-UUID/` JSON. Each manifest freezes the contract, seed, candidate hashes, witness hashes, protocol hashes, snapshot name, limits, and known limitations before execution. The underlying evaluator retains source, observations, replay evidence, and reports under `data/runs/`. Every sandbox is awaited through deletion. `KEEP_FORKS=true` is rejected.

The suite uses the manually authored `lab/probe_fifo.sv` control and ten single-location changes: early full flag, wrong empty flag, dropped full replacement, empty bypass, lost reset priority, nonzero reset count, invalid-read output corruption, sticky read-valid, skipped write slots, and concurrent count corruption. These are manually seeded fixtures, never Blue-generated proposals.

### Fixed-verifier mutation calibration

Each mutant must compile and fail its own hand-authored witness with an independently replayed violation. The control must pass the mandatory, validation, and all calibration sequences. Build failures and unavailable sandboxes stay unresolved in the planned denominator. Calibration artifacts are never supplied to Red.

Safe headline after actual successful execution: **"The verifier reproduced X/10 seeded faults; the control passed."** This is a mutation score. It cannot be described as Red finding those faults.

### Actual Red discovery

Red receives only the frozen contract, opaque case label, and actual RTL. It receives no defect name, witness, calibration verdict, prior failures, or learned lessons. Every design receives the same four-attack budget through the normal model transport. A single invocation may internally retry under the shared bounded transport, which is recorded in provenance.

A catch requires a reproduced counterexample whose test ID belongs to that invocation's sequences. A fixed-suite failure earns no Red credit. The pipeline treats hypotheses as unverified until replay. Record planned bugs, completed cases, catches, misses, build failures, provider failures, actual model IDs and attempts.

The summary also counts mutants failing the existing public checks and authored discoveries on mutants passing every fixed public check. If fixed checks and Red both expose all ten simple defects, this benchmark establishes fault-finding ability but no improvement over fixed tests. A stronger incremental-coverage experiment needs harder independently calibrated defects and an equal-cycle random-search baseline. Fixed-check failures in the mixed suite are oracle observations; only the first authored violation receives the evaluator's independent replay.

Safe headline: **"Red sequences exposed X/10 seeded bugs; 0/1 clean designs received a reproduced violation."** Use the control claim only when its entire evaluation completes successfully. One control is insufficient to estimate a general false-positive rate. These simple mutants are a sanity benchmark, not representative field performance.

The implementation reuses the main evaluator's namespace for extra sequences. During calibration, `agent-red-witness-*` test IDs still mean hand-authored controller witnesses. Only the separate Red mode's model-authored sequences count as actual discoveries.

### Paired Daytona timing

Serial and parallel arms run identical candidates, source hashes, stimuli, seeds, snapshot, evaluator and replay policy. No model calls enter the timer. Wall time includes creation, uploads, any toolchain bootstrap, compilation, simulation, controller-side oracle, replay, persistence, and deletion. Compare batch wall time, not the sum of overlapping candidate durations.

Every pair must complete with matching source hashes and check/failure verdicts. Otherwise speedup is `null`. Run two or three pairs, reversing order on alternating pairs; show every pair and the median ratio. A one-pair result is preliminary. `--limit=4` is a four-design sample, not a full generation benchmark. The CLI caps concurrency at four; choose a value that fits available account resources.

The account memory ceiling observed during initial preflight was 10 GiB. Do not invent a vCPU limit. The snapshot's resource size is recorded, while account vCPU quota remains unknown. Do not stop teammates' resources to improve a benchmark. Private sandboxes do not imply blocked outbound networking. Current policy and bootstrap limitations are recorded explicitly; use a prepared image and a creation-time network block before claiming that setup.

## Memory experiment to run after integration

The graph-memory implementation is a separate feature PR. This harness does not yet implement the ablation.

| Arm | Blue receives | What comparison supports |
| --- | --- | --- |
| A | Frozen task, no past memory | Baseline |
| B | A flat list of the same validated lessons | Memory without graph retrieval |
| C | Lessons selected through graph family relations | Graph retrieval benefit versus B |

Use the same pinned model/provider, task/interface, output and token budgets, starting evidence pool, candidate count and repair budget. Run at least five matched trial blocks if time permits, randomizing arm order. Models may remain stochastic even with matching seeds. Match the B/C context token budgets and source lesson pool. Log actual context hashes and tokens. For A/C only, claim a memory-system improvement; that comparison does not isolate graph structure.

First add an explicit arm selector and target-family retrieval to the experiment runner. The separate graph feature's current engine default retrieves lessons across FIFO families. If flat and graph arms produce identical lesson contexts, that experiment cannot demonstrate a graph-selection advantage. A graph visualization alone is not evidence of a learning benefit.

Freeze a separate private final-exam seed set before trials, exclude it from all agent prompts and repair/selection decisions, and evaluate the selected output once per trial. The existing `held-out` stream is checked during every generation and influences selection, so it is validation rather than an untouched final exam. Do not change the design after examining the final exam and continue calling it held out.

Primary outcome: number of final designs passing the entire exam divided by planned trials. Supporting outcome: checks passed divided by total checks, grouped by design. Checks/cycles in one design are correlated, so do not pretend thousands of cycles are thousands of independent trials. Retain all failures and report uncertainty or describe a small sample as preliminary. Report A/B/C counts before percentages; do not manufacture an "89 versus 64" result.

## Repair and coverage

Use actual run records to report the first failing candidate, reproduced failures retained, model-written descendant generations until acceptance, wall time, calls/tokens and full inherited-regression pass status. Branching siblings are not successive generations. Hidden validation failures provide no public counterexample and must not be fabricated into lessons.

Report authored attack sequences, successful Verilator builds, simulation invocations, cycles including replay, unique retained counterexamples and provider/build failures separately. The current CLI counts sequences, evaluator-completed hardware evaluations, cycles and reproduced counterexamples. It does not yet instrument individual compiler/simulator process counts or prove a repaired regression can never fail again.

The claim we want is narrow and reproducible: **"On this frozen FIFO task, this approach found more seeded defects or produced more passing final designs at the same budget than the baseline."**
