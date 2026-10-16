// Thin client for the arena backend (FastAPI on :8000, proxied by Vite at /api).

import type { ArenaEvent } from "./contracts";

export interface RunInfo {
  run_id: string;
  events: number;
  started_at: number; // unix seconds
}

export const SAMPLE_URL = "/sample-run.jsonl";
export const EVENTS_URL = "/api/events";

async function getOk(url: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${url} -> ${res.status} ${res.statusText}`);
  return res;
}

export async function listRuns(): Promise<RunInfo[]> {
  const res = await getOk("/api/runs");
  return (await res.json()) as RunInfo[];
}

export async function fetchRunEvents(runId: string): Promise<ArenaEvent[]> {
  const res = await getOk(`/api/runs/${encodeURIComponent(runId)}`);
  return parseJsonl(await res.text());
}

export async function fetchSampleEvents(): Promise<ArenaEvent[]> {
  const res = await getOk(SAMPLE_URL, { cache: "no-store" });
  return parseJsonl(await res.text());
}

export async function startRun(generations: number): Promise<{ run_id: string }> {
  const res = await getOk("/api/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ generations }),
  });
  return (await res.json()) as { run_id: string };
}

/** Light shape check: the reducer ignores unknown types, but every event needs ts/type/payload. */
export function isArenaEvent(x: unknown): x is ArenaEvent {
  if (typeof x !== "object" || x === null) return false;
  const e = x as Record<string, unknown>;
  return typeof e.ts === "number" && typeof e.type === "string" && typeof e.payload === "object" && e.payload !== null;
}

export function parseEvent(text: string): ArenaEvent | null {
  try {
    const x: unknown = JSON.parse(text);
    return isArenaEvent(x) ? x : null;
  } catch {
    return null;
  }
}

/** One ArenaEvent per line. Blank and malformed lines are skipped (and logged). */
export function parseJsonl(text: string): ArenaEvent[] {
  const events: ArenaEvent[] = [];
  let bad = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const ev = parseEvent(line);
    if (ev) events.push(ev);
    else bad += 1;
  }
  if (bad) console.warn(`parseJsonl: skipped ${bad} malformed line(s)`);
  return events;
}
