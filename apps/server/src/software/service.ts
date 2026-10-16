import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { SoftwareRun } from "@hollow-purple/shared/software";
import { config } from "../config.js";
import { runSoftwareExperiment, softwareDirectory } from "./engine.js";

export class SoftwareService {
  private readonly active = new Map<string, { controller: AbortController; task: Promise<SoftwareRun> }>();
  start(): string {
    if (this.active.size) throw new Error("A software experiment is already running.");
    if (!config.DAYTONA_API_KEY || !config.ANCHOR_API_KEY) throw new Error("Configure Daytona and Anchor before starting software execution.");
    const id = randomUUID(), controller = new AbortController();
    const task = runSoftwareExperiment({ id, signal: controller.signal });
    this.active.set(id, { controller, task });
    void task.catch(() => {}).finally(() => this.active.delete(id));
    return id;
  }
  async get(id: string): Promise<SoftwareRun | { id: string; status: "queued" } | undefined> {
    try { return JSON.parse(await readFile(join(softwareDirectory(id), "run.json"), "utf8")) as SoftwareRun; }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return this.active.has(id) ? { id, status: "queued" } : undefined;
      throw error;
    }
  }
  async list() {
    const root = join(config.DATA_DIR, "software-runs");
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    const runs = await Promise.all(entries.filter(entry => entry.isDirectory() && /^[a-zA-Z0-9_-]{1,100}$/.test(entry.name)).map(entry => this.get(entry.name)));
    return runs.filter((run): run is SoftwareRun => !!run && run.status !== "queued").map(run => ({ id: run.id, status: run.status, createdAt: run.createdAt, championId: run.championId, candidates: run.candidates.length }));
  }
  async stop(id: string): Promise<void> {
    const active = this.active.get(id);
    active?.controller.abort(); await active?.task;
  }
  async stopAll(): Promise<void> { await Promise.all([...this.active.keys()].map(id => this.stop(id))); }
}
