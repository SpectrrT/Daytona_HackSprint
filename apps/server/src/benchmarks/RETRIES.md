# Paired retry safety

```sh
pnpm retry-benchmark --repeats 3
pnpm metrics retry-<id>
```

This is a system comparison, separate from the FIFO memory ablation. Both arms
use the same actual Claude outputs. Claude receives the entire frozen policy,
trusted records and authenticated session context. Two concurrent model jobs
receive requests before either commits an effect. Both see the same empty
committed history. They can independently choose the same valid operation.

The model-only gateway executes model-selected actions. Blue writes a guard
after a real duplicate effect is reproduced after a fresh process and database.
The guard must pass the retained retry, all directed tool-policy checks, and
separate held-out action sequences. Hidden-only failures cannot cause repairs.
The runtime serializes guard decisions and committed effects under the same
lock in both arms. Only the candidate guard changes.

After the guard is frozen, fresh model jobs run in support, purchasing and
engineering. Each pair of actual proposals is replayed through both gateways.
HTTP requests execute concurrently; the checker binds actual journal order to
the exact proposed action multiset and checks persisted effects. The same first
proposal also runs alone as a useful-work control. Refusing everything cannot
pass either utility gate. Missing actions and incomplete runs are retained.

The benchmark owns one headless Daytona sandbox. Candidate versions use fresh
server processes and databases, with source and immutable runtime hashes checked
for every verdict. It never stops or deletes another agent's sandbox. Account
capacity failures remain failed attempts, without fabricated scores.

Results live in `data/retry-benchmarks/<id>/results.json`, with pre-inference
input and protocol hashes, provider usage, source hashes and sandbox IDs. Arize
records two experiments over source-bound evidence with deterministic SDK
evaluators and score readback. It does not perform new model inference or grade
using an LLM. The dashboard presents measured counts, with no invented values.

This measures atomic tool-state enforcement. It does not establish that the
graph improves Claude's intrinsic reasoning, compare against existing production
idempotency systems, or prove general agent safety. These are controlled synthetic
applications with real disposable SQLite effects. Numerical claims belong in
the run's results after execution.
