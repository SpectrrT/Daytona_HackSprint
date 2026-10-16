# Antibody: 3-minute pitch

About 420 spoken words, which is roughly 2:45 at a steady pace. The release agent speaks for about 15 seconds during beat 5. Lines in brackets are stage directions; don't read them aloud. Beat numbers match the beat sheet below.

## Before you go on

- Run `pnpm dev`. In Claude Code, in this repository, approve the `antibody` MCP server and allow its tools so no permission prompt appears on stage. Ask Claude for `lab_status`: "Daytona HDL simulation", "Blue and Red agents" and "Arize tracing" should be ready, and the "Release approval" check should mention the ElevenLabs release agent.
- Allow the microphone in the dashboard tab. Without it, the release agent can't hear you.
- A live run takes roughly 2 to 4 minutes per design, and the smallest budget is 3 designs, so a run started on stage won't finish during the pitch. About 15 minutes before your slot, have Claude start a warm-up run with the beat 1 prompt and note its run id. On stage, beat 1 starts a fresh run, and beats 3 to 5 use the warm-up run.
- Beat 3 needs a reproduced failure, and a normal run may not produce one, because a correct design can pass every attack. Before your slot, ask Claude for `get_failure_evidence` on the warm-up run. To make beat 3 far more likely, use the recursive sample as the warm-up run. It starts from a FIFO we broke on purpose, labelled "NOT Blue-generated", and Blue writes a repair only after a failure is reproduced. It can run up to five designs and eight evaluations, so start it early. It runs its own controller on port 8787 and doesn't load older runs, so stop `pnpm dev` first, then run these two commands from the repository root:

```bash
pnpm --filter @antibody/server exec node --import tsx src/scripts/recursive-demo.ts
```

```bash
pnpm --filter @antibody/web dev
```

- Warm-up run for beats 3 to 5: on Tensae's laptop, `0061f2cb-dcf2-4e87-8128-615b19b1aa1c` is a completed recursive-sample run with a reproduced failure, a regression test, a champion and a pending voice approval. A second completed run, `47aba9b2-3ab3-4039-9949-54d313b5bd2a`, has a champion and a pending voice approval but no reproduced failure, and it's visible only under the normal controller (`pnpm dev`). Don't approve or decline either run in rehearsal: after a champion is released or declined, it can't be approved again.

## Script

**[0:00, hook]**

Coding agents now write code faster than anyone can review it. So the hard question isn't whether a model can write it. It's who checks the model.

Antibody is an adversarial engineering loop. Blue, a model agent, builds a design. Red, a separate agent, reads that design and tries to break it. Neither gets a vote. An independent verifier decides, from evidence.

And there's no new tool to learn: Antibody is an MCP server.

**[Beat 1: Claude Code starts the run]**

I just asked Claude Code to harden our sensor FIFO with a three-design budget, tell me what Red tried, then ask me to approve the champion by voice. Claude started a live run in Daytona.

**[Beat 2: the Agents view]**

Here's what Claude is following. Blue explains its design. Red reads the RTL and writes four attacks: clock-edge input sequences, each with a hypothesis about how this exact design breaks. Daytona gives every design its own sandbox, where Verilator compiles it and replays every attack. The verdict comes from a Python reference model on our controller, out of reach of both agents. They never see the hidden tests, and no model's opinion can pick a winner.

**[Beat 3: a reproduced failure becomes a regression test]**

When a design breaks, the verifier replays the failure independently. If it reproduces, it becomes a permanent regression test: the clock cycle, the expected and actual values, the exact inputs. Every descendant must pass it. Only a reproduced failure can write a lesson to our SurrealDB graph memory, and a lesson counts only after a repaired design passes every gate.

**[Beat 4: a champion is selected]**

A champion must pass the directed checks, Red's attacks, every inherited regression and a hidden held-out stream. If a later design exposes a new failure, earlier winners have to requalify.

**[Beat 5: voice release]**

Even then, nothing ships on its own. No tool can approve a release, not even Claude. A person has to, so I'll talk to our ElevenLabs release agent.

[The agent reads the summary and asks for a yes or no.]

Yes, release it.

The controller confirms with ElevenLabs that this conversation was held with our release agent, then writes the release bundle: the exact RTL and a manifest of its hashes.

**[Close]**

Arize traces every Blue and Red call and every verdict. Blue and Red can run on Claude through AWS Bedrock. And the same loop already runs on software: a checkout app in Daytona, with Anchor driving a real browser.

This is simulation evidence, not a formal proof. But every claim has a receipt. We built a dashboard, but you don't need one: Claude is the interface. Ask in plain English, and get back a tested design, the failures that shaped it, and a person's yes. That's Antibody.

## Live demo beat sheet

| Beat | Time | Screen | Do | Point at |
| --- | --- | --- | --- | --- |
| 1. Claude Code starts a hardening run | 0:30 | Claude Code | Send: *"Harden the sensor FIFO with a 3-design budget, tell me what Red tried against each design, then ask me to approve the champion by voice."* Without "by voice", the approval request uses the phone if phone approval is configured. | Claude calls `start_hardening_run`. Its reply has the `run_id` and an `agent_console` link. |
| 2. Agents view | 0:45 | Dashboard, `http://localhost:5173/?run=<id>&view=agents` | Open the `agent_console` link. Pick a design in the roster to show only its agents. If the fresh run is still on its first design, say the fallback line and open the warm-up run's Agents view. | **BLUE**: the design rationale. **RED**: four attack hypotheses, each an N-cycle input. **DAYTONA**: "Compiling c1 with Verilator and replaying every attack". **VERIFIER**: the verdict. The "working now" line shows who is busy and for how long. |
| 3. Reproduced failure becomes a regression test | 1:15 | Agents view, or the **Evidence** tab | Select the failed design in the roster. Click the **Verifier** chip, then the **Memory** chip. | **VERIFIER ✗**: test name, cycle, expected vs. got, "independently replayed". **MEMORY**: "Verified failure retained permanently". With SurrealDB on, also "Blue proposed a lesson … Pending descendant validation". The Evidence tab's **Regression library** lists the permanent tests. |
| 4. Champion selected | 1:40 | Agents view | Click **ALL** at the top of the roster and the **All** chip, then scroll to the end of the run. | **VERIFIER ✓**: the champion line, which names the gates the design passed. The roster marks that design "champion". |
| 5. Voice approval and release bundle | 1:50 | Dashboard **Overview**, **Release gate** panel | If the panel shows **Approve by voice**, click it. Then click **Talk to the release agent**, let it read the summary, and answer "Yes, release it." | "Recorded: approved. The design is being released." In the Agents view, a **HUMAN ✓** line with `runs/<id>/release · approved by voice`. On disk: `data/runs/<id>/release/<champion>.sv` and `manifest.json`. |

If beat 3 comes up with no failure, say: "Red didn't break this design. That's test coverage, not proof. When Red does break one, this is where it lands," and point at the Regression library.

## Fallback line (about 20 seconds)

Say this when you switch from the fresh run to the warm-up run:

> "Every design here gets real model calls and a real Verilator run in Daytona, so each one takes a few minutes. Claude keeps following this run. Meanwhile, here's one we started before the talk: same contract, same verifier, nothing staged. Its champion is waiting for a person's yes."

If the warm-up run is the recursive sample, replace "nothing staged" with "it starts from a FIFO we broke on purpose, and it's labelled that way."

## Keep the claims straight

- This is simulation evidence under a frozen contract. Don't claim a formal proof, synthesis, timing or area results.
- Call Blue and Red "model agents". Say Claude wrote a design only if `lab_status` reports `agent_runtime` as `anthropic` or `bedrock`. Every live run on this laptop so far used the Codex CLI default.
- SurrealDB gets a lesson only after a failure is independently reproduced, and the lesson stays "proposed" until a repaired descendant passes the full gate.
- Claude can only request approval. The decision always comes from a person.
- Quote only numbers you can open on screen from a live run. Never quote numbers from the "Archived example" run or from a fake or test backend.
