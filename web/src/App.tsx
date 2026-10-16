// App shell: header, notices, and the three views. Every view renders from feed.state only.

import { TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { TABS, TopBar, type Tab } from "./components/TopBar";
import { parseSourceKey, sourceKey, SPEEDS, useArenaFeed, type SourceSpec, type Speed } from "./useEventSource";
import { Graduation } from "./views/Graduation";
import { Metrics } from "./views/Metrics";
import { Overview } from "./views/Overview";

type Theme = "light" | "dark";

// URL params keep the presenter's choices across reloads: ?source=sample|live|run:<id>&speed=4&tab=arena
function readParams(): { source: SourceSpec; speed: Speed; tab: Tab } {
  const q = new URLSearchParams(window.location.search);
  const speed = SPEEDS.find((s) => String(s) === q.get("speed")) ?? 4;
  const tab = TABS.find((t) => t.id === q.get("tab"))?.id ?? "arena";
  return { source: parseSourceKey(q.get("source")) ?? { kind: "sample" }, speed, tab };
}

function initialTheme(): Theme {
  try {
    const saved = localStorage.getItem("antibody-theme");
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    /* storage unavailable */
  }
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export default function App() {
  const [initial] = useState(readParams);
  const [source, setSource] = useState<SourceSpec>(initial.source);
  const [speed, setSpeed] = useState<Speed>(initial.speed);
  const [tab, setTab] = useState<Tab>(initial.tab);
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [selectedWorldId, setSelectedWorldId] = useState<string | null>(null);

  const feed = useArenaFeed(source, speed);
  const state = feed.state;

  // Apply the theme with transitions suppressed for one frame, so colors don't animate on the swap.
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.classList.add("no-transitions");
    root.dataset.theme = theme;
    void root.offsetHeight;
    const id = requestAnimationFrame(() => root.classList.remove("no-transitions"));
    try {
      localStorage.setItem("antibody-theme", theme);
    } catch {
      /* storage unavailable */
    }
    return () => cancelAnimationFrame(id);
  }, [theme]);

  useEffect(() => {
    const q = new URLSearchParams({ source: sourceKey(source), speed: String(speed), tab });
    window.history.replaceState(null, "", `?${q}`);
  }, [source, speed, tab]);

  // A new source means a different run: drop the selection.
  useEffect(() => setSelectedWorldId(null), [source]);

  const showWorld = useCallback((id: string) => {
    setSelectedWorldId(id);
    setTab("arena");
  }, []);

  // Keyboard: 1-3 views, Space play/pause, R restart, N next event, Esc closes world details.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const n = Number(e.key);
      if (n >= 1 && n <= TABS.length) setTab(TABS[n - 1].id);
      else if (e.key === " " && feed.isReplay && t?.getAttribute("role") !== "button") {
        e.preventDefault();
        if (t?.tagName === "BUTTON") t.blur();
        if (feed.status === "playing") feed.pause();
        else feed.play();
      } else if (e.key === "r" || e.key === "R") feed.restart();
      else if (e.key === "n" || e.key === "N") feed.step();
      else if (e.key === "Escape") setSelectedWorldId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [feed]);

  return (
    <div className="app">
      <TopBar
        tab={tab}
        onTab={setTab}
        source={source}
        onSource={setSource}
        speed={speed}
        onSpeed={setSpeed}
        feed={feed}
        theme={theme}
        onToggleTheme={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
      />
      {state.backend === "fake" && (
        <div className="notice" role="note">
          <TriangleAlert size={14} strokeWidth={2} aria-hidden="true" />
          Showing data from the fake backend. These numbers are not measured.
        </div>
      )}
      {feed.error && (
        <div className="notice notice--bad" role="alert">
          <TriangleAlert size={14} strokeWidth={2} aria-hidden="true" />
          {feed.error}
        </div>
      )}
      <main className="main">
        {tab === "arena" && <Overview state={state} selectedWorldId={selectedWorldId} onSelectWorld={setSelectedWorldId} />}
        {tab === "scoreboard" && <Metrics state={state} />}
        {tab === "graduation" && <Graduation state={state} onSelectWorld={showWorld} />}
      </main>
    </div>
  );
}
