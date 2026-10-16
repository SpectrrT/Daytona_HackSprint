import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { LabRun, LabRunSummary } from "@antibody/shared/agent-lab";
import { config } from "../config.js";
import { labDirectory, runAgentLab } from "./engine.js";
import { LabSandboxAccess } from "./sandboxes.js";
import { readRoleWorkspaceState } from "./role-workspace-service.js";
export class AgentLabService {
  readonly sandboxAccess = new LabSandboxAccess();
  private readonly active = new Map<string, { controller: AbortController; task: Promise<LabRun> }>();
  start(options: { prompt?: string } = {}): string {
    if (this.active.size) throw new Error("An agent experiment is already running.");
    if (!config.DAYTONA_API_KEY || !config.ANCHOR_API_KEY) throw new Error("Configure Daytona and Anchor to run the agent lab.");
    const id = randomUUID(), controller = new AbortController(), task = runAgentLab({ id, signal: controller.signal, prompt: options.prompt });
    this.active.set(id, { controller, task }); void task.catch(() => {}).finally(() => this.active.delete(id)); return id;
  }
  async get(id: string): Promise<LabRun | { id: string; status: "queued" } | undefined> {
    try {
      const run = JSON.parse(await readFile(join(labDirectory(id), "run.json"), "utf8")) as LabRun;
      const roles = await readRoleWorkspaceState(id);
      return { ...run, ...(roles ? { roleWorkspaces: roles.workspaces, roleWorkspaceError: roles.error } : {}), controllable: this.active.has(id) };
    }
    catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return this.active.has(id) ? { id, status: "queued" } : undefined; throw error; }
  }
  async list(): Promise<LabRunSummary[]> {
    const entries = await readdir(join(config.DATA_DIR, "agent-runs"), { withFileTypes: true }).catch(() => []);
    const runs = await Promise.all(entries.filter(entry => entry.isDirectory() && /^[a-zA-Z0-9_-]{1,100}$/.test(entry.name)).map(entry => this.get(entry.name)));
    return runs.filter((run): run is LabRun => !!run && run.status !== "queued").map(({ id, status, createdAt, championId }) => ({ id, status, createdAt, championId })).toSorted((a, b) => b.createdAt - a.createdAt);
  }
  async stop(id: string) { const active = this.active.get(id); if (!active && (await this.get(id))?.status === "running") throw new Error("This experiment was started from the CLI; stop it from its terminal."); active?.controller.abort(); await active?.task; }
  async stopAll() { await Promise.all([...this.active.keys()].map(id => this.stop(id))); }
}
