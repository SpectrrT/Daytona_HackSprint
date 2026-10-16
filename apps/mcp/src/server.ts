import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { BUFFER_PROMPT, type ApprovalChannel, type EvolutionRun, type EvolutionSystem, type RunSummary } from "@hollow-purple/shared/evolution";
import { activeWork, buildTranscript, formatTranscript, type Speaker } from "@hollow-purple/shared/transcript";
import { registerAgentLabTools } from "./agent-lab.js";

/**
 * Hollow Purple as a Claude tool. Claude starts an adversarial run, follows it live, reads what Blue and Red said,
 * pulls the reproduced failures and the verified source, and can ask a human to approve a release. It talks to the
 * controller's HTTP API, so it sees exactly what the dashboard sees. It can never approve a release: only a person can.
 */

const LAB = (process.env.HOLLOW_PURPLE_URL ?? "http://localhost:8787").replace(/\/$/, "");
const DASHBOARD = (process.env.HOLLOW_PURPLE_DASHBOARD ?? "http://localhost:5173").replace(/\/$/, "");
const SPEAKERS = ["blue", "red", "daytona", "verifier", "memory", "human", "anchor", "system"] as const satisfies readonly Speaker[];

export async function lab<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${LAB}${path}`, { ...init, headers: { "content-type": "application/json", ...init?.headers }, signal: AbortSignal.timeout(20_000) });
  } catch {
    throw new Error(`The Hollow Purple controller is not reachable at ${LAB}. Start the terminal integration with \`pnpm claude\`, or start the controller with \`pnpm --filter @hollow-purple/server dev\` (\`pnpm dev\` also works).`);
  }
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new Error(body.error ?? `The controller returned HTTP ${response.status}.`);
  return body as T;
}

const reply = (value: string) => ({ content: [{ type: "text" as const, text: value }] });
const json = (value: unknown) => reply(JSON.stringify(value, null, 2));

export function summarize(run: EvolutionRun) {
  const champion = run.candidates.find((c) => c.id === run.championId);
  const passed = (checks: { passed: boolean }[]) => checks.filter((check) => check.passed).length;
  return {
    id: run.id,
    status: run.status,
    dashboard: `${DASHBOARD}/?run=${run.id}`,
    started: new Date(run.createdAt).toISOString(),
    finished: run.finishedAt ? new Date(run.finishedAt).toISOString() : undefined,
    outcome: run.summary ?? run.error,
    working_now: activeWork(run)?.text,
    designs_used: `${run.candidates.length} of ${run.budget.maxCandidates}`,
    regression_tests: run.regressions.length,
    champion: champion
      ? { id: champion.id, label: champion.label, checks: `${passed(champion.checks)}/${champion.checks.length}`, source_sha256: champion.sourceHash }
      : null,
    designs: run.candidates.map((c) => ({
      id: c.id,
      generation: c.generation,
      parent: c.parentId,
      label: c.label,
      status: c.status,
      checks: `${passed(c.checks)}/${c.checks.length}`,
      red_attacks: c.attacks?.length ?? 0,
      failure: c.failure?.summary ?? c.buildError,
    })),
    approval: run.approval ?? null,
    release: run.release ?? null,
  };
}

export function createServer(): McpServer {
  const server = new McpServer(
    { name: "hollow-purple", version: "0.2.0" },
    {
      instructions: [
        "Hollow Purple hardens engineering work adversarially in Daytona sandboxes: Blue writes a design, Red reads it and writes attacks, and an independent verifier decides. Every reproduced failure becomes a permanent regression test that descendants must pass.",
        "For tool-using agents, prompt injection, purchasing, support or release controls: agent_lab_status → start_agent_hardening → watch_agent_run repeatedly, carrying next_after_event, until settled → get_agent_failures → get_agent_repair → get_agent_result. Stay in Claude's terminal; no website or dashboard is needed. The current agent suite uses three explicit frozen contracts, not an arbitrary external target.",
        "A new run must actually be started when requested. Existing runs are archived evidence, never a substitute. Follow the run to its measured verdict even when model calls take several minutes. Report actual Red inputs, reproduced effects, Blue source edits and useful-work checks. Never claim universal security or attribute the manual starter to Blue.",
        "For explicitly requested hardware/FIFO designs only: lab_status → start_hardening_run → watch_run repeatedly (pass back next_after_seq) → get_agent_transcript, get_failure_evidence and get_design_source.",
        "Runs spend real Daytona and model credits and take a few minutes per design. Only a human can approve a release: request_release_approval asks for it; nothing here can grant it.",
      ].join("\n"),
    },
  );

  registerAgentLabTools(server, lab);

  server.registerTool("lab_status", {
    title: "Lab status",
    description: "Which providers are ready (Daytona, Blue/Red agents, Arize tracing, release approval channels) and the controller's health.",
    annotations: { readOnlyHint: true },
  }, async () => {
    const system = await lab<EvolutionSystem>("/api/system");
    return json({ controller: LAB, dashboard: DASHBOARD, agents_ready: system.agentsReady, agent_runtime: system.agentProvider, approval_channel: system.approvalChannel, checks: system.checks });
  });

  server.registerTool("list_runs", {
    title: "List runs",
    description: "Recent runs, newest first, with status, design count and champion.",
    inputSchema: { limit: z.number().int().min(1).max(50).default(10) },
    annotations: { readOnlyHint: true },
  }, async ({ limit }) => {
    const runs = await lab<RunSummary[]>("/api/runs");
    return json(runs.slice(0, limit).map((run) => ({ ...run, createdAt: new Date(run.createdAt).toISOString() })));
  });

  server.registerTool("start_hardening_run", {
    title: "Start a hardening run",
    description: "Start a live adversarial run in Daytona: Blue writes designs for the frozen contract, Red attacks each one, the verifier keeps failures as regression tests. Spends credits; allow roughly 2-4 minutes per design. Follow it with watch_run.",
    inputSchema: {
      max_candidates: z.number().int().min(3).max(12).default(3).describe("Design budget for the run"),
      seed: z.number().int().min(0).max(0xffff_ffff).optional().describe("Deterministic search seed"),
      prompt: z.string().min(10).max(2000).optional().describe("Engineering prompt; defaults to the supported 32-entry sensor FIFO"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, async ({ max_candidates, seed, prompt }) => {
    const created = await lab<{ id: string }>("/api/runs", { method: "POST", body: JSON.stringify({ prompt: prompt ?? BUFFER_PROMPT, provider: "daytona", maxCandidates: max_candidates, ...(seed !== undefined ? { seed } : {}) }) });
    return json({ run_id: created.id, dashboard: `${DASHBOARD}/?run=${created.id}`, agent_console: `${DASHBOARD}/?run=${created.id}&view=agents`, next: "Call watch_run with this run_id to follow Blue, Red and the verifier live." });
  });

  server.registerTool("watch_run", {
    title: "Watch a run",
    description: "Wait for new activity in a run (up to wait_seconds) and return what Blue, Red, Daytona and the verifier said since after_seq. Call again with next_after_seq until status is completed, failed or stopped.",
    inputSchema: {
      run_id: z.string().min(1),
      after_seq: z.number().int().min(0).default(0).describe("Return only events after this sequence number"),
      wait_seconds: z.number().int().min(0).max(120).default(45),
    },
    annotations: { readOnlyHint: true },
  }, async ({ run_id, after_seq, wait_seconds }) => {
    const deadline = Date.now() + wait_seconds * 1000;
    let run = await lab<EvolutionRun>(`/api/runs/${encodeURIComponent(run_id)}`);
    const settled = (r: EvolutionRun) => !["running", "queued"].includes(r.status);
    while (!settled(run) && (run.events.at(-1)?.seq ?? 0) <= after_seq && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      run = await lab<EvolutionRun>(`/api/runs/${encodeURIComponent(run_id)}`);
    }
    const lines = buildTranscript(run).filter((line) => line.seq > after_seq);
    const next = run.events.at(-1)?.seq ?? after_seq;
    const now = activeWork(run);
    return reply([
      `status: ${run.status} · next_after_seq: ${next} · designs: ${run.candidates.length}/${run.budget.maxCandidates}${run.championId ? ` · champion: ${run.championId}` : ""}`,
      now ? `working now: ${now.text} (${Math.round((Date.now() - now.since) / 1000)}s)` : "",
      lines.length ? formatTranscript(lines) : "(no new activity yet)",
    ].filter(Boolean).join("\n"));
  });

  server.registerTool("get_run", {
    title: "Run summary",
    description: "Status, every design with its verdict, the champion, regression count, approval and release state.",
    inputSchema: { run_id: z.string().min(1) },
    annotations: { readOnlyHint: true },
  }, async ({ run_id }) => json(summarize(await lab<EvolutionRun>(`/api/runs/${encodeURIComponent(run_id)}`))));

  server.registerTool("get_agent_transcript", {
    title: "Agent transcript",
    description: "What the agents said and did: Blue's rationale for each design, Red's hypotheses and attacks, Daytona executions, verifier verdicts, lessons, approvals. Filter by design and/or speaker.",
    inputSchema: {
      run_id: z.string().min(1),
      candidate_id: z.string().optional().describe("Only this design, e.g. c2"),
      speaker: z.enum(SPEAKERS).optional(),
    },
    annotations: { readOnlyHint: true },
  }, async ({ run_id, candidate_id, speaker }) => {
    const run = await lab<EvolutionRun>(`/api/runs/${encodeURIComponent(run_id)}`);
    const lines = buildTranscript(run).filter((line) => (!candidate_id || line.candidateId === candidate_id) && (!speaker || line.speaker === speaker));
    return reply(lines.length ? formatTranscript(lines) : "No matching transcript lines.");
  });

  server.registerTool("get_failure_evidence", {
    title: "Failure evidence",
    description: "Independently reproduced failures (the permanent regression tests): what broke, at which clock cycle, expected vs actual, and the exact input sequence.",
    inputSchema: { run_id: z.string().min(1), candidate_id: z.string().optional() },
    annotations: { readOnlyHint: true },
  }, async ({ run_id, candidate_id }) => {
    const run = await lab<EvolutionRun>(`/api/runs/${encodeURIComponent(run_id)}`);
    const failures = run.candidates
      .filter((c) => c.failure && (!candidate_id || c.id === candidate_id))
      .map((c) => ({
        design: c.id,
        test: c.failure!.testName,
        summary: c.failure!.summary,
        cycle: c.failure!.cycle,
        expected: c.failure!.expected,
        actual: c.failure!.actual,
        reproduced: c.failure!.reproduced,
        input_sequence: c.failure!.sequence,
      }));
    return json({ regression_tests: run.regressions.map((r) => r.testName), failures });
  });

  server.registerTool("get_design_source", {
    title: "Design source",
    description: "The RTL source of a design (default: the champion), with its verdict and SHA-256. Only a verified champion passed every check.",
    inputSchema: { run_id: z.string().min(1), candidate_id: z.string().optional() },
    annotations: { readOnlyHint: true },
  }, async ({ run_id, candidate_id }) => {
    const run = await lab<EvolutionRun>(`/api/runs/${encodeURIComponent(run_id)}`);
    const id = candidate_id ?? run.championId;
    const design = run.candidates.find((c) => c.id === id);
    if (!design) return reply(candidate_id ? `No design ${candidate_id} in this run.` : "This run has no champion yet. Pass a candidate_id to read another design.");
    const verdict = design.id === run.championId ? "champion: passed every directed, Red, hidden and regression check" : `status: ${design.status}`;
    return reply(`// ${design.label} (${design.id}) · ${verdict}\n// sha256 ${design.sourceHash ?? "unknown"}\n${design.source}`);
  });

  server.registerTool("request_release_approval", {
    title: "Request release approval",
    description: "Ask a human to approve releasing the run's verified champion: by voice with the ElevenLabs release agent in the dashboard, or with dashboard buttons. This only requests approval; it cannot grant it.",
    inputSchema: { run_id: z.string().min(1), channel: z.enum(["voice", "dashboard", "phone"]).optional() },
    annotations: { readOnlyHint: false, destructiveHint: false },
  }, async ({ run_id, channel }) => {
    const run = await lab<EvolutionRun>(`/api/runs/${encodeURIComponent(run_id)}/approval/request`, { method: "POST", body: JSON.stringify(channel ? { channel } : {}) });
    const chosen: ApprovalChannel | undefined = run.approval?.channel;
    return json({
      approval: run.approval,
      next: chosen === "voice"
        ? `A person opens ${DASHBOARD}/?run=${run.id} and presses "Talk to the release agent".`
        : chosen === "phone" ? "The approver's phone is ringing." : `A person approves or declines in ${DASHBOARD}/?run=${run.id}.`,
    });
  });

  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = createServer();
  await server.connect(new StdioServerTransport());
}
