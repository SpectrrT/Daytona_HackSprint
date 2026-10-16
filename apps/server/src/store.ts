import { mkdirSync } from "node:fs";
import { appendFile, readFile, readdir, truncate } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserAudit, Candidate, EvolutionEvent, EvolutionRun, FailureEvidence, RunSummary } from "@hollow-purple/shared/evolution";
import { config } from "./config.js";
import { assertFrozenContract } from "./engine/contract.js";

export type EventBody = Omit<EvolutionEvent, "seq" | "ts" | "runId">;
export type InitialRun = Omit<EvolutionRun, "events">;
type Listener = (event: EvolutionEvent) => void;
interface RunRecord { run: EvolutionRun; listeners: Set<Listener>; writes: Promise<void> }
const terminal = new Set(["completed", "failed", "stopped"]);
export class TerminalRunError extends Error {
  constructor() { super("Run has already reached a terminal state."); this.name = "TerminalRunError"; }
}
const allowedAfterTerminal = new Set(["browser.audited", "log"]);
const validId = /^[a-zA-Z0-9_-]{1,100}$/;
const eventTypes = new Set(["run.created", "contract.frozen", "run.started", "candidate.created", "candidate.updated", "failure.reproduced", "regression.added", "lesson.learned", "champion.selected", "run.completed", "run.stopped", "run.failed", "browser.audited", "log"]);

/** Pure fold of the append-only log. Only a verified acceptance event selects a champion. */
export function applyEvolutionEvent(run: EvolutionRun, event: EvolutionEvent): EvolutionRun {
  if (terminal.has(run.status) && event.type !== "run.created" && !allowedAfterTerminal.has(event.type)) throw new TerminalRunError();
  let next = { ...run, events: [...run.events, event] };
  switch (event.type) {
    case "run.created": return { ...(event.payload as InitialRun), events: [event] };
    case "contract.frozen": break; // creation already stores the frozen contract; no event may replace it.
    case "run.started": next.status = "running"; break;
    case "candidate.created": {
      const candidate = event.payload as Candidate;
      next.candidates = [...run.candidates, candidate];
      next.budget = { ...run.budget, usedCandidates: next.candidates.length };
      break;
    }
    case "candidate.updated": {
      const candidate = event.payload as Candidate;
      next.candidates = run.candidates.map((item) => item.id === candidate.id ? candidate : item);
      next.budget = { ...run.budget, usedCycles: next.candidates.reduce((sum, item) => sum + item.cycles, 0) };
      break;
    }
    case "regression.added": {
      const failure = event.payload as FailureEvidence;
      if (!run.regressions.some((item) => item.id === failure.id)) next.regressions = [...run.regressions, failure];
      break;
    }
    case "champion.selected": next.championId = event.candidateId; break;
    case "run.completed": next.status = "completed"; next.finishedAt = event.ts; next.summary = event.message; break;
    case "run.stopped": next.championId = undefined; next.status = "stopped"; next.finishedAt = event.ts; next.summary = event.message; break;
    case "run.failed": next.championId = undefined; next.status = "failed"; next.finishedAt = event.ts; next.error = event.message; break;
    case "browser.audited": next.browserAudit = event.payload as BrowserAudit; break;
    default: break;
  }
  return next;
}

/** Every event is durably appended before it changes state or reaches SSE subscribers. */
export class RunStore {
  private readonly records = new Map<string, RunRecord>();
  private readonly dir: string;
  constructor(dataDir: string) {
    this.dir = join(dataDir, "runs");
    mkdirSync(this.dir, { recursive: true });
  }
  async load(): Promise<void> {
    for (const file of (await readdir(this.dir)).filter((name) => name.endsWith(".jsonl"))) {
      const id = file.slice(0, -6);
      if (!validId.test(id)) continue;
      const filePath = join(this.dir, file);
      const contents = await readFile(filePath, "utf8");
      const lines = contents.split("\n");
      let run: EvolutionRun | undefined;
      let bytes = 0;
      let tailDiscarded = false;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (!line) { bytes += 1; continue; }
        let event: EvolutionEvent;
        try { event = JSON.parse(line) as EvolutionEvent; }
        catch {
          // A crash may tear the final append. Remove only that incomplete suffix.
          if (i === lines.length - 1 && !contents.endsWith("\n")) { await truncate(filePath, bytes); tailDiscarded = true; break; }
          throw new Error(`Corrupt event log ${id} at line ${i + 1}.`);
        }
        if (event.runId !== id || event.seq !== (run?.events.length ?? 0) + 1 || !eventTypes.has(event.type)) {
          throw new Error(`Invalid event sequence in ${id} at line ${i + 1}.`);
        }
        if (!run) {
          if (event.type !== "run.created") throw new Error(`Missing creation event in ${id}.`);
          run = { ...(event.payload as InitialRun), events: [] };
        }
        run = applyEvolutionEvent(run, event);
        bytes += Buffer.byteLength(line + "\n");
      }
      if (!run) continue;
      if (!contents.endsWith("\n") && !tailDiscarded) await appendFile(filePath, "\n");
      assertFrozenContract(run.contract);
      this.records.set(id, { run, listeners: new Set(), writes: Promise.resolve() });
      if (!terminal.has(run.status)) await this.emit(id, { type: "run.stopped", message: "Server restarted during execution; retained all durable evidence. Start a new run to continue." });
    }
  }
  async create(initial: InitialRun): Promise<EvolutionRun> {
    if (!validId.test(initial.id) || this.records.has(initial.id)) throw new Error("Invalid or duplicate run id.");
    assertFrozenContract(initial.contract);
    this.records.set(initial.id, { run: { ...structuredClone(initial), events: [] }, listeners: new Set(), writes: Promise.resolve() });
    try {
      await this.emit(initial.id, { type: "run.created", message: "Run created with a fixed candidate and simulation budget.", payload: structuredClone(initial) });
    } catch (error) { this.records.delete(initial.id); throw error; }
    return this.get(initial.id)!;
  }
  async emit(id: string, body: EventBody): Promise<EvolutionEvent> {
    const record = this.require(id);
    let emitted: EvolutionEvent | undefined;
    const operation = record.writes.then(async () => {
      // Check inside the serialized queue: a stop queued during an awaited write must win over later work.
      if (terminal.has(record.run.status) && !allowedAfterTerminal.has(body.type)) throw new TerminalRunError();
      if (body.type === "run.created" && record.run.events.length > 0) throw new Error("A run can only be created once.");
      const event: EvolutionEvent = { ...structuredClone(body), seq: record.run.events.length + 1, ts: Date.now(), runId: id };
      await appendFile(join(this.dir, `${id}.jsonl`), `${JSON.stringify(event)}\n`);
      record.run = applyEvolutionEvent(record.run, event);
      emitted = event;
      for (const listener of record.listeners) { try { listener(structuredClone(event)); } catch { /* Disconnected clients cannot interrupt persistence. */ } }
    });
    // Keep the queue usable after an error, while returning this failure to its caller.
    record.writes = operation.catch(() => {});
    await operation;
    return structuredClone(emitted!);
  }
  get(id: string): EvolutionRun | undefined {
    const run = this.records.get(id)?.run;
    return run && structuredClone(run);
  }
  list(): RunSummary[] {
    return [...this.records.values()].map(({ run }) => ({ id: run.id, prompt: run.prompt, provider: run.provider, status: run.status, createdAt: run.createdAt, candidates: run.candidates.length, championId: run.championId })).sort((a, b) => b.createdAt - a.createdAt);
  }
  events(id: string, after = 0): EvolutionEvent[] { return structuredClone(this.require(id).run.events.filter((event) => event.seq > after)); }
  subscribe(id: string, listener: Listener): () => void {
    const record = this.require(id); record.listeners.add(listener);
    return () => record.listeners.delete(listener);
  }
  async flush(): Promise<void> { await Promise.all([...this.records.values()].map((record) => record.writes)); }
  private require(id: string): RunRecord {
    const record = this.records.get(id);
    if (!record) throw new Error(`Unknown run ${id}`);
    return record;
  }
}
export const store = new RunStore(config.DATA_DIR);
