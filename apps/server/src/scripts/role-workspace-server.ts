import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { AgentLabService } from "../agent-lab/service.js";
import { roleWorkspaceService } from "../agent-lab/role-workspace-service.js";
import { SandboxAccessError } from "../agent-lab/sandboxes.js";
import { NativeViewerProxy } from "../agent-lab/native-viewer-proxy.js";
import { config } from "../config.js";
import type { Server } from "node:http";

/** A companion for attaching role workers without restarting an in-progress model run. */
const lab = new AgentLabService(), app = new Hono();
const viewer = new NativeViewerProxy({ allowedOrigins: [...new Set(["http://127.0.0.1:5173", "http://localhost:5173", "http://127.0.0.1:8788", "http://localhost:8788", `http://127.0.0.1:${config.PORT}`, `http://localhost:${config.PORT}`, ...(config.PUBLIC_DASHBOARD_URL ? [new URL(config.PUBLIC_DASHBOARD_URL).origin] : [])])] });
app.use("*", bodyLimit({ maxSize: 1024, onError: c => c.json({ error: "Request too large." }, 413) }));
app.onError((error, c) => c.json({ error: error instanceof SandboxAccessError ? error.message : "Role workspace service could not complete the request." }, error instanceof SandboxAccessError ? error.status : 503));
app.get("/api/agent-lab/runs/:id/sandboxes", async c => {
  const id = c.req.param("id"); if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) return c.json({ error: "Invalid run ID." }, 400);
  const run = await lab.get(id); if (!run || run.status === "queued") return c.json({ error: "Run not found." }, 404);
  roleWorkspaceService.observe(run);
  c.header("Cache-Control", "no-store");
  return c.json({ ...await lab.sandboxAccess.list(run), ...(run.roleWorkspaceError ? { error: run.roleWorkspaceError } : {}) });
});
app.post("/api/agent-lab/runs/:id/sandboxes/:key/preview", async c => {
  const id = c.req.param("id"), key = c.req.param("key");
  if (![id, key].every(value => /^[a-zA-Z0-9_-]{1,100}$/.test(value))) return c.json({ error: "Invalid run or sandbox key." }, 400);
  const body = z.object({ resume: z.boolean().default(false) }).strict().safeParse(await c.req.json().catch(() => undefined));
  if (!body.success) return c.json({ error: "Use {resume:true} to resume a sandbox." }, 400);
  const run = await lab.get(id); if (!run || run.status === "queued") return c.json({ error: "Run not found." }, 404);
  c.header("Cache-Control", "no-store");
  const preview = await lab.sandboxAccess.preview(run, key, body.data.resume);
  return c.json(preview.kind === "desktop" ? viewer.issue(run, key, preview, c.req.header("Origin") ?? new URL(c.req.url).origin) : preview);
});
let checking = false;
const observe = async () => {
  if (checking) return; checking = true;
  try { for (const row of await lab.list()) { const run = await lab.get(row.id); if (run && run.status !== "queued") roleWorkspaceService.observe(run); } }
  catch { console.error("Role workspace discovery unavailable; retained app runs were not changed."); }
  finally { checking = false; }
};
const server = serve({ fetch: app.fetch, port: 8788, hostname: "127.0.0.1" });
viewer.attach(server as Server);
const timer = setInterval(() => void observe(), 5000); void observe();
console.log("Blue/Red workspace controller listening on http://127.0.0.1:8788");
process.once("SIGTERM", () => { clearInterval(timer); viewer.close(); server.close(); });
process.once("SIGINT", () => { clearInterval(timer); viewer.close(); server.close(); });
