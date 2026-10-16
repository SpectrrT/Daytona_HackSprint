# Controlled FIFO memory study

Run from the repository root. Evidence commands use the project-local `data/`
folder, regardless of another application's ambient `DATA_DIR`. Set
`HOLLOW_DATA_DIR` for an explicit project-specific override:

```sh
pnpm ablation --seeds 3
pnpm metrics <run-id>
pnpm charts <run-id>
```

The first command performs a bounded development phase, freezes a real SurrealDB
export and public counterexamples, then runs three memory arms in randomized
order per seed. Results are written incrementally to
`data/ablation/<run-id>/results.json`. Every design's independent verifier report,
source hash and Daytona sandbox ID remain in that file. Exact protocol sources
and their SHA-256 hashes are saved before inference in `protocol/` and
`manifest.json`. Reuse a corpus with `--corpus data/ablation/<prior-id>/corpus.json`.
Paths are relative to the repository root. Set `--development-generations` and
`--generations` to bound development and evaluation separately.

Use fresh seeds for a revised system, for example `--seed-start 910001`.
The optional `--task compound-repair-v1` changes the task from new synthesis to
repairing a supplied manual FIFO with three planted defects. Three fixed repair
inputs cover occupancy and output holding, reset and pointers, and empty/full
boundaries. Every arm receives the identical input source per seed, frozen
contract and budgets. Its source hash and task identifier are recorded before
inference. Three consecutive study seeds cover all three inputs. This is a
separate challenge, not a replacement for prior synthesis results. Do not
combine its scores with those of the original task or promise an advantage.

## Provider and credentials

Set the same explicit Claude model in `BLUE_MODEL` and `RED_MODEL`.
`AGENT_PROVIDER=bedrock` uses Bedrock Runtime Converse in `BEDROCK_REGION=us-west-2`.
`BEDROCK_CREDENTIALS_FILE` points to a private temporary JSON file outside this
repository containing the workshop dashboard's `AWS_ACCESS_KEY_ID`,
`AWS_SECRET_ACCESS_KEY` and `AWS_SESSION_TOKEN`. AWS secrets in `.env` are never
used by this provider. No alternate provider or model is substituted on failure.

The alternative `AGENT_PROVIDER=anthropic` uses the existing direct Anthropic
transport. Both study transports use the same configured output token cap and
temperature. Bedrock Converse does not expose a sampling seed here: trial seeds
pair the verifier and Red search, not deterministic model inference. Report the
actual model ID rather than claiming the latest or strongest available Claude.

## One changed input

- A, `none`: empty memory for both Blue and Red. No fallback lessons.
- B, `flat`: raw public counterexamples, including input sequences and trace
  samples, selected by TF-IDF cosine similarity. No distilled lessons.
- C, `graph`: validated lessons selected by the existing family-ancestry walker
  over the frozen SurrealDB export. Proposed lessons cannot enter retrieval.

B and C use the same development evidence, top-k and conservative UTF-8 byte
upper bound on retrieval tokens. The cap is deliberately conservative and is
not presented as exact tokenizer equality. The provider reports actual input and
output tokens. Model, contract, generation caps, per-call output cap, temperature,
Red attack count and verifier seeds match. `MEMORY_MODE=none|flat|graph` also
controls normal hardware memory selection. For a single-arm diagnostic, combine
it with `--single-arm`; absent arms remain missing.

## Development and transfer

Development starts with an explicitly manual single-bug fixture. Its initial
simulation releases only a simultaneous-operations public failure. Blue writes
an actual repair. A lesson becomes validated only after a real descendant passes
the entire fixed suite, held-out validation and retained regression. A failure
from another family aborts corpus freezing rather than contaminating the study.
The model never receives a failing sibling counterexample during development.

New lessons include controller-replayed pre-edge and post-edge facts, so the
writer cannot confuse an oracle post-edge count with a pre-edge count. The
writer sees the actual failed source. Before a proposal becomes retrievable,
it is reviewed again against the actual passing descendant. Exact source
excerpts are checked against both executed designs and retained in the lesson.
This grounds the explanation in the repair; it is not formal proof of prose.
Legacy frozen corpora remain unchanged, including their original limitations.

Evaluation targets the sibling `empty_boundary` through parent `occupancy`.
The contract states the empty-boundary requirement for every arm. This is a
previously unseen **failure family**, not an unstated or newly introduced rule.
The corpus can be small, including just one validated lesson. That pilot cannot
isolate graph structure from lesson distillation, or establish broad superiority.

The hidden random stream has a 1,024-step core plus reset and drain. A separately
frozen hidden empty-boundary probe measures transfer. Neither hidden stimulus nor
failure witness reaches an agent. Selection and stopping use public gates only.
A hidden-only failure cannot trigger a repair. Hidden checks are therefore not
used to choose or optimize a candidate. First-try transfer uses only generation
zero. All executed hidden checks retain their actual denominator; build rejection
and missing model/provider evidence are reported separately in raw results.

## Metrics and Arize

Counts precede percentages. A generation count of one means the initial design
passed. Non-accepted trials are censored and are not silently assigned a successful
repair time. Token totals use provider usage and exclude shared development.
Wall time includes controller and telemetry overhead. Missing calls are not priced.

Install the isolated telemetry dependencies with:

```sh
python3 -m venv data/telemetry-venv
data/telemetry-venv/bin/python -m pip install -r telemetry/requirements.txt
```

Set `ARIZE_ENABLED=true`, `ARIZE_API_KEY`, `ARIZE_SPACE_ID` and, if necessary,
`ARIZE_PYTHON`. OpenInference spans for Blue, Red, lesson writing and verification
use `arize.otel.register` with project `hollow-purple`. Only bounded identifiers,
usage and verifier metrics leave the application through these role spans.
Prompts, source, credentials, signed URLs and hidden stimuli are excluded.

The Arize experiment task reopens each **recorded real hardware report**, verifies
its source hash and runs deterministic SDK evaluators. It does not claim to rerun
model inference inside Arize, or use an LLM as the hardware judge. The outside
evaluation service records scores derived from Verilator and the independent
oracle. `arize-experiments.json` contains experiment IDs and remote score readback.
The results file reports upload failure separately from hardware results.

A pilot result exists only after a real run produces `results.json`. Do not
copy a claimed memory improvement from another product into these results.
