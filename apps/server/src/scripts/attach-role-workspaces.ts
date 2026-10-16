import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { LabRoleWorkspace, LabRun } from "@antibody/shared/agent-lab";
import { config } from "../config.js";
import { daytona } from "../daytona/client.js";
import { claimRoleWorkspaceLease, readRoleWorkspaceState } from "../agent-lab/role-workspace-service.js";
import { RoleWorkspaces } from "../agent-lab/role-workspaces.js";

// Explicitly attach separate role desktops to a retained run without restarting it.
const id = process.argv[2];
assert.ok(id && /^[a-zA-Z0-9_-]{1,100}$/.test(id), "Pass the retained run ID.");
const directory = join(config.DATA_DIR, "agent-runs", id);
const run = JSON.parse(await readFile(join(directory, "run.json"), "utf8")) as LabRun;
assert.equal(run.id, id);
assert.ok(await claimRoleWorkspaceLease(id), "Another controller owns these workspaces.");
let saved = await readRoleWorkspaceState(id);
if (saved?.error || saved?.workspaces.some(row => row.error)) {
  // Preserve failed setup evidence, and never allocate replacements for a retained VM.
  for (const row of saved.workspaces) {
    let missing = false;
    try { await daytona().get(row.sandboxId); }
    catch (error) {
      const status = error && typeof error === "object" ? Number((error as { statusCode?: number; status?: number }).statusCode ?? (error as { status?: number }).status) : undefined;
      if (status === 404) missing = true; else throw error;
    }
    assert.ok(missing, "A failed workspace still exists; inspect it before allocating a replacement.");
  }
  await rename(join(directory, "role-workspaces.json"), join(directory, `role-workspaces.failed-${Date.now()}.json`));
  saved = undefined;
}
let workspaces: LabRoleWorkspace[] = saved?.workspaces ?? [];
const persist = async () => {
  const temporary = join(directory, `role-workspaces.${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify({ workspaces, updatedAt: Date.now() }, null, 2), { mode: 0o600 });
  await rename(temporary, join(directory, "role-workspaces.json"));
};
const options = { onProvisioned: async (row: LabRoleWorkspace) => {
  workspaces = [...workspaces.filter(item => item.role !== row.role), row];
  await persist(); console.log(`${row.role}: ${row.sandboxId} ${row.ready ? "ready" : row.error ?? "starting"}`);
} };
try {
  const roles = saved?.workspaces.length ? await RoleWorkspaces.attach(id, saved.workspaces, options) : await RoleWorkspaces.create(id, options);
  await roles.sync(run);
  workspaces = roles.metadata; await persist();
  console.log("Separate Blue and Red workspaces contain the retained run’s actual model outputs and validation receipts.");
} catch (error) {
  await writeFile(join(directory, "role-workspaces.json"), JSON.stringify({ workspaces, updatedAt: Date.now(), error: "Separate role workspace setup failed. Inspect the saved role setup diagnostics before retrying." }, null, 2), { mode: 0o600 });
  throw error;
}
