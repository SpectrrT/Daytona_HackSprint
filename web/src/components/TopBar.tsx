// Header: name, view tabs, run status, replay controls, source picker, theme toggle.

import { Moon, Pause, Play, Rocket, RotateCcw, SkipForward, Sun } from "lucide-react";
import { useState } from "react";
import { listRuns, startRun, type RunInfo } from "../api";
import { clock, dateTime } from "../format";
import { parseSourceKey, SPEEDS, sourceKey, type ArenaFeed, type SourceSpec, type Speed } from "../useEventSource";

export const TABS = [
  { id: "arena", label: "Overview" },
  { id: "scoreboard", label: "Metrics" },
  { id: "graduation", label: "Graduation" },
] as const;
export type Tab = (typeof TABS)[number]["id"];

interface Props {
  tab: Tab;
  onTab(t: Tab): void;
  source: SourceSpec;
  onSource(s: SourceSpec): void;
  speed: Speed;
  onSpeed(s: Speed): void;
  feed: ArenaFeed;
  theme: "light" | "dark";
  onToggleTheme(): void;
}

const STATUS: Record<ArenaFeed["status"], { text: string; live?: boolean }> = {
  loading: { text: "Loading" },
  playing: { text: "Replaying" },
  paused: { text: "Paused" },
  ended: { text: "Replay ended" },
  connecting: { text: "Connecting" },
  live: { text: "Live", live: true },
  reconnecting: { text: "Reconnecting" },
  error: { text: "Offline" },
};

export function TopBar({ tab, onTab, source, onSource, speed, onSpeed, feed, theme, onToggleTheme }: Props) {
  const [runs, setRuns] = useState<RunInfo[]>([]);
  const [starting, setStarting] = useState(false);

  // Recorded runs load only when the picker opens: no polling a backend that may be down.
  const refreshRuns = () => {
    listRuns()
      .then(setRuns)
      .catch(() => setRuns([]));
  };

  const status = STATUS[feed.status];
  const progress = feed.total ? feed.cursor / feed.total : 0;
  const playing = feed.status === "playing";

  const onStart = async () => {
    setStarting(true);
    try {
      await startRun(4);
    } catch (err) {
      console.warn(err);
    } finally {
      setStarting(false);
    }
  };

  return (
    <header className="header">
      <div className="brand">
        <span className="brand-name">Antibody</span>
        <span className="brand-tag">Agent arena</span>
      </div>

      <nav className="tabs" role="tablist" aria-label="Views">
        {TABS.map((t, i) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className="tab" onClick={() => onTab(t.id)}>
            {t.label}
            <kbd>{i + 1}</kbd>
          </button>
        ))}
      </nav>

      <div className="header-right">
        <span className={`badge${status.live ? " badge--live" : ""}`}>
          <span className="badge-dot" />
          {status.text}
        </span>
        {feed.state.backend === "fake" && (
          <span className="badge badge--warn" title="Dev data from the fake backend. Not measured.">
            Fake data
          </span>
        )}

        {feed.isReplay && (
          <>
            <span className="divider-v" aria-hidden="true" />
            <div className="progress" aria-label="Replay progress">
              <div className="progress-track">
                <div className="progress-fill" style={{ transform: `scaleX(${progress})` }} />
              </div>
              <div className="progress-meta">
                <span>
                  {feed.cursor}/{feed.total} events
                </span>
                <span>
                  {clock(feed.clock)} / {clock(feed.duration)}
                </span>
              </div>
            </div>
            <button
              className="icon-btn"
              aria-label={playing ? "Pause (Space)" : "Play (Space)"}
              title={playing ? "Pause (Space)" : "Play (Space)"}
              onClick={() => (playing ? feed.pause() : feed.play())}
              disabled={feed.status === "loading"}
            >
              {playing ? <Pause size={15} strokeWidth={2} /> : <Play size={15} strokeWidth={2} />}
            </button>
            <button className="icon-btn" aria-label="Restart (R)" title="Restart (R)" onClick={feed.restart}>
              <RotateCcw size={15} strokeWidth={2} />
            </button>
            <button className="icon-btn" aria-label="Next event (N)" title="Next event (N)" onClick={feed.step}>
              <SkipForward size={15} strokeWidth={2} />
            </button>
            <div className="seg" role="group" aria-label="Replay speed">
              {SPEEDS.map((s) => (
                <button key={String(s)} aria-pressed={speed === s} onClick={() => onSpeed(s)}>
                  {s === "instant" ? "Max" : `${s}×`}
                </button>
              ))}
            </div>
          </>
        )}

        {source.kind === "live" && (
          <button className="btn btn--primary" onClick={onStart} disabled={starting}>
            <Rocket size={14} strokeWidth={2} />
            {starting ? "Starting…" : "Start run"}
          </button>
        )}

        <span className="divider-v" aria-hidden="true" />
        <select
          className="select"
          aria-label="Event source"
          value={sourceKey(source)}
          onFocus={refreshRuns}
          onPointerDown={refreshRuns}
          onChange={(e) => {
            const s = parseSourceKey(e.target.value);
            if (s) onSource(s);
          }}
        >
          <option value="sample">Sample recording</option>
          <option value="live">Live arena</option>
          {source.kind === "run" && !runs.some((r) => r.run_id === source.runId) && (
            <option value={sourceKey(source)}>Run {source.runId}</option>
          )}
          {runs.length > 0 && (
            <optgroup label="Recorded runs">
              {runs.map((r) => (
                <option key={r.run_id} value={`run:${r.run_id}`}>
                  {r.run_id} · {dateTime(r.started_at)}
                </option>
              ))}
            </optgroup>
          )}
        </select>
        <button
          className="icon-btn"
          aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          title={theme === "dark" ? "Light theme" : "Dark theme"}
          onClick={onToggleTheme}
        >
          {theme === "dark" ? <Sun size={15} strokeWidth={2} /> : <Moon size={15} strokeWidth={2} />}
        </button>
      </div>
    </header>
  );
}
