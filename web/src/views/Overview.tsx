// Overview: headline stats, the worlds matrix, and a side panel (activity, or the selected world).

import { useMemo } from "react";
import { Activity } from "../components/Activity";
import { GlyphPath, STATUS_LABEL, StatusDot } from "../components/Glyph";
import { WorldDetails } from "../components/WorldDetails";
import { humanize, moneyShort } from "../format";
import { currentGeneration, genLabel, genStats, orderedGenerations, survivalRate, type ArenaState } from "../state";
import { DOT_R, HEADER_H, LABEL_W, layoutMatrix, type MatrixLayout } from "./arenaLayout";

interface Props {
  state: ArenaState;
  selectedWorldId: string | null;
  onSelectWorld(id: string | null): void;
}

export function Overview({ state, selectedWorldId, onSelectWorld }: Props) {
  const layout = useMemo(() => layoutMatrix(state), [state]);
  const selected = selectedWorldId ? state.worlds[selectedWorldId] : null;

  return (
    <div className="overview">
      <Stats state={state} />

      <section className="card worlds-card" aria-labelledby="worlds-title">
        <div className="card-head">
          <div>
            <h2 className="card-title" id="worlds-title">
              Worlds
            </h2>
            <div className="card-sub">Each dot is one forked copy of production, graded after the plan ran.</div>
          </div>
          <Legend />
        </div>
        <div className="worlds-body">
          {layout ? (
            <Matrix layout={layout} selectedWorldId={selectedWorldId} onSelectWorld={onSelectWorld} />
          ) : (
            <div className="empty" style={{ flex: 1 }}>
              <div className="empty-title">No generations yet</div>
              <div>Choose a recording or start a live run. Worlds appear here as they are forked.</div>
            </div>
          )}
        </div>
      </section>

      <aside className="card side-card" aria-label={selected ? "World details" : "Activity"}>
        {selected ? (
          <WorldDetails state={state} world={selected} onClose={() => onSelectWorld(null)} />
        ) : (
          <Activity state={state} />
        )}
      </aside>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Stats row. One hero number per view (survival); values stay in text color.
// ---------------------------------------------------------------------------------------------

function Stats({ state }: { state: ArenaState }) {
  const gens = orderedGenerations(state);
  const training = gens.filter((g) => !g.exam);
  const current = currentGeneration(state);
  const st = current ? genStats(state, current) : null;
  const rate = st ? survivalRate(st) : null;
  const first = training[0] ? survivalRate(genStats(state, training[0])) : null;
  const delta = rate !== null && first !== null && current && current.key !== training[0]?.key ? Math.round((rate - first) * 100) : null;

  const lost = training.reduce((n, g) => n + genStats(state, g).dollarsLost, 0);
  const falseAlarms = gens.reduce((n, g) => n + genStats(state, g).falseAlarms, 0);
  const cleanTotal = gens.reduce((n, g) => n + genStats(state, g).cleanWorlds, 0);
  const lessons = state.lessonOrder.length;
  const planned = training.length;

  return (
    <div className="stats">
      <section className="card stat">
        <div className="stat-label">Survival rate{current ? ` · ${genLabel(current).toLowerCase()}` : ""}</div>
        <div className="stat-value stat-value--hero">{rate === null ? "—" : `${Math.round(rate * 100)}%`}</div>
        <div className="stat-foot">
          {st && rate !== null ? `${st.survived} of ${st.attackWorlds} attack worlds defended` : "Waiting for graded worlds"}
          {delta !== null && delta !== 0 && (
            <>
              {" · "}
              <span className={delta > 0 ? "delta-up" : "delta-down"}>
                {delta > 0 ? "+" : ""}
                {delta} pts vs gen 1
              </span>
            </>
          )}
        </div>
      </section>
      <section className="card stat">
        <div className="stat-label">Generation</div>
        <div className="stat-value">{current ? (current.exam ? "Final exam" : `${current.generation} of ${Math.max(planned, current.generation)}`) : "—"}</div>
        <div className="stat-foot">{st ? (st.provisional ? `${st.graded} of ${st.total} worlds graded` : "Graded") : "Not started"}</div>
      </section>
      <section className="card stat">
        <div className="stat-label">Dollars lost</div>
        <div className="stat-value num">{moneyShort(lost)}</div>
        <div className="stat-foot">Overpaid across training (mock money)</div>
      </section>
      <section className="card stat">
        <div className="stat-label">Lessons filed</div>
        <div className="stat-value num">{lessons}</div>
        <div className="stat-foot">One per breached world</div>
      </section>
      <section className="card stat">
        <div className="stat-label">False alarms</div>
        <div className="stat-value num">{falseAlarms}</div>
        <div className="stat-foot">Of {cleanTotal} clean control worlds</div>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Legend
// ---------------------------------------------------------------------------------------------

function Legend() {
  return (
    <div className="legend" aria-label="Legend">
      {(["defended", "breached", "false_alarm", "clean", "pending"] as const).map((s) => (
        <span key={s} className="legend-item">
          <StatusDot status={s} size={14} />
          {STATUS_LABEL[s]}
        </span>
      ))}
      <span className="legend-item">
        <svg width="12" height="12" viewBox="-6 -6 12 12" aria-hidden="true">
          <path className="lesson-mark" d={diamond(0, 0, 4.5)} />
        </svg>
        Lesson filed
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Matrix: attack types down the left, generations across.
// ---------------------------------------------------------------------------------------------

function Matrix({
  layout,
  selectedWorldId,
  onSelectWorld,
}: {
  layout: MatrixLayout;
  selectedWorldId: string | null;
  onSelectWorld(id: string | null): void;
}) {
  const { width, height, rows, groups, cols, dots, links } = layout;

  return (
    <svg
      className="matrix"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="xMidYMin meet"
      role="group"
      aria-label="Worlds by attack type and generation"
    >
      {cols.map((c) => (
        <g key={c.key}>
          {c.exam && <rect className="m-band" x={c.x + 4} y={6} width={c.w - 8} height={height - 10} rx={8} />}
          <text className={`m-col${c.current ? " m-col--current" : ""}`} x={c.x + c.w / 2} y={26} textAnchor="middle">
            {c.exam ? "Final exam" : `Gen ${c.gen.generation}`}
          </text>
          <text className="m-col-sub" x={c.x + c.w / 2} y={43} textAnchor="middle">
            {c.stats.attackWorlds
              ? `${c.stats.survived}/${c.stats.attackWorlds} defended`
              : c.stats.total
                ? `${c.stats.graded}/${c.stats.total} graded`
                : "starting"}
          </text>
          <SplitBar x={c.x + 20} y={52} w={c.w - 40} good={c.stats.survived} bad={c.stats.breaches} total={c.gen.attackIds.length} />
          {c.current && <rect className="m-current" x={c.x + c.w / 2 - 14} y={HEADER_H - 4} width={28} height={2} rx={1} />}
        </g>
      ))}
      <line className="m-line" x1={0} x2={width} y1={HEADER_H - 2} y2={HEADER_H - 2} />

      {groups.map((g) => (
        <text key={g.family} className="m-family" x={4} y={g.y}>
          {g.family === "control" ? "Control (no attack)" : g.family}
        </text>
      ))}
      {rows.map((r) => (
        <g key={r.key}>
          <line className="m-line" x1={0} x2={width} y1={r.y + 25} y2={r.y + 25} />
          <text className={`m-type${r.control ? " m-type--control" : ""}`} x={4} y={r.y + 4.5}>
            {r.control ? "Clean worlds" : capitalize(humanize(r.type))}
          </text>
          {r.lessons > 0 && (
            <g aria-label={`${r.lessons} lessons on this attack type`}>
              <path className="lesson-mark" d={diamond(LABEL_W - 34, r.y, 4.5)} />
              <text className="m-count" x={LABEL_W - 26} y={r.y + 4}>
                {r.lessons}
              </text>
            </g>
          )}
        </g>
      ))}

      {links.map((l) => (
        <path key={l.id} className={`link${l.kept ? "" : " link--mutated"}`} d={l.d} />
      ))}

      {dots.map((d) => {
        const w = d.world;
        const selected = w.id === selectedWorldId;
        const label = `${w.id}: ${STATUS_LABEL[w.status]}${d.attack ? `, ${humanize(d.attack.type)}` : ", clean control"}`;
        return (
          <g
            key={w.id}
            className={`dot dot--${w.status}`}
            transform={`translate(${d.cx}, ${d.cy})`}
            role="button"
            tabIndex={0}
            aria-pressed={selected}
            aria-label={label}
            onClick={() => onSelectWorld(selected ? null : w.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelectWorld(selected ? null : w.id);
              }
            }}
          >
            <title>{label}</title>
            <circle className="dot-hit" r={DOT_R + 6} />
            <circle className="dot-ring" r={DOT_R + 4} />
            <g className="dot-in">
              <circle className="dot-body" r={DOT_R} />
              <GlyphPath status={w.status} />
            </g>
            {d.lessonId && <path className="lesson-mark" d={diamond(DOT_R - 1, -DOT_R + 1, 4)} />}
          </g>
        );
      })}
    </svg>
  );
}

/** Defended vs breached share of a generation's attack worlds, with a 2px gap between the parts. */
function SplitBar({ x, y, w, good, bad, total }: { x: number; y: number; w: number; good: number; bad: number; total: number }) {
  const n = Math.max(total, good + bad, 1);
  const gw = (good / n) * w;
  const bw = (bad / n) * w;
  const gap = gw > 0 && bw > 0 ? 2 : 0;
  return (
    <g aria-hidden="true">
      <rect className="bar-track" x={x} y={y} width={w} height={4} rx={2} />
      {gw > 0 && <rect className="bar-good" x={x} y={y} width={Math.max(gw - gap / 2, 2)} height={4} rx={2} />}
      {bw > 0 && <rect className="bar-bad" x={x + gw + gap / 2} y={y} width={Math.max(bw - gap / 2, 2)} height={4} rx={2} />}
    </g>
  );
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** A lesson marker: a small diamond centered on (cx, cy). */
const diamond = (cx: number, cy: number, r: number) => `M${cx},${cy - r} L${cx + r},${cy} L${cx},${cy + r} L${cx - r},${cy} Z`;
