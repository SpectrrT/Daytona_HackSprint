# Verified lesson graph

`LessonMemory` connects the live hardware engine to SurrealDB Agent Memory. It uses the sponsor Context API, not SQL database credentials. Set `SURREAL_CONTEXT_URL`, `SURREAL_CONTEXT_ID`, and `SURREAL_API_KEY` together in the private root `.env`. Keys remain in the controller and are excluded from agent child environments.

The feature is optional. With no Context configuration the existing engine remains usable. With Context configuration, graph or lesson-writing failures fail the run explicitly instead of substituting a successful result. The core engine accepts memory as its fourth constructor argument, so tests can inject a graph without reading ambient credentials. The server and live repair verification script inject the configured graph.

## Evidence and retrieval

Each run has its own scope and frozen-contract hash. Real graph relations connect:

```text
candidate child_of parent_candidate
candidate failed_on failure
failure belongs_to attack_family
attack_family child_of parent_family
lesson supported_by failure
lesson applies_to parent_family
lesson validated_by repaired_descendant
```

Only public, independently reproduced failures already committed to the controller's regression journal may produce a lesson. Blue writes the explanation through the existing bounded model transport. Hidden failures, hidden stimuli, model self-assessments and unverified hypotheses are excluded.

A new lesson is `proposed`. A descendant must pass the complete existing acceptance gate, including every retained regression, all four current Red attacks, directed checks and the hidden check, before the lesson becomes `validated`. The graph records the validating candidate and exact source hash. An unrelated passing sibling cannot validate it. The graph's validation checks add evidence requirements; they do not replace the hardware verifier.

Retrieval walks stored family ancestry and `applies_to` edges. For example, a lesson on the parent `occupancy` family can transfer from a simultaneous-operation failure to a full-boundary or empty-boundary case. Only validated lessons enter later Blue and Red prompts. Current inheritance requests all FIFO families; callers can narrow the family list. Memory is scoped to a single run and contract. Cross-run reuse is not implemented.

The existing candidate/event interfaces remain compatible. `lesson.learned` events add `status`, `family` and `memoryId` in their payload and label proposals explicitly. The frontend can consume these read-only endpoints:

- `GET /api/memory/status`: independently checks provider authentication. Configuration alone is not reported as a successful connection.
- `GET /api/runs/:id/memory`: graph nodes and edges, including proposed and validated status; unknown runs return 404.

Provider responses are bounded and validated. Truncated entity reads, missing references, mismatched source hashes and changed contract hashes are refused. Errors do not include credential values or provider response bodies.

## Verification

```sh
# Use the repo's data directory if your shell has an unrelated DATA_DIR.
DATA_DIR="$PWD/data" pnpm test
pnpm build

# Actual sponsor API write/read test. Requires the three Context credentials.
DATA_DIR="$PWD/data" pnpm --filter @antibody/server exec node --import tsx src/scripts/verify-memory.ts
```

The live adapter check registers a unique `memory-qa-*` scope, writes typed nodes and real graph edges, reads each back, and saves a redacted report in `data/verification/memory-live.json`. It makes no model calls and performs no hardware runs. Its report proves graph persistence only. Unit tests cover the model/engine hooks with explicit fake agents and verifier results; those are not live repair evidence.

Validation proves the recorded finite checks passed for the recorded descendant. It does not establish that a lesson is universally correct, that it caused the improvement, or that unseen attacks are all defended. The current taxonomy is controller-owned; Red branch mutation is a separate feature.
