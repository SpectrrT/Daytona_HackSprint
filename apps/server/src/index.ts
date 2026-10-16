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
import { runAnchorAudit } from "./browser/session.js";
import { store as defaultStore, type RunStore } from "./store.js";
import type { EvolutionEvent } from "@hollow-purple/shared/evolution";

const createSchema = z.object({
  prompt: z.string().trim().min(10).max(2000).refine(supportsPrompt, "This scaffold supports a 32-entry, 16-bit synchronous FIFO. Use the provided buffer prompt; other tasks need a dedicated contract and verifier."),
  provider: z.literal("daytona").default("daytona"),
  maxCandidates: z.number().int().min(3).max(12).optional(),
  seed: z.number().int().min(0).max(0xffff_ffff).optional(),
}).strict();

let agentCheck: { ts: number; ready: boolean } | undefined;
function agentsReady(): boolean {
  if (config.AGENT_PROVIDER === "anthropic") return Boolean(config.ANTHROPIC_API_KEY && config.BLUE_MODEL && config.RED_MODEL);
  if (agentCheck && Date.now() - agentCheck.ts < 30_000) return agentCheck.ready;
  const check = spawnSync(config.CODEX_BIN, ["login", "status"], {
    encoding: "utf8", timeout: 5000,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, ...(process.env.CODEX_HOME ? { CODEX_HOME: process.env.CODEX_HOME } : {}) },
  });
  agentCheck = { ts: Date.now(), ready: check.status === 0 };
  return agentCheck.ready;
}

export function createApp(store: RunStore = defaultStore, engine = new EvolutionEngine(store)): Hono {
  const app = new Hono();
  const audits = new Set<string>();
  app.use("/api/*", bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json({ error: "Request body exceeds 16 KiB." }, 413) }));
  app.onError((error, c) => {
    if (error instanceof ConfigError) return c.json({ error: error.message }, 503);
    if (error instanceof CapacityError) return c.json({ error: error.message }, 429);
    console.error("[api]", error.message);
    return c.json({ error: "The request failed. Check the server log and retained run evidence." }, 500);
  });
  app.get("/api/health", (c) => c.json({ status: "ok" }));
  app.get("/api/system", (c) => c.json({
    providers: { daytona: Boolean(config.DAYTONA_API_KEY), anchor: Boolean(config.ANCHOR_API_KEY && config.PUBLIC_DASHBOARD_URL), model: agentsReady() },
    agentsReady: agentsReady(), agentProvider: config.AGENT_PROVIDER,
    agentModel: config.BLUE_MODEL ?? "Codex default", defaultProvider: "daytona",
    publicDashboardUrl: config.PUBLIC_DASHBOARD_URL,
    checks: [
      { name: "Local simulation", ok: true, detail: "Deterministic candidate models checked by an independent queue oracle; no cloud credentials required." },
      { name: "Daytona HDL simulation", ok: Boolean(config.DAYTONA_API_KEY), detail: config.DAYTONA_API_KEY ? "Configured. Candidates run Verilator inside separate Daytona sandboxes." : "Set DAYTONA_API_KEY to enable isolated Verilator runs." },
      { name: "Anchor Browser", ok: Boolean(config.ANCHOR_API_KEY && config.PUBLIC_DASHBOARD_URL), detail: "Cloud browser audits require ANCHOR_API_KEY and a publicly reachable PUBLIC_DASHBOARD_URL." },
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
    return c.json({ id: await engine.start(parsed.data) }, 201);
  });
  app.get("/api/runs/:id", (c) => {
    const run = store.get(c.req.param("id"));
    return run ? c.json(run) : c.json({ error: "Run not found." }, 404);
  });
  app.get("/api/runs/:id/export", (c) => {
    const run = store.get(c.req.param("id"));
    if (!run) return c.json({ error: "Run not found." }, 404);
    c.header("content-disposition", `attachment; filename="hollow-purple-${run.id}.json"`);
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
  const engine = new EvolutionEngine(defaultStore);
  const server = serve({ fetch: createApp(defaultStore, engine).fetch, port: config.PORT, hostname: "0.0.0.0" });
  console.log(`Hollow Purple controller listening on http://localhost:${config.PORT}`);
  let closing = false;
  const shutdown = async () => {
    if (closing) return; closing = true;
    await engine.stopAll();
    await defaultStore.flush();
    server.close();
  };
  process.once("SIGINT", () => { void shutdown(); });
  process.once("SIGTERM", () => { void shutdown(); });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer().catch((error: unknown) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
}
