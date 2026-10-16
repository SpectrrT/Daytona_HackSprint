# Measured demo claims

All figures below come from completed runs on October 16, 2026. These are small
controlled benchmarks, not a claim of general model superiority.

## Lead with this

> Same Claude. Zero duplicate actions. Antibody handled 9/9 concurrent retry
> cases correctly, versus 0/9 with model-only execution, while both completed all
> 9 clean controls. Our Blue-written guard eliminated all 9 duplicate effects.

Both arms received the same recorded Claude Sonnet 4.6 action proposals, produced
with the full policy and trusted context. The only execution change was the
gateway guard. The comparison covered support, purchasing and engineering, with
three repeats per domain. Actual tool calls and disposable SQLite effects ran in
Daytona. Arize experiments recorded both arms and returned the same score counts
on readback. This measures state enforcement during concurrent retries, not
better model reasoning or an improvement over existing idempotency systems.

| Claim | Measured evidence | Quote |
| --- | --- | --- |
| Correct concurrent retries | Model-only 0/9; verified guard 9/9 | 0% to 100% on this benchmark |
| Clean controls | 9/9 in both arms | 100% clean completion in both arms |
| Extra effects | 9 to 0; total effects 18 to the intended 9 | 100% of duplicate effects eliminated |
| Guard verification | 19/19 directed and 3/3 hidden checks | 22/22 policy checks passed after one Blue repair generation |
| Planted FIFO bugs | Red 10/10, correct control 0/1 false alarms | 100% planted-bug detection, zero observed control false alarms |
| Daytona parallel evaluation | Two trials, four designs each, two workers | 2.12 times faster, approximately 53% less wall time |
| Recursive FIFO repair | Hand-broken starter 4/12 checks; Blue child 12/12 | 33% to 100% of checks in one repair generation |

Do not describe the 0/1 control as an established population false-positive rate.
Fixed directed tests also caught all ten FIFO mutants, so the planted-bug result
does not demonstrate additional coverage over conventional tests. Timing covers
the measured two-worker configuration. An account memory cap was observed;
the account vCPU limit was not established.

## Memory comparison: no demonstrated advantage

Keep this separate from the retry result. The six-seed FIFO synthesis study had
held-out design passes of 6/6 without memory, 6/6 with raw retrieval, and 6/7 with
graph memory. The subsequent compound-repair study had 3/3, 3/3, and 1/5,
respectively. Its graph arm accepted 1/3 trials within the two-generation cap;
all arms passed the first-try sibling-family test in 3/3 trials. These studies do
not support a graph-memory accuracy advantage. Each evaluated design is counted,
including a failed design followed by a repair. Missing studies have no score.

The recursive demo starts from a deliberately broken manual fixture. It shows a
real model-written repair, not Claude failing to write the initial design.

## Receipts

- [Paired retries, source-bound proposals, verifier evidence and Arize readback](../apps/server/src/benchmarks/results/2026-10-16-paired-retries.json)
- [Red planted-bug benchmark](../apps/server/src/benchmarks/results/2026-10-16-red.json)
- [Paired serial and parallel timing](../apps/server/src/benchmarks/results/2026-10-16-timing.json)
- [Six-seed memory study](../apps/server/src/ablation/results/2026-10-16-six-seed-baseline.json)
- [Compound-repair memory study](../apps/server/src/ablation/results/2026-10-16-compound-repair-v1.json)

The original retry run is
`retry-eb23640e-7a59-4a06-a1ea-145c36ac1337`. Run
`pnpm metrics retry-eb23640e-7a59-4a06-a1ea-145c36ac1337` on the evidence machine.
The recursive FIFO demo is `15ffb87c-101e-4344-8a57-8ccc10d9dfa6`.
