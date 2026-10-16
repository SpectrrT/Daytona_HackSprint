// Feeds ArenaEvents into the reducer from one of three sources:
//   live   — EventSource on /api/events (server re-sends the current run, then streams new events)
//   run    — a recorded run from /api/runs/{id}, replayed with its original timing
//   sample — the bundled /sample-run.jsonl, replayed the same way
// Replay timing = gaps between event `ts` (unix seconds) divided by the speed.

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { EVENTS_URL, fetchRunEvents, fetchSampleEvents, parseEvent } from "./api";
import type { ArenaEvent } from "./contracts";
import { foldEvents, initialArenaState, type ArenaState } from "./state";

export type SourceSpec = { kind: "live" } | { kind: "sample" } | { kind: "run"; runId: string };
export type Speed = 1 | 4 | 16 | "instant";
export const SPEEDS: Speed[] = [1, 4, 16, "instant"];

export type FeedStatus =
  | "loading" // fetching a recording
  | "playing"
  | "paused"
  | "ended"
  | "connecting" // live: opening the stream
  | "live" // live: connected
  | "reconnecting" // live: lost the stream, retrying
  | "error";

export interface ArenaFeed {
  state: ArenaState;
  status: FeedStatus;
  error: string | null;
  isReplay: boolean;
  /** Events applied so far. */
  cursor: number;
  /** Replay: events in the recording. Live: events received on this connection. */
  total: number;
  /** Replay: recording seconds elapsed since the first event. */
  clock: number;
  /** Replay: recording length in seconds. */
  duration: number;
  play(): void;
  pause(): void;
  restart(): void;
  step(): void;
}

/** A replay never sits idle longer than this many wall-clock seconds between two events. */
export const MAX_IDLE_GAP_S = 8;
const TICK_MS = 50;
const LIVE_RETRY_MS = 3000;

export function sourceKey(s: SourceSpec): string {
  return s.kind === "run" ? `run:${s.runId}` : s.kind;
}

export function parseSourceKey(key: string | null): SourceSpec | null {
  if (key === "live" || key === "sample") return { kind: key };
  if (key?.startsWith("run:") && key.length > 4) return { kind: "run", runId: key.slice(4) };
  return null;
}

interface FeedState {
  arena: ArenaState;
  cursor: number;
}
type FeedAction = { type: "reset" } | { type: "apply"; events: ArenaEvent[] };

function feedReducer(s: FeedState, a: FeedAction): FeedState {
  if (a.type === "reset") return { arena: initialArenaState, cursor: 0 };
  return { arena: foldEvents(a.events, s.arena), cursor: s.cursor + a.events.length };
}

export function useArenaFeed(source: SourceSpec, speed: Speed, autoplay = true): ArenaFeed {
  const key = sourceKey(source);
  const isReplay = source.kind !== "live";

  const [feed, dispatch] = useReducer(feedReducer, { arena: initialArenaState, cursor: 0 });
  const [status, setStatus] = useState<FeedStatus>(isReplay ? "loading" : "connecting");
  const [error, setError] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [clock, setClock] = useState(0);
  const [loaded, setLoaded] = useState(0); // bumps when a recording finishes loading

  const eventsRef = useRef<ArenaEvent[]>([]);
  const cursorRef = useRef(0);
  const clockRef = useRef(0);

  const t0 = () => eventsRef.current[0]?.ts ?? 0;
  const duration = eventsRef.current.length ? eventsRef.current[eventsRef.current.length - 1].ts - t0() : 0;

  // ---- Source: load a recording or open the live stream -------------------------------------
  useEffect(() => {
    dispatch({ type: "reset" });
    eventsRef.current = [];
    cursorRef.current = 0;
    clockRef.current = 0;
    setClock(0);
    setTotal(0);
    setError(null);
    setPlaying(false);

    const spec = parseSourceKey(key);
    if (!spec) return;

    if (spec.kind === "live") {
      let disposed = false;
      let es: EventSource | null = null;
      let retry: number | null = null;
      let flushTimer: number | null = null;
      let buffer: ArenaEvent[] = [];

      const flush = () => {
        flushTimer = null;
        if (!buffer.length) return;
        const batch = buffer;
        buffer = [];
        dispatch({ type: "apply", events: batch });
        setTotal((t) => t + batch.length);
      };

      const connect = () => {
        if (disposed) return;
        setStatus("connecting");
        es = new EventSource(EVENTS_URL);
        es.onopen = () => {
          // The server re-sends the whole current run on every (re)connect: start from scratch.
          buffer = [];
          dispatch({ type: "reset" });
          setTotal(0);
          setError(null);
          setStatus("live");
        };
        es.onmessage = (m: MessageEvent<string>) => {
          const ev = parseEvent(m.data);
          if (!ev) return console.warn("live: skipped malformed event", m.data);
          buffer.push(ev);
          if (flushTimer === null) flushTimer = window.setTimeout(flush, 40);
        };
        es.onerror = () => {
          if (disposed || !es) return;
          if (es.readyState === EventSource.CLOSED) {
            // The browser gave up (e.g. proxy error because the arena is down): retry ourselves.
            setStatus("error");
            setError("Live stream unavailable. Is the arena running on :8000? Retrying...");
            es.close();
            retry = window.setTimeout(connect, LIVE_RETRY_MS);
          } else {
            setStatus("reconnecting");
          }
        };
      };
      connect();

      return () => {
        disposed = true;
        es?.close();
        if (retry !== null) clearTimeout(retry);
        if (flushTimer !== null) clearTimeout(flushTimer);
      };
    }

    let cancelled = false;
    setStatus("loading");
    const load = spec.kind === "sample" ? fetchSampleEvents() : fetchRunEvents(spec.runId);
    load
      .then((events) => {
        if (cancelled) return;
        eventsRef.current = events;
        setTotal(events.length);
        setLoaded((n) => n + 1);
        if (!events.length) {
          setStatus("ended");
          setError("This recording has no events.");
        } else if (autoplay) {
          setPlaying(true);
          setStatus("playing");
        } else {
          setStatus("paused");
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setStatus("error");
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
    // `autoplay` is deliberately read only when the source changes.
  }, [key]);

  // ---- Replay engine ------------------------------------------------------------------------
  const applyUpTo = useCallback((end: number) => {
    const events = eventsRef.current;
    const start = cursorRef.current;
    if (end <= start) return;
    cursorRef.current = end;
    dispatch({ type: "apply", events: events.slice(start, end) });
  }, []);

  const finish = useCallback(() => {
    clockRef.current = eventsRef.current.length ? eventsRef.current[eventsRef.current.length - 1].ts - t0() : 0;
    setClock(clockRef.current);
    setPlaying(false);
    setStatus("ended");
  }, []);

  useEffect(() => {
    if (!isReplay || !playing) return;
    const events = eventsRef.current;
    if (!events.length) return;

    if (speed === "instant") {
      applyUpTo(events.length);
      finish();
      return;
    }

    let lastWall = performance.now();
    let lastShown = 0;
    const tick = () => {
      if (eventsRef.current !== events) return; // the source changed under us; this interval is stale
      const now = performance.now();
      clockRef.current += ((now - lastWall) / 1000) * speed;
      lastWall = now;

      const start = t0();
      let i = cursorRef.current;
      while (i < events.length && events[i].ts - start <= clockRef.current) i++;
      applyUpTo(i);
      if (i >= events.length) return finish();

      // Never sit idle longer than MAX_IDLE_GAP_S of wall time (e.g. a long phone call).
      const waitWall = (events[i].ts - start - clockRef.current) / speed;
      if (waitWall > MAX_IDLE_GAP_S) clockRef.current = events[i].ts - start - MAX_IDLE_GAP_S * speed;

      if (now - lastShown > 250) {
        lastShown = now;
        setClock(clockRef.current);
      }
    };
    const id = window.setInterval(tick, TICK_MS);
    return () => window.clearInterval(id);
  }, [isReplay, playing, speed, loaded, applyUpTo, finish]);

  // ---- Controls -----------------------------------------------------------------------------
  const restart = useCallback(() => {
    if (!isReplay || !eventsRef.current.length) return;
    dispatch({ type: "reset" });
    cursorRef.current = 0;
    clockRef.current = 0;
    setClock(0);
    setPlaying(true);
    setStatus("playing");
  }, [isReplay]);

  const play = useCallback(() => {
    if (!isReplay || !eventsRef.current.length) return;
    if (cursorRef.current >= eventsRef.current.length) return restart();
    setPlaying(true);
    setStatus("playing");
  }, [isReplay, restart]);

  const pause = useCallback(() => {
    if (!isReplay || cursorRef.current >= eventsRef.current.length) return;
    setPlaying(false);
    setStatus("paused");
  }, [isReplay]);

  const step = useCallback(() => {
    const events = eventsRef.current;
    if (!isReplay || cursorRef.current >= events.length) return;
    setPlaying(false);
    const next = cursorRef.current + 1;
    applyUpTo(next);
    clockRef.current = events[next - 1].ts - t0();
    setClock(clockRef.current);
    if (next >= events.length) finish();
    else setStatus("paused");
  }, [isReplay, applyUpTo, finish]);

  return {
    state: feed.arena,
    status,
    error,
    isReplay,
    cursor: feed.cursor,
    total,
    clock,
    duration,
    play,
    pause,
    restart,
    step,
  };
}
