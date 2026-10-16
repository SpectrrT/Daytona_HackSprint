import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../index.js";
import { AgentLabService } from "./service.js";

class OfflineLab extends AgentLabService {
  starts = 0;
  stopped: string[] = [];
  override start() { this.starts++; return "offline-agent-run"; }
  override async list() { return []; }
  override async get(id: string) { return id === "offline-agent-run" ? { id, status: "queued" as const } : undefined; }
  override async stop(id: string) { this.stopped.push(id); }
}

test("agent-lab start rejects arbitrary targets, source and unsupported suites before any model or sandbox work", async () => {
  const lab = new OfflineLab(), app = createApp(undefined, undefined, undefined, lab);
  for (const body of [{}, { suite: "support" }, { suite: "cross-domain", url: "https://elsewhere.example" }, { suite: "cross-domain", source: "custom source" }]) {
    const response = await app.request("/api/agent-lab/runs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    assert.equal(response.status, 400);
  }
  const oversized = await app.request("/api/agent-lab/runs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ suite: "cross-domain", input: "x".repeat(17000) }) });
  assert.equal(oversized.status, 413);
  assert.equal(lab.starts, 0);
});

test("agent-lab evidence routes bound IDs and require an actual completed recording", async () => {
  const lab = new OfflineLab(), app = createApp(undefined, undefined, undefined, lab);
  for (const suffix of ["", "/export", "/video", "/stop", "/sandboxes"]) {
    const response = await app.request(`/api/agent-lab/runs/not.valid${suffix}`, suffix === "/stop" ? { method: "POST" } : undefined);
    assert.equal(response.status, 400);
  }
  assert.equal((await app.request("/api/agent-lab/runs/missing/export")).status, 404);
  assert.equal((await app.request("/api/agent-lab/runs/offline-agent-run/video")).status, 404);
  const exported = await app.request("/api/agent-lab/runs/offline-agent-run/export");
  assert.equal(exported.status, 200);
  assert.deepEqual(await exported.json(), { id: "offline-agent-run", status: "queued" });
  assert.match(exported.headers.get("content-disposition") ?? "", /agent-lab-offline-agent-run\.json/);
  assert.equal((await app.request("/api/agent-lab/runs/missing/stop", { method: "POST" })).status, 404);
  assert.equal((await app.request("/api/agent-lab/runs/offline-agent-run/stop", { method: "POST" })).status, 200);
  assert.deepEqual(lab.stopped, ["offline-agent-run"]);
});

test("sandbox routes reject caller-chosen ports, URLs, invalid keys and missing runs", async () => {
  const app = createApp(undefined, undefined, undefined, new OfflineLab());
  assert.equal((await app.request('/api/agent-lab/runs/offline-agent-run/sandboxes')).status, 404);
  for (const body of [{ resume: true, port: 22 }, { url: 'https://elsewhere.example' }, { sandboxId: 'arbitrary' }]) {
    assert.equal((await app.request('/api/agent-lab/runs/offline-agent-run/sandboxes/desktop/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).status, 400);
  }
  assert.equal((await app.request('/api/agent-lab/runs/missing/sandboxes/desktop/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 404);
  assert.equal((await app.request('/api/agent-lab/runs/offline-agent-run/sandboxes/invalid.key/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 400);
});
