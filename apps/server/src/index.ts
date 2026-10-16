import { readTimeseries, rowsFromHardwareRun, writeTimeseries } from "./charts/series.js";
import { readAblationSummary } from "./ablation/read.js";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { config, ConfigError } from "./config.js";
import { CapacityError, EvolutionEngine } from "./engine/index.js";
import { supportsPrompt } from "./engine/contract.js";
import { requireHardwareSnapshot } from "./daytona/client.js";
import { runAnchorAudit } from "./browser/session.js";
import { store as defaultStore, type RunStore } from "./store.js";
import { configuredMemory } from "./memory/index.js";
import { telemetryStatus, flushTelemetry } from "./telemetry/index.js";
import { approvalChannel, availableChannels, decide, pendingPhoneRun, ReleaseError, requestApproval, voiceSession, webhookAuthorized } from "./release/index.js";
import { arizeConfigured, startArizeTracing } from "./telemetry/arize.js";
import type { EvolutionEvent } from "@antibody/shared/evolution";
import { SoftwareService } from "./software/service.js";
import { AgentLabService } from "./agent-lab/service.js";
import { LabConnectionChecks } from "./agent-lab/connections.js";
import { SandboxAccessError } from "./agent-lab/sandboxes.js";
import { retrySummary } from "./benchmarks/retry-summary.js";
import { AGENT_ENVIRONMENTS } from "@antibody/shared/agent-lab";
import { labDirectory } from "./agent-lab/engine.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Server } from "node:http";
import { NativeViewerProxy } from "./agent-lab/native-viewer-proxy.js";

const createSchema = z.object({
  prompt: z.string().trim().min(10).max(2000).refine(supportsPrompt, "The current hardware example supports a 32-entry, 16-bit synchronous FIFO. Other engineering tasks need their own contract and verifier."),
  provider: z.literal("daytona").default("daytona"),
  maxCandidates: z.number().int().min(3).max(12).optional(),
  seed: z.number().int().min(0).max(0xffff_ffff).optional(),
}).strict();

let agentCheck: { ts: number; ready: boolean } | undefined;
function agentsReady(): boolean {
  if (config.AGENT_PROVIDER === "bedrock") return !!(config.BEDROCK_CREDENTIALS_FILE && config.BLUE_MODEL && config.RED_MODEL);
  if (config.AGENT_PROVIDER === "anthropic") return Boolean(config.ANTHROPIC_API_KEY && config.BLUE_MODEL && config.RED_MODEL);
  if (agentCheck && Date.now() - agentCheck.ts < 30_000) return agentCheck.ready;
  const check = spawnSync(config.CODEX_BIN, ["login", "status"], {
    encoding: "utf8", timeout: 5000,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, ...(process.env.CODEX_HOME ? { CODEX_HOME: process.env.CODEX_HOME } : {}) },
  });
  agentCheck = { ts: Date.now(), ready: check.status === 0 };
  return agentCheck.ready;
}

export function createApp(store: RunStore = defaultStore, engine = new EvolutionEngine(store, undefined, undefined, configuredMemory()), software = new SoftwareService(), agentLab = new AgentLabService(), viewer?: NativeViewerProxy): Hono {
  const app = new Hono();
  const audits = new Set<string>();
  const labConnections = new LabConnectionChecks();
  app.use("/api/*", bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json({ error: "Request body exceeds 16 KiB." }, 413) }));
  app.onError((error, c) => {
    if (error instanceof ConfigError) return c.json({ error: error.message }, 503);
    if (error instanceof CapacityError) return c.json({ error: error.message }, 429);
    if (error instanceof ReleaseError) return c.json({ error: error.message }, error.status);
    if (error instanceof SandboxAccessError) return c.json({ error: error.message }, error.status);
    console.error("[api]", error.message);
    return c.json({ error: "The request failed. Check the server log and retained run evidence." }, 500);
  });
  app.get("/api/ablation/latest", async c => {
    try { return c.json(await readAblationSummary()); }
    catch { return c.json({ status: "missing", summary: [] }); }
  });
  app.get("/api/benchmarks/retries/latest", async c => {
    try { return c.json(await retrySummary()); } catch { return c.json({ status: "no run yet", summary: [] }); }
  });
  app.get("/api/charts/:id/events", c => {
    const id=c.req.param("id");
    if(!/^[a-zA-Z0-9_-]{1,100}$/.test(id))return c.json({error:"Invalid run ID."},400);
    return streamSSE(c,async stream=>{
      let ended=false;let revision="";let wake:(()=>void)|undefined;
      stream.onAbort(()=>{ended=true;wake?.();});
      while(!ended){
        const rows=await readTimeseries(id).catch(()=>[]);
        const next=JSON.stringify(rows);
        if(next!==revision){await stream.writeSSE({event:"timeseries",data:next});revision=next;}
        await new Promise<void>(resolve=>{const timer=setTimeout(resolve,1000);wake=()=>{clearTimeout(timer);resolve();};if(ended)wake();});
      }
    });
  });
  app.get("/api/health", (c) => c.json({ status: "ok" }));
  app.get("/api/agent-lab/status", c => c.json({ ready: Boolean(config.DAYTONA_API_KEY && config.ANCHOR_API_KEY && agentsReady()), environments: AGENT_ENVIRONMENTS }));
  app.get("/api/agent-lab/connections", async c => c.json(await labConnections.get()));
  app.get("/api/agent-lab/runs", async c => c.json(await agentLab.list()));
  app.post("/api/agent-lab/runs", async c => {
    const body = z.object({ suite: z.literal("cross-domain"), prompt: z.string().trim().min(5).max(2000).optional() }).strict().safeParse(await c.req.json().catch(() => undefined));
    if (!body.success) return c.json({ error: "Use {suite:'cross-domain'} for the current agent suite." }, 400);
    if (!agentsReady()) return c.json({ error: "The configured model runtime is unavailable." }, 503);
    try { return c.json({ id: agentLab.start({ prompt: body.data.prompt }) }, 202); } catch (error) { return c.json({ error: error instanceof Error ? error.message : "Agent experiment could not start." }, 409); }
  });
  app.get("/api/agent-lab/runs/:id", async c => {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(c.req.param("id"))) return c.json({ error: "Invalid run ID." }, 400);
    const run = await agentLab.get(c.req.param("id")); return run ? c.json(run) : c.json({ error: "Agent experiment not found." }, 404);
  });
  app.get("/api/agent-lab/runs/:id/export", async c => {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(c.req.param("id"))) return c.json({ error: "Invalid run ID." }, 400);
    const run = await agentLab.get(c.req.param("id")); if (!run) return c.json({ error: "Agent experiment not found." }, 404);
    c.header("Content-Disposition", `attachment; filename="agent-lab-${run.id}.json"`); return c.json(run);
  });
  app.get("/api/agent-lab/runs/:id/sandboxes", async c => {
    const id = c.req.param("id"); if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) return c.json({ error: "Invalid run ID." }, 400);
    const run = await agentLab.get(id);
    if (!run || run.status === "queued") return c.json({ error: "Sandboxes have not been provisioned for this run." }, 404);
    c.header("Cache-Control", "no-store");
    return c.json({ ...await agentLab.sandboxAccess.list(run), ...(run.roleWorkspaceError ? { error: run.roleWorkspaceError } : {}) });
  });
  app.post("/api/agent-lab/runs/:id/sandboxes/:key/preview", async c => {
    const id = c.req.param("id"), key = c.req.param("key");
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id) || !/^[a-zA-Z0-9_-]{1,100}$/.test(key)) return c.json({ error: "Invalid run or sandbox key." }, 400);
    const body = z.object({ resume: z.boolean().default(false) }).strict().safeParse(await c.req.json().catch(() => undefined));
    if (!body.success) return c.json({ error: "Use {resume:true} to resume this run’s sandbox." }, 400);
    const run = await agentLab.get(id);
    if (!run || run.status === "queued") return c.json({ error: "Sandbox not found for this run." }, 404);
    c.header("Cache-Control", "no-store");
    const preview = await agentLab.sandboxAccess.preview(run, key, body.data.resume);
    return c.json(viewer && preview.kind === "desktop" ? viewer.issue(run, key, preview, c.req.header("Origin") ?? new URL(c.req.url).origin) : preview);
  });
  app.get("/api/agent-lab/runs/:id/video", async c => {
    const id = c.req.param("id"); if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) return c.json({ error: "Invalid run ID." }, 400);
    const run = await agentLab.get(id); if (!run || run.status !== "completed") return c.json({ error: "Completed recording not available." }, 404);
    const video = await readFile(join(labDirectory(id), "daytona-agent-workbench.mp4")).catch(() => undefined); if (!video) return c.json({ error: "Recording not found." }, 404);
    c.header("Content-Type", "video/mp4"); c.header("Content-Disposition", "inline"); return c.body(new Uint8Array(video));
  });
  app.post("/api/agent-lab/runs/:id/stop", async c => {
    const id = c.req.param("id"); if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) return c.json({ error: "Invalid run ID." }, 400);
    if (!await agentLab.get(id)) return c.json({ error: "Agent experiment not found." }, 404);
    try { await agentLab.stop(id); return c.json(await agentLab.get(id)); } catch (error) { return c.json({ error: error instanceof Error ? error.message : "Could not stop the experiment." }, 409); }
  });
  app.get("/api/telemetry/status", (c) => c.json(telemetryStatus()));
  app.get("/api/software/runs", async c => c.json(await software.list()));
  app.post("/api/software/runs", async c => {
    const body = z.object({ example: z.literal("checkout") }).strict().safeParse(await c.req.json().catch(() => undefined));
    if (!body.success) return c.json({ error: "Use {example:'checkout'} for the current software adapter." }, 400);
    try { return c.json({ id: software.start() }, 202); }
    catch (error) { return c.json({ error: error instanceof Error ? error.message : "Software run could not start." }, 409); }
  });
  app.get("/api/software/runs/:id", async c => {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(c.req.param("id"))) return c.json({ error: "Invalid run ID." }, 400);
    const run = await software.get(c.req.param("id"));
    return run ? c.json(run) : c.json({ error: "Software run not found." }, 404);
  });
  app.get("/api/software/runs/:id/export", async c => {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(c.req.param("id"))) return c.json({ error: "Invalid run ID." }, 400);
    const run = await software.get(c.req.param("id"));
    if (!run) return c.json({ error: "Software run not found." }, 404);
    c.header("Content-Disposition", `attachment; filename="software-${run.id}.json"`);
    return c.json(run);
  });
  app.post("/api/software/runs/:id/stop", async c => {
    const id = c.req.param("id");
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) return c.json({ error: "Invalid run ID." }, 400);
    if (!await software.get(id)) return c.json({ error: "Software run not found." }, 404);
    await software.stop(id); return c.json(await software.get(id));
  });

  app.get("/api/system", (c) => c.json({
    providers: { daytona: Boolean(config.DAYTONA_API_KEY), anchor: Boolean(config.ANCHOR_API_KEY && config.PUBLIC_DASHBOARD_URL), model: agentsReady() },
    agentsReady: agentsReady(), agentProvider: config.AGENT_PROVIDER,
    agentModel: config.BLUE_MODEL ?? "Codex default", defaultProvider: "daytona",
    publicDashboardUrl: config.PUBLIC_DASHBOARD_URL,
    approvalChannel: approvalChannel(),
    approvalChannels: availableChannels(),
    checks: [
      { name: "Local simulation", ok: true, detail: "Deterministic candidate models checked by an independent queue oracle; no cloud credentials required." },
      { name: "Daytona HDL simulation", ok: Boolean(config.DAYTONA_API_KEY), detail: config.DAYTONA_API_KEY ? "Configured. Candidates run Verilator inside separate Daytona sandboxes." : "Set DAYTONA_API_KEY to enable isolated Verilator runs." },
      { name: "Anchor Browser", ok: Boolean(config.ANCHOR_API_KEY && config.PUBLIC_DASHBOARD_URL), detail: "Cloud browser audits require ANCHOR_API_KEY and a publicly reachable PUBLIC_DASHBOARD_URL." },
      { name: "Arize tracing", ok: arizeConfigured(), detail: arizeConfigured() ? "Hardware evolution runs, candidate verdicts, and Blue / Red model calls are traced to Arize AX." : "Set ARIZE_SPACE_ID and ARIZE_API_KEY to trace runs and model calls in Arize AX." },
      { name: "Release approval", ok: true, detail: approvalChannel() === "phone" ? "Champions are released only after the approver says yes on an ElevenLabs call." : approvalChannel() === "voice" ? "Champions are released only after the approver says yes to the ElevenLabs release agent, confirmed with ElevenLabs." : "Champions are released only after a human approves in the dashboard. Set ELEVENLABS_API_KEY and ELEVENLABS_AGENT_ID to approve by voice." },
      { name: "Blue and Red agents", ok: agentsReady(), detail: config.AGENT_PROVIDER === "codex-cli" ? "Separate, bounded Codex model jobs write RTL and adversarial stimuli. The controller verifies every result." : "Separate Anthropic model calls write RTL and adversarial stimuli. Explicit models and an API key are required." },
    ],
  }));
  app.get("/api/runs", (c) => c.json(store.list()));
  app.get("/api/demo", async (c) => c.json(await engine.demo()));
  app.post("/api/runs", async (c) => {
    const parsed = createSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "Invalid run request.", issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })) }, 400);
    if (!config.DAYTONA_API_KEY) return c.json({ error: "Set DAYTONA_API_KEY to execute model-generated RTL in Daytona." }, 503);
    if (!agentsReady()) return c.json({ error: "The live agent runtime is unavailable. Sign in with Codex CLI, or configure AGENT_PROVIDER=anthropic with explicit Blue/Red models and ANTHROPIC_API_KEY." }, 503);
    await requireHardwareSnapshot();
    return c.json({ id: await engine.start(parsed.data) }, 201);
  });
  app.get("/api/memory/status", async (c) => {
    if (!engine.memory) return c.json({ configured: false, connected: false });
    try { await engine.memory.backend.check(); return c.json({ configured: true, connected: true }); }
    catch { return c.json({ configured: true, connected: false, error: "Surreal graph connection check failed." }); }
  });
  app.get("/api/runs/:id/memory", async (c) => {
    const run = store.get(c.req.param("id"));
    if (!run) return c.json({ error: "Run not found." }, 404);
    if (!engine.memory) return c.json({ configured: false, nodes: [], edges: [] });
    return c.json({ configured: true, ...await engine.memory.snapshot(run) });
  });
  app.get("/api/runs/:id", (c) => {
    const run = store.get(c.req.param("id"));
    return run ? c.json(run) : c.json({ error: "Run not found." }, 404);
  });
  app.get("/api/runs/:id/export", (c) => {
    const run = store.get(c.req.param("id"));
    if (!run) return c.json({ error: "Run not found." }, 404);
    c.header("content-disposition", `attachment; filename="antibody-${run.id}.json"`);
    return c.json(run);
  });
  app.post("/api/runs/:id/stop", async (c) => {
    const id = c.req.param("id");
    if (!store.get(id)) return c.json({ error: "Run not found." }, 404);
    await engine.stop(id);
    return c.json(store.get(id));
  });
  app.post("/api/runs/:id/browser-audit", async (c) => {
    const id = c.req.param("id");
    if (!store.get(id)) return c.json({ error: "Run not found." }, 404);
    if (!config.ANCHOR_API_KEY || !config.PUBLIC_DASHBOARD_URL) return c.json({ error: "Configure ANCHOR_API_KEY and publicly reachable PUBLIC_DASHBOARD_URL to run a cloud browser audit." }, 503);
    if (audits.has(id)) return c.json({ error: "An audit is already running for this run." }, 409);
    audits.add(id);
    try {
      // The server controls the target; a request body cannot direct the cloud browser elsewhere.
      const target = new URL(config.PUBLIC_DASHBOARD_URL);
      target.searchParams.set("run", id);
      const audit = await runAnchorAudit(target.toString());
      await store.emit(id, { type: "browser.audited", message: audit.summary, payload: audit });
      return c.json(audit);
    } finally { audits.delete(id); }
  });
  // Release gate: a verified champion is released only after a human approves it.
  const decisionSchema = z.object({ decision: z.enum(["approve", "decline"]), run_id: z.string().optional(), conversation_id: z.string().max(200).optional() });
  const requestSchema = z.object({ channel: z.enum(["voice", "phone", "dashboard"]).optional() });
  app.post("/api/runs/:id/approval/request", async (c) => {
    const parsed = requestSchema.safeParse(await c.req.json().catch(() => ({})));
    return c.json(await requestApproval(store, c.req.param("id"), (parsed.success && parsed.data.channel) || approvalChannel()));
  });
  app.get("/api/runs/:id/voice-session", async (c) => c.json(await voiceSession(store, c.req.param("id"))));
  app.post("/api/runs/:id/approval", async (c) => {
    const parsed = decisionSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "Send {\"decision\": \"approve\" | \"decline\"}." }, 400);
    const via = webhookAuthorized(c.req.header("x-approve-secret")) ? "phone" : parsed.data.conversation_id ? "voice" : "dashboard";
    return c.json(await decide(store, c.req.param("id"), parsed.data.decision, via, undefined, { conversationId: parsed.data.conversation_id }));
  });
  // The ElevenLabs voice agent's webhook tool: shared secret required, applies to the run awaiting a phone decision.
  app.post("/api/approval", async (c) => {
    if (!webhookAuthorized(c.req.header("x-approve-secret"))) return c.json({ error: "Invalid approval secret." }, 403);
    const parsed = decisionSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "Send {\"decision\": \"approve\" | \"decline\"}." }, 400);
    const id = parsed.data.run_id ?? pendingPhoneRun(store);
    if (!id) return c.json({ error: "No run is waiting for a phone approval." }, 409);
    const run = await decide(store, id, parsed.data.decision, "phone");
    return c.json({ ok: true, status: run.approval?.status, released: Boolean(run.release) });
  });
  app.get("/api/runs/:id/events", (c) => {
    const id = c.req.param("id");
    if (!store.get(id)) return c.json({ error: "Run not found." }, 404);
    const rawAfter = c.req.query("after") ?? c.req.header("last-event-id") ?? "0";
    const after = Number(rawAfter);
    if (!Number.isSafeInteger(after) || after < 0) return c.json({ error: "after must be a non-negative event sequence." }, 400);
    return streamSSE(c, async (stream) => {
      let ended = false;
      let last = after;
      let wake: (() => void) | undefined;
      const pending: EvolutionEvent[] = [];
      const unsubscribe = store.subscribe(id, (event) => { pending.push(event); wake?.(); });
      stream.onAbort(() => { ended = true; unsubscribe(); wake?.(); });
      try {
        // Subscribe before replay, then suppress duplicate sequences to close the replay/live race.
        pending.unshift(...store.events(id, after));
        while (!ended) {
          while (pending.length && !ended) {
            const event = pending.shift()!;
            if (event.seq <= last) continue;
            await stream.writeSSE({ data: JSON.stringify(event), event: "message", id: String(event.seq) });
            last = event.seq;
          }
          if (ended) break;
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 15_000);
            wake = () => { clearTimeout(timer); resolve(); };
            if (pending.length || ended) wake();
          });
          wake = undefined;
          if (!pending.length && !ended) await stream.write(": keep-alive\n\n");
        }
      } finally { unsubscribe(); }
    });
  });
  app.notFound((c) => c.json({ error: "Route not found." }, 404));
  return app;
}

export async function startServer(): Promise<void> {
  await defaultStore.load();
  const telemetry = startArizeTracing(defaultStore);
  if (telemetry) console.log("Arize tracing enabled.");
  const engine = new EvolutionEngine(defaultStore, undefined, undefined, configuredMemory());
  defaultStore.observe(event=>{
    if(["candidate.updated","run.completed","run.failed","run.stopped"].includes(event.type)){
      const run=defaultStore.get(event.runId);if(run)void writeTimeseries(run.id,rowsFromHardwareRun(run)).catch(()=>{});
    }
  });
  const software = new SoftwareService();
  const agentLab = new AgentLabService();
  const viewer = new NativeViewerProxy({ allowedOrigins: [...new Set(["http://127.0.0.1:5173", "http://localhost:5173", `http://127.0.0.1:${config.PORT}`, `http://localhost:${config.PORT}`, ...(config.PUBLIC_DASHBOARD_URL ? [new URL(config.PUBLIC_DASHBOARD_URL).origin] : [])])] });
  const server = serve({ fetch: createApp(defaultStore, engine, software, agentLab, viewer).fetch, port: config.PORT, hostname: "0.0.0.0" });
  viewer.attach(server as Server);
  console.log(`Antibody controller listening on http://localhost:${config.PORT}`);
  let closing = false;
  const shutdown = async () => {
    if (closing) return; closing = true;
    await engine.stopAll();
    await software.stopAll();
    await agentLab.stopAll();
    await defaultStore.flush();
    await flushTelemetry();
    await telemetry?.shutdown();
    viewer.close(); server.close();
  };
  process.once("SIGINT", () => { void shutdown(); });
  process.once("SIGTERM", () => { void shutdown(); });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer().catch((error: unknown) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
}
