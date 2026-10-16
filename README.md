# Hollow Purple

A general adversarial engineering system. **Blue builds candidates. Red searches for reproducible failures. An independent verifier checks the evidence against a frozen contract.** Verified failures become permanent regression tests and guide repaired descendants.

The working examples are a **32 × 16-bit hardware FIFO** and a **checkout web app with safe retries and bounded stock**. Hardware uses actual model jobs and Verilator execution in Daytona. Software uses actual Python web servers and SQLite in Daytona, with Red's browser actions executed through Anchor. The old fixed hardware variants are retained only for archived examples and isolated tests; they are never substituted into a live agent run.

The product's output is a tested design, reproducible failure cases, readable lessons, and evidence of improvement across a tree of versions. Hardware is one application of that loop.

## One loop, different engineering examples

1. Freeze a measurable contract: interface, behavior, constraints, and acceptance checks.
2. Blue builds independent candidates in isolated Daytona sandboxes.
3. Red inspects each candidate and produces concrete inputs or actions that might break it.
4. An independent verifier replays those actions and compares actual behavior with the contract.
5. Blue branches repairs from verified failures. Each child must pass inherited regressions and separate checks.
6. Red adapts; the system preserves lineage, lessons, and evidence until the budget or acceptance threshold is reached.

The same product can apply this loop to software. For a web application, Daytona runs the application and Anchor operates its real browser interface. Red submits browser actions or API requests; the verifier checks observable results and authoritative application state. A duplicate request or a broken checkout becomes an exact regression case for the next Blue repair.

| Example | Candidate execution | Reproducible failure evidence | Implementation status |
| --- | --- | --- | --- |
| Hardware buffer | Verilator in Daytona | Clock-edge input sequence and observed signal values | Implemented and verified |
| Checkout web app | Python + SQLite in separate Daytona candidate sandboxes; Anchor operates native Chromium | Actual browser responses, exact actions, independent SQLite snapshots | Implemented; run `pnpm software:demo --open` |

Each new example needs its own contract, Blue/Red instructions, execution driver, attack format, and independent verifier. Both the FIFO and checkout contracts extend `EngineeringContract`. The current adapters implement these two tasks; additional applications still need their own execution and verification definitions. A free-form prompt alone does not provide a trustworthy verifier.

## Run the software example

```sh
pnpm software:demo --open
```

The command uses the configured Daytona and Anchor keys and the existing model runtime. It provisions a real storefront in Daytona, records its native XFCE desktop, and opens the completed MP4 in QuickTime on macOS when `--open` is present. The storefront makes demo purchases only; it has no payment provider.

The initial backend is an explicitly labelled **manually fault-seeded fixture**, never attributed to Blue. Red receives its actual source and returns two bounded browser action sequences. Anchor connects to noVNC and sends mouse and keyboard events into the Chromium window inside Daytona. A separate private CDP connection only reads target geometry and actual browser responses; it also performs fresh-test page setup. This is a recording of the actual sandbox desktop, including the live storefront and terminal.

The independent verifier runs on the controller. It checks the observed HTTP statuses and receipts against a reference purchase model, reads SQLite directly through Daytona, and binds the result to the exact candidate and trusted runtime hashes. Concurrent groups must admit a legal serial ordering. A failure becomes a regression only after the same Anchor actions fail again with a new server process and database.

Blue then writes two real `checkout.py` repair candidates. Each gets its own Daytona sandbox and Git revision. Daytona's supported linked-sandbox network connects the desktop storefront to these isolated backends; it does not require outbound access to external preview hosts. The example freezes the storefront, web harness, and SQLite schema so repairs focus on the backend transaction logic. Children must pass inherited browser regressions, the original attacks, newly adapted Red attacks, seven directed API checks, and two controller-owned held-out streams. Later discoveries also gate earlier candidates. No model self-assessment selects a winner.

The run has a fixed limit of three candidates, 120 adversarial browser actions, and 300 purchase requests. Model calls retain the existing timeouts and bounded transient retry; content-policy refusals stop immediately. Evidence, source, private model provenance, event history, and the MP4 are saved under `data/software-runs/<id>/`. Hidden input sequences are not given to either agent or exported as test artifacts. The desktop and winning application remain available for inspection with 30-minute idle auto-stop; linked app sandboxes are ephemeral and delete when stopped. Other repair sandboxes are removed. Provider keys and the independent verifier never enter candidate sandboxes.

The controller also exposes `POST /api/software/runs` with `{"example":"checkout"}`, plus `GET /api/software/runs`, `GET /api/software/runs/:id`, `GET /api/software/runs/:id/export`, and `POST /api/software/runs/:id/stop`. Starting an API run dispatches the same recorded execution path. Software evidence is stored separately from existing hardware experiments.

The dashboard's **Software progress** view (`/?view=software`) reads this saved evidence and follows running experiments. It charts the same known regressions at each candidate verdict and cumulative verification results over elapsed run time. A coverage table distinguishes passed, failed, and unmeasured checks, with source and model provenance available per version. The fault-seeded baseline stops after its first reproduced failure, so its one recorded check is not presented as comparable to a repair's full suite. Historical runs group checks at their recorded verdicts; new runs record individual check times. Results measure the stated checkout behavior, not an overall website security percentage.

Blue and Red are separate, ephemeral model sessions with separate role instructions and evidence. `BLUE_MODEL` and `RED_MODEL` can select different underlying models; leaving both blank uses the configured Codex default for both. Red proposes bounded browser scenarios, the controller executes them through Anchor, the independent verifier confirms failures, and **Blue writes repairs**. These roles do not currently receive general terminal or browser tool access. The controller owns execution, deployment, regression retention, and acceptance decisions.

## Start the system

Requires Node.js 22+, pnpm 10, Python 3.10+, and a signed-in Codex CLI.

```sh
pnpm install
cp .env.example .env
# Set DAYTONA_API_KEY in .env.
codex login status
pnpm run doctor -- --live
pnpm dev
```

Open [localhost:5173](http://localhost:5173), select Daytona, and click **Start agent team**. The latest completed live experiment opens automatically when one is available. A fresh installation shows a clearly labelled archived behavioral-model example; starting an experiment creates a new live run.

The default model provider is `AGENT_PROVIDER=codex-cli`. It uses the installed CLI's existing sign-in without reading or copying auth files. `BLUE_MODEL` and `RED_MODEL` may be left blank to use the CLI default. Model jobs are ephemeral, have tools disabled, receive only the relevant contract/source/public evidence, and return schema-validated JSON. Their child environments exclude Daytona, Anchor, and model API keys. Each job has a timeout and bounded output. Codex process, connection, service, or rate failures may retry once within that same time budget, using the identical prompt and schema. Authentication, account quota, schema, output, and timeout failures stop immediately. Attempts have separate private artifacts; displayed token usage comes from the successful process. Private prompts, validated answers, and invocation metadata are saved under `data/runs/<id>/agents/`.

An optional Anthropic provider is available with `AGENT_PROVIDER=anthropic`, `ANTHROPIC_API_KEY`, and explicit `BLUE_MODEL` / `RED_MODEL` values. The live verification workflow uses the configured provider; it never falls back to a template when a model fails.

## Hardware execution

For predictable candidate startup, create the prepared snapshot once:

```sh
pnpm snapshot
# Set PROD_SNAPSHOT=hollow-purple-hardware-v1 in .env and restart the controller.
```

Each candidate receives its own private Daytona sandbox and Git revision. The controller validates a restricted synthesizable SystemVerilog subset, uploads the generated RTL plus a fixed observation driver, compiles it with Verilator, and records actual hardware outputs. A separate Python deque oracle runs on the controller; expected outputs and hidden test definitions are not provided to either agent. Compilation failures remain visible diagnostics and can guide Blue's next repair.

Keys without snapshot-create permission can use `PROD_SNAPSHOT=daytona-medium`. The lab installs Verilator, g++, make, and git inside each candidate sandbox when needed. This takes longer than a prepared snapshot. Run creation checks that the configured snapshot is accessible and active before starting paid model calls.

The mandatory directed checks, inherited failure regressions, four newly authored Red attacks, and a separate held-out stream all gate acceptance. A model's opinion cannot select a champion. An earlier passing design must requalify if later candidates expose new regressions. The source hash, model invocation, attack hypotheses/inputs, check results, public raw observations, and counterexample traces are retained.

Sandboxes are deleted and destruction awaited after evaluation unless `KEEP_FORKS=true`. The controller preserves evidence locally. Candidate and cycle budgets bound the experiment; each model call, compilation, and simulation also has a timeout.

```sh
pnpm cleanup                               # Dry run: list this app's sandboxes
pnpm cleanup -- --delete --run=<run-id>     # Remove only a selected run's resources
```

## Anchor Browser verification

Set `ANCHOR_API_KEY` in `.env`. Anchor runs a real cloud browser through Playwright CDP, checks the requested run and read-only controls, opens RTL source and its SHA-256 hash, inspects the frozen contract, navigates the evidence, replays a failure trace when present, and checks for uncaught errors. It saves a real browser screenshot under the run’s evidence directory. Its session is closed after the audit. CDP credentials never reach the frontend or candidate sandboxes.

For a local controller, publish a **read-only evidence snapshot** to Daytona rather than exposing the controller publicly:

```sh
pnpm build
pnpm --filter @hollow-purple/server exec node --import tsx src/scripts/publish-evidence.ts <run-id>
```

The publisher uploads only the built dashboard, sanitized completed-run evidence, and a fixed read-only Python server. It creates a private Daytona sandbox with a signed preview URL. It never uploads `.env`, private agent prompts, auth files, or dependencies. All write requests are refused. Navigation, source inspection, trace replay, and evidence export remain available.

Use the returned URL as `PUBLIC_DASHBOARD_URL` in `.env`, restart the local controller, then run the browser audit from **System**. The configured HTTPS origin is allowlisted; the API accepts no arbitrary target URL. A directly deployed dashboard can also be used.

Preview metadata is stored at `data/runs/<id>/evidence-preview.json`. Signed links expire after six hours, and the preview sandbox auto-stops after 30 idle minutes. Use the scoped cleanup command when it is no longer needed. Browser checks verify the product; the independent hardware verifier controls design acceptance.

## Shared graph memory

Optional SurrealDB Agent Memory integration stores source-bound failures and Blue-written lessons on a run-scoped attack-family graph. A lesson remains proposed until a descendant passes the complete acceptance and regression gate. Only validated parent-family lessons are retrieved for later Blue and Red calls. Read the [memory module guide](apps/server/src/memory/README.md) for configuration, read-only APIs, validation limits and the live graph write/read check. The current controller-owned family hierarchy is not a claim of implemented Red branch mutation.

## Record the actual Daytona sandbox

Record the native Linux desktop while it opens Chromium, inspects RTL, compiles with Verilator, reproduces Red's failure, requests a new Blue model repair, applies it, and rebuilds and reruns the public regression suite:

```sh
pnpm --filter @hollow-purple/server exec node --import tsx src/scripts/record-sandbox.ts <verified-repair-run-id>
```

The controller must be running with that completed repair run loaded. The helper creates a private `daytona-medium` desktop, installs its tools, and records its real XFCE display with Daytona's native recording API. The baseline is explicitly identified as a manually fault-seeded fixture; Red's sequences come from the verified run, and Blue produces a fresh model response. Actual simulation observations are independently graded on the controller. Only public tests enter this inspection desktop; the hidden suite remains part of the original experiment's separate acceptance evidence.

The MP4, source hashes, actual observations, model provenance, and verdicts are saved under `data/runs/<id>/native-desktop/`. When Anchor is configured, it also verifies the encrypted VNC connection, sandbox identity, and actual desktop canvas, saves a screenshot, and ends its browser session. The private noVNC link is saved in `recording.json`. The sandbox remains available for inspection and auto-stops after 30 idle minutes. It consumes the account's sandbox quota until stopped; delete it through Daytona when finished. An optional second argument reuses an empty desktop sandbox labelled `app=hollow-purple,purpose=visible-desktop`.

For a separate replay of the published product dashboard, the earlier browser walkthrough helper remains available:

```sh
pnpm --filter @hollow-purple/server exec node --import tsx src/scripts/record-demo.ts <verified-repair-run-id>
```

That helper requires ffmpeg and a published evidence URL. It records the dashboard through Anchor, saving `data/runs/<id>/hollow-purple-daytona-walkthrough.mp4`. It is a replay of completed execution; it does not show the sandbox desktop. Its Anchor session is closed afterward.

## Release gate (human approval)

A verified champion is not the end of a run: nothing is released until a person approves it. Once a run completes with a champion, the overview's **Release gate** panel starts the approval:

- **Voice (ElevenLabs, default when configured).** **Approve by voice**, then **Talk to the release agent**: the approver speaks with an ElevenLabs agent in the dashboard. It reads the design summary, asks for a yes or no, and calls its `record_decision` client tool. The dashboard posts that decision with the conversation id, and the controller confirms with ElevenLabs that the conversation was held with the release agent before anything is released. The browser never sees the API key; it gets a signed session URL from `GET /api/runs/:id/voice-session`.
- **Phone (optional).** With a Twilio number imported into ElevenLabs, the controller places an outbound call instead, and the agent's webhook tool posts the decision to `POST /api/approval` with the `X-Approve-Secret` header.
- **Dashboard.** **Use dashboard** (or no ElevenLabs configuration) shows **Approve release** and **Decline** buttons.

Only the requested channel can decide. On approval, the champion's exact RTL and a manifest (source hash, contract hash, regression count, approval channel) are written to `data/runs/<id>/release/`, and a `design.released` event is recorded. On a decline or a failed call, nothing is released and the run can't be re-approved. Approval and release events are part of the run's append-only log, so they replay after a restart and appear in the evidence export.

Set up the voice agent once, then put its id in `.env`:

```sh
pnpm --filter @hollow-purple/server exec node --import tsx src/scripts/create-approver-agent.ts
# prints ELEVENLABS_AGENT_ID=agent_...
```

```sh
ELEVENLABS_API_KEY=            # voice and phone
ELEVENLABS_AGENT_ID=           # from create-approver-agent.ts
ELEVENLABS_PHONE_NUMBER_ID=    # phone only: a Twilio number imported into ElevenLabs
APPROVER_PHONE_NUMBER=         # phone only: the phone that rings, E.164 (+1...)
APPROVE_WEBHOOK_SECRET=        # phone only: shared secret for the agent's webhook tool
```

The overview also shows **Single-shot vs evolved**: the best generation-0 design (one model call, no Red feedback) against the champion, scored only by the verifier's checks. Same model, same frozen contract.

## Arize tracing

With `ARIZE_SPACE_ID` and `ARIZE_API_KEY` set, every run is traced to Arize AX as one trace built from its event log: a run span, one span per candidate carrying the verifier's verdict (status, checks passed, hidden checks, inherited regressions), and an LLM span for each Blue and Red model call (model, provider, token counts, attempts, rationale or attack hypotheses). Release-gate approvals and releases appear as spans in the same trace. Spans go over OTLP to `https://otlp.arize.com/v1/traces` (override with `ARIZE_OTLP_URL`); the project name defaults to `hollow-purple` (`ARIZE_PROJECT_NAME`). Without the variables, tracing is off and nothing changes. Check the connection with `pnpm --filter @hollow-purple/server exec node --import tsx src/scripts/verify-arize.ts`.

## Verify changes

### Run a recursive engineering sample

```sh
pnpm --filter @hollow-purple/server exec node --import tsx src/scripts/recursive-demo.ts
pnpm --filter @hollow-purple/web dev
```

The runner prints a local dashboard URL containing its fresh run ID. It owns a loopback-only controller and does not load another controller's journals. The initial FIFO is an explicitly labeled manually broken fixture. Red authors real sequences, Daytona executes the RTL, and the independent controller oracle reproduces a public failure before Blue writes a repair child. Every confirmed counterexample stays in the run's regression suite.

A passing repair receives two additional Red searches using prior attacks as context and different search seeds. An identical prior sequence earns no fresh-audit credit. If a new attack reproduces a failure, Blue creates a deeper descendant with all accumulated regressions. A candidate becomes champion only after every required check and both fresh audits pass. Budgets cap this sample at five designs and eight evaluations; Stop run cancels further work. If no new break is found, the demo reports its tested coverage rather than inventing a new weakness or claiming formal correctness.

Configured graph memory records proposed lessons and validates them against source-bound passing descendants. The runner saves `fullrun.json` and `memory.json` under its own run directory, then leaves the local dashboard available for inspection. Re-audits retain separate sandbox artifact directories and do not count as new generations. The verifier and frozen requirements remain outside the Blue/Red editing surface.

```sh
pnpm test          # Agent transport, engine/acceptance, RTL/attack validation, Python oracle
pnpm build         # All TypeScript checks + production dashboard build
pnpm smoke         # Starts a real model + Daytona experiment; requires live credentials
```

The smoke test checks provenance, generated RTL, all acceptance gates, regression reproduction, and evidence export. It does not manufacture a failure: a correct initial design may pass every attempted attack without needing a repair. A lack of counterexamples is reported as test coverage, not a proof of universal correctness.

To exercise the repair path with an explicitly labelled manual fault fixture, run `pnpm --filter @hollow-purple/server exec node --import tsx src/scripts/verify-live-repair.ts`. A real Red agent must expose a reproducible failure before two model-written Blue children are tested in Daytona. Imported source is never attributed to Blue.

## Contract and APIs

Reset is synchronous, active high, and takes priority over all requests. Reads use pre-edge occupancy. At empty, simultaneous read/write enqueues without bypass. At full, simultaneous read/write accepts both and preserves occupancy. Invalid reads hold `data_out` and clear `read_valid`; reset clears both. Flags and six-bit occupancy describe post-edge state.

The public endpoints are `POST /api/runs` (live Daytona only), `GET /api/runs/:id`, `GET /api/runs/:id/events` (SSE), `POST /api/runs/:id/stop`, `GET /api/runs/:id/export`, and `POST /api/runs/:id/browser-audit`. Interrupted runs are marked stopped on restart. A stop cannot race with completion to revive a run.

```text
packages/shared/src/evolution.ts   Shared contract, agent provenance, attacks, runs, events
apps/server/src/agents/           Blue/Red prompts, schemas, bounded Codex/Anthropic transports
apps/server/src/engine/           Frozen contract, generation/repair/requalification loop
apps/server/src/store.ts          Durable append-only events and replay
apps/server/src/lab/              RTL gate, directed/hidden tests, Daytona simulation, oracle bridge
apps/server/src/software/         Checkout contract, agents, Daytona adapter, Anchor driver, independent verifier, repair loop
apps/server/src/daytona/          Sandbox lifecycle and file/process adapter
apps/server/src/browser/          Anchor session lifecycle and product audit
apps/server/src/scripts/          Doctor, snapshot, live smoke, evidence publishing, cleanup
apps/web/                        Lineage, agent/attack inspection, contract, waveform, source viewer
lab/                             Python oracle, fixed Verilator driver, read-only preview server
lab/software/                    Fixed storefront/runtime, source gate, private CDP relay, explicit faulty checkout fixture
```

The development controller has no user authentication; keep it private. Only the sanitized, read-only evidence server is published by the supplied helper. RTL filtering plus sandbox isolation is a restricted demo execution boundary, not a general guarantee for arbitrary hostile hardware descriptions. No formal or synthesis/timing result is claimed.

## Primary references

- [OpenAI: iterative repair loops with Codex](https://developers.openai.com/cookbook/examples/codex/build_iterative_repair_loops_with_codex) and [non-interactive execution](https://learn.chatgpt.com/docs/non-interactive-mode).
- [Daytona TypeScript SDK](https://www.daytona.io/docs/en/typescript-sdk/) and [snapshots](https://www.daytona.io/docs/en/snapshots/).
- [Daytona preview URLs and automated clients](https://www.daytona.io/docs/en/preview/).
- [Anchor Browser sessions](https://docs.anchorbrowser.io/quickstart/create-session).
- [Verilator overview](https://verilator.org/guide/latest/overview.html) and [command options](https://verilator.org/guide/latest/exe_verilator.html).
- [cocotb](https://docs.cocotb.org/en/stable/) is a future Python testbench path; this implementation uses a fixed C++ observation driver with a Python oracle.
- [SymbiYosys](https://symbiyosys.readthedocs.io/en/latest/) is an optional future formal gate. Any proof must name its exact properties, assumptions, solver, and scope.
