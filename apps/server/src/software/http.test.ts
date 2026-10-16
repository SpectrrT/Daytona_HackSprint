import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../index.js";
import { SoftwareService } from "./service.js";

class OfflineService extends SoftwareService {
  starts = 0;
  stopped: string[] = [];
  override start() { this.starts++; return "offline-run"; }
  override async get(id: string) { return id === "offline-run" ? { id, status: "queued" as const } : undefined; }
  override async stop(id: string) { this.stopped.push(id); }
}

test("software start refuses arbitrary code, targets, and unsupported examples before provisioning", async () => {
  const software = new OfflineService();
  const app = createApp(undefined, undefined, software);
  for (const body of [{ example: "other" }, { example: "checkout", source: "injected" }, { example: "checkout", url: "https://elsewhere.example" }]) {
    const response = await app.request("/api/software/runs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    assert.equal(response.status, 400);
  }
  assert.equal(software.starts, 0);
  const valid = await app.request("/api/software/runs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ example: "checkout" }) });
  assert.equal(valid.status, 202); assert.equal(software.starts, 1);
});
test("software evidence paths and stop requests cannot address arbitrary filesystem names", async () => {
  const software = new OfflineService();
  const app = createApp(undefined, undefined, software);
  assert.equal((await app.request("/api/software/runs/not.valid/export")).status, 400);
  assert.equal((await app.request("/api/software/runs/missing/stop", { method: "POST" })).status, 404);
  assert.equal((await app.request("/api/software/runs/offline-run/export")).status, 200);
  assert.equal((await app.request("/api/software/runs/offline-run/stop", { method: "POST" })).status, 200);
  assert.deepEqual(software.stopped, ["offline-run"]);
});
