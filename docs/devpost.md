# Antibody

**Tagline:** Blue builds it, Red tries to break it, an independent verifier decides, and only a person can ship it, all driven from Claude Code on Daytona.

## Inspiration

Coding agents write code faster than teams can review it, and too many agent loops end when the model says it's done. We wanted a loop where no model grades its own work: a second agent attacks every design, and only reproduced evidence counts. We started with hardware, where clock-edge bugs are unforgiving.

## What it does

Antibody hardens a design against a frozen contract, starting with a 32-entry, 16-bit FIFO.

- **Blue**, a model agent, writes the RTL. **Red**, a separate agent, reads it and writes four clock-edge attack sequences.
- **Daytona** gives each design its own sandbox, where Verilator compiles it and replays directed checks, Red's attacks, every inherited regression and a hidden held-out stream that neither agent sees.
- **An independent verifier**, a Python reference model on the controller, decides.
- A failure the verifier reproduces becomes a **permanent regression test** that every descendant must pass, and Blue branches repairs from it.
- **Nothing ships until a person approves the champion**, by voice with an ElevenLabs agent or in the dashboard. Then its exact RTL and a hash manifest become the release bundle.

Claude Code or Claude Desktop drives it all through our MCP server: start a run, follow Blue and Red live, read the failures and the verified source. No custom UI needed.

The same loop runs on a checkout web app: Python and SQLite in Daytona, with Anchor driving a real browser.

## How we built it

- TypeScript: a Hono controller, a React dashboard and an MCP server over one append-only event log, so Claude and the dashboard show the same transcript.
- Blue and Red are separate, bounded model jobs with schema-validated output: Codex CLI by default, or Claude through the Anthropic API or AWS Bedrock.
- **SurrealDB** holds a lesson graph. A lesson is written only after a reproduced failure, and stays "proposed" until a repaired descendant passes the full gate.
- **Arize AX** traces each run: verifier verdicts, every Blue and Red call, and the release gate.
- **ElevenLabs** hosts the release agent, and the controller verifies each conversation with ElevenLabs.
- **Anchor** audits the dashboard in a cloud browser and drives Chromium inside Daytona for the checkout.

## Challenges we ran into

- A content filter declined Red's "attack" request and killed a rehearsal. Now a declined or timed-out call rejects just that design instead of accepting it unchallenged, and the run continues.
- Keeping the verifier out of reach: hidden tests never reach either agent, model jobs run without our API keys, and unreproduced failures never become regressions.

## Accomplishments that we're proud of

- Live runs where model-written RTL is compiled and attacked in Daytona, and the verifier, not a model, picks the champion.
- A release that no tool can approve, Claude included.
- Red's sequences exposed all ten hand-seeded FIFO bugs, with no reproduced violation on a clean control design. Our fixed checks catch these simple faults too, so this shows fault-finding, not extra coverage.

## What we learned

- Confidence isn't evidence. A reproduced failure with its exact inputs is.
- Memory must earn its place. Our completed Claude-on-Bedrock synthesis and compound-repair studies did not demonstrate an accuracy advantage for graph memory. The separate concurrent-retry comparison did show a system benefit: 9/9 correct retries with our verified guard versus 0/9 for model-only execution of the same actual Claude proposals, with 9/9 clean controls in both arms. See [measured evidence and limitations](evidence.md).
- "No failure found" is coverage, not proof.
- MCP beat building more UI: Claude can already start, follow and explain a run.

## What's next

- Bring graph memory and the release gate into the checkout loop.
- Reuse lessons across runs. Memory is per-run today.
- An optional SymbiYosys formal gate with stated properties and scope.
- More contracts, each with its own execution driver and independent verifier.

## Built with

Daytona · Verilator · SystemVerilog · C++ · Python · SQLite · TypeScript · Node.js · Hono · React · Model Context Protocol · Claude Code · Anthropic Claude · AWS Bedrock · OpenAI Codex CLI · SurrealDB · Arize AX · OpenTelemetry · ElevenLabs · Anchor Browser · Playwright
