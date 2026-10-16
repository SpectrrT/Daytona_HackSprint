import { randomUUID } from "node:crypto";
import { open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { LabRoleWorkspace, LabRun } from "@antibody/shared/agent-lab";
import { config } from "../config.js";
import { RoleWorkspaces, workspacePublicState } from "./role-workspaces.js";
import { hash } from "./contract.js";

const metadataSchema = z.object({
  workspaces: z.array(z.object({ role: z.enum(["blue", "red"]), sandboxId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/), ready: z.boolean(), error: z.string().max(1000).optional() }).strict()).max(2),
  error: z.string().optional(), updatedAt: z.number(),
}).strict().refine(value => new Set(value.workspaces.map(row => row.role)).size === value.workspaces.length && new Set(value.workspaces.map(row => row.sandboxId)).size === value.workspaces.length);
export type RoleWorkspaceState = z.infer<typeof metadataSchema>;
const file = (id: string) => {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error("Invalid run ID.");
  return join(config.DATA_DIR, "agent-runs", id, "role-workspaces.json");
};
export async function readRoleWorkspaceState(id: string): Promise<RoleWorkspaceState | undefined> {
  try { return metadataSchema.parse(JSON.parse(await readFile(file(id), "utf8"))); }
  catch (error) { if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined; throw new Error("The saved role workspace metadata is invalid."); }
}

interface Entry { latest: LabRun; state: RoleWorkspaceState; instance?: RoleWorkspaces; draining: boolean; failed: boolean; revision: number; published: number; persist: Promise<void>; signature: string; ownsLease: boolean }
/** One controller process owns a run's role workers; a stale PID can be reclaimed after restart. */
export async function claimRoleWorkspaceLease(id: string): Promise<boolean> {
  const path = `${file(id)}.lock`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(path, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() })); }
      finally { await handle.close(); }
      return true;
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error;
      let previous: { pid: number };
      try { previous = JSON.parse(await readFile(path, "utf8")); }
      catch { return false; }
      if (!Number.isSafeInteger(previous.pid) || previous.pid <= 0) return false;
      try { process.kill(previous.pid, 0); return false; }
      catch (check) {
        if (!check || typeof check !== "object" || !("code" in check) || check.code !== "ESRCH") return false;
      }
      await unlink(path).catch(() => {});
    }
  }
  return false;
}
/** Keeps role VMs separate from the app runner and never edits its evidence journal. */
export class RoleWorkspaceService {
  private readonly entries = new Map<string, Entry>();
  observe(run: LabRun): void {
    if (!this.entries.has(run.id) && run.status !== "running") return;
    const signature = hash(JSON.stringify([workspacePublicState(run, "blue"), workspacePublicState(run, "red")]));
    let entry = this.entries.get(run.id);
    if (!entry) {
      entry = { latest: structuredClone(run), state: { workspaces: [], updatedAt: Date.now() }, draining: false, failed: false, revision: 0, published: -1, persist: Promise.resolve(), signature: "", ownsLease: false };
      this.entries.set(run.id, entry);
    }
    if (entry.signature === signature && entry.published === entry.revision) return;
    entry.signature = signature;
    entry.latest = structuredClone(run); entry.revision++;
    if (!entry.draining && !entry.failed) void this.drain(run.id, entry);
  }
  private persist(id: string, entry: Entry): Promise<void> {
    const snapshot = structuredClone(entry.state);
    entry.persist = entry.persist.catch(() => {}).then(async () => {
      const path = file(id), temporary = `${path}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(snapshot, null, 2), { mode: 0o600 });
      await rename(temporary, path);
    });
    return entry.persist;
  }
  private async drain(id: string, entry: Entry): Promise<void> {
    entry.draining = true;
    try {
      if (!entry.ownsLease) {
        entry.ownsLease = await claimRoleWorkspaceLease(id);
        if (!entry.ownsLease) return;
      }
      if (!entry.instance) {
        const saved = await readRoleWorkspaceState(id);
        if (saved) entry.state = saved;
        const options = { onProvisioned: async (row: LabRoleWorkspace) => {
          entry.state.workspaces = [...entry.state.workspaces.filter(item => item.role !== row.role), row];
          entry.state.updatedAt = Date.now(); await this.persist(id, entry);
        } };
        entry.instance = saved?.workspaces.length ? await RoleWorkspaces.attach(id, saved.workspaces, options) : await RoleWorkspaces.create(id, options);
        entry.state.workspaces = entry.instance.metadata; entry.state.error = undefined;
        entry.state.updatedAt = Date.now(); await this.persist(id, entry);
      }
      while (entry.published !== entry.revision) {
        const revision = entry.revision;
        await entry.instance.sync(entry.latest);
        entry.published = revision;
      }
    } catch {
      entry.failed = true;
      entry.state.error = "Blue/Red workspaces could not be updated. Check Daytona capacity and the role workspace logs. The application run and its verifier continue separately.";
      entry.state.updatedAt = Date.now();
      await this.persist(id, entry).catch(() => {});
    } finally { entry.draining = false; }
  }
}
export const roleWorkspaceService = new RoleWorkspaceService();
