// Metrics: is the defender improving, what did it cost, did it block clean work, how fast.
// Charts follow the dataviz rules: one series color, 2px lines, 8px markers with a surface ring,
// bars <= 24px with a 4px rounded data-end, hairline solid gridlines, labels in text color.

import { useState } from "react";
import { money, moneyShort, secs } from "../format";
import {
  genStats,
  orderedGenerations,
  speedupPair,
  survivalRate,
  type ArenaState,
  type GenStats,
  type GenerationState,
} from "../state";

interface Point {
  gen: GenerationState;
  stats: GenStats;
  label: string;
}

export function Metrics({ state }: { state: ArenaState }) {
  const points: Point[] = orderedGenerations(state).map((g) => ({
    gen: g,
    stats: genStats(state, g),
    label: g.exam ? "Exam" : `Gen ${g.generation}`,
  }));
  if (!points.length) {
    return (
      <div className="card empty">
        <div className="empty-title">No generations yet</div>
        <div>Metrics appear once the first generation is graded.</div>
      </div>
    );
  }

  const training = points.filter((p) => !p.gen.exam);
  const last = training.at(-1);
  const lastRate = last ? survivalRate(last.stats) : null;
  const firstRate = training[0] ? survivalRate(training[0].stats) : null;
  const lost = training.reduce((n, p) => n + p.stats.dollarsLost, 0);
  const falseAlarms = points.reduce((n, p) => n + p.stats.falseAlarms, 0);
  const exam = state.exam;
  const speed = speedupPair(state);

  return (
    <>
      <div className="stats stats--4">
        <section className="card stat">
          <div className="stat-label">Survival rate · last training generation</div>
          <div className="stat-value stat-value--hero">{lastRate === null ? "—" : `${Math.round(lastRate * 100)}%`}</div>
          <div className="stat-foot">
            {firstRate !== null && lastRate !== null && training.length > 1
              ? `From ${Math.round(firstRate * 100)}% in gen 1`
              : "Attack worlds defended"}
          </div>
        </section>
        <section className="card stat">
          <div className="stat-label">Dollars lost in training</div>
          <div className="stat-value num">{moneyShort(lost)}</div>
          <div className="stat-foot">Mock money overpaid to attacks</div>
        </section>
        <section className="card stat">
          <div className="stat-label">False alarms</div>
          <div className="stat-value num">{falseAlarms}</div>
          <div className="stat-foot">Clean worlds with missed refunds</div>
        </section>
        <section className="card stat">
          <div className="stat-label">Final exam</div>
          <div className="stat-value">{exam ? (exam.passed ? "Passed" : "Failed") : "—"}</div>
          <div className="stat-foot">
            {exam ? `${exam.attack_worlds - exam.breaches}/${exam.attack_worlds} held-out attacks blocked` : "Runs after training"}
          </div>
        </section>
      </div>

      <div className="metric-grid">
        <ChartCard title="Survival rate by generation" sub="Share of attack worlds defended">
          <SurvivalChart points={points} />
        </ChartCard>
        <ChartCard title="Dollars lost by generation" sub="Overpaid in attack worlds, mock money">
          <LossChart points={points} />
        </ChartCard>
        <ChartCard title="False alarms by generation" sub="Clean worlds where owed refunds were missed">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  {points.map((p) => (
                    <th key={p.gen.key} className="r">
                      {p.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr>
                  {points.map((p) => (
                    <td key={p.gen.key} className="r">
                      {p.stats.falseAlarms}
                      <span className="muted"> / {p.stats.cleanWorlds}</span>
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
        </ChartCard>
        <ChartCard title="Parallel vs sequential" sub="One generation, timed both ways">
          {speed ? (
            <div className="hbars">
              <div className="stat-value num">
                {(speed.sequential.seconds / speed.parallel.seconds).toFixed(1)}× faster in parallel
              </div>
              <HBar label="Parallel" value={speed.parallel.seconds} max={speed.sequential.seconds} color="var(--accent-mark)" />
              <HBar label="Sequential" value={speed.sequential.seconds} max={speed.sequential.seconds} color="var(--neutral)" />
            </div>
          ) : (
            <div className="secondary" style={{ fontSize: 13 }}>
              Not measured in this run. Record it with <span className="mono">python -m scripts.run_generation --timing</span>.
            </div>
          )}
        </ChartCard>
      </div>

      <section className="card">
        <div className="card-body">
          <details className="disclosure">
            <summary>All generations as a table</summary>
            <div className="table-wrap" style={{ marginTop: 12 }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Generation</th>
                    <th className="r">Defended</th>
                    <th className="r">Survival</th>
                    <th className="r">Dollars lost</th>
                    <th className="r">False alarms</th>
                    <th className="r">Time</th>
                  </tr>
                </thead>
                <tbody>
                  {points.map((p) => {
                    const rate = survivalRate(p.stats);
                    return (
                      <tr key={p.gen.key}>
                        <td>{p.gen.exam ? "Final exam" : `Gen ${p.gen.generation}`}</td>
                        <td className="r">
                          {p.stats.survived}/{p.stats.attackWorlds}
                        </td>
                        <td className="r">{rate === null ? "—" : `${Math.round(rate * 100)}%`}</td>
                        <td className="r">{money(p.stats.dollarsLost)}</td>
                        <td className="r">
                          {p.stats.falseAlarms}/{p.stats.cleanWorlds}
                        </td>
                        <td className="r">{secs(p.stats.seconds)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </details>
        </div>
      </section>
    </>
  );
}

function ChartCard({ title, sub, children }: { title: string; sub: string; children: React.ReactNode }) {
  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2 className="card-title">{title}</h2>
          <div className="card-sub">{sub}</div>
        </div>
      </div>
      <div className="card-body">{children}</div>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------

const W = 560;
const H = 240;
const M = { top: 20, right: 16, bottom: 32, left: 44 };
const plotW = W - M.left - M.right;
const plotH = H - M.top - M.bottom;

function SurvivalChart({ points }: { points: Point[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const n = points.length;
  const band = plotW / n;
  const xAt = (i: number) => M.left + band * (i + 0.5);
  const yAt = (v: number) => M.top + (1 - v) * plotH;
  const coords = points.map((p, i) => ({ p, x: xAt(i), rate: survivalRate(p.stats) }));
  const train = coords.filter((c) => !c.p.gen.exam && c.rate !== null);
  const line = train.map((c, i) => `${i ? "L" : "M"}${c.x},${yAt(c.rate!)}`).join(" ");
  const area = train.length > 1 ? `${line} L${train.at(-1)!.x},${yAt(0)} L${train[0].x},${yAt(0)} Z` : "";
  const last = train.at(-1);
  const h = hover !== null ? coords[hover] : null;

  return (
    <div className="chart-wrap" onPointerLeave={() => setHover(null)}>
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Survival rate by generation">
        {[0, 0.5, 1].map((v) => (
          <g key={v}>
            <line className={v === 0 ? "c-base" : "c-grid"} x1={M.left} x2={W - M.right} y1={yAt(v)} y2={yAt(v)} />
            <text className="c-tick" x={M.left - 8} y={yAt(v) + 4} textAnchor="end">
              {v * 100}%
            </text>
          </g>
        ))}
        {h && <line className="c-cross" x1={h.x} x2={h.x} y1={M.top} y2={M.top + plotH} />}
        {area && <path className="c-area" d={area} />}
        {train.length > 1 && <path className="c-line" d={line} />}
        {coords.map((c, i) => (
          <g key={c.p.gen.key}>
            <text className="c-xlabel" x={c.x} y={H - 10} textAnchor="middle">
              {c.p.label}
            </text>
            {c.rate !== null && (
              <circle className={c.p.gen.exam ? "c-marker--exam" : "c-marker"} cx={c.x} cy={yAt(c.rate)} r={hover === i ? 5.5 : 4.5} />
            )}
            <rect className="c-hit" x={c.x - band / 2} y={M.top - 10} width={band} height={plotH + 20} onPointerEnter={() => setHover(i)} />
          </g>
        ))}
        {last && last.rate !== null && (
          <text className="c-value" x={last.x} y={yAt(last.rate) - 12} textAnchor="middle">
            {Math.round(last.rate * 100)}%
          </text>
        )}
      </svg>
      {h && h.rate !== null && (
        <div className="tooltip" style={{ left: `${(h.x / W) * 100}%`, top: `${(yAt(h.rate) / H) * 100}%` }}>
          <b>{h.p.gen.exam ? "Final exam" : `Generation ${h.p.gen.generation}`}</b>
          {h.p.stats.survived} of {h.p.stats.attackWorlds} defended ({Math.round(h.rate * 100)}%)
        </div>
      )}
    </div>
  );
}

function LossChart({ points }: { points: Point[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const n = points.length;
  const top = niceCeil(Math.max(1, ...points.map((p) => p.stats.dollarsLost)));
  const yAt = (v: number) => M.top + (1 - v / top) * plotH;
  const band = plotW / n;
  const barW = Math.min(24, band * 0.5);
  const h = hover !== null ? points[hover] : null;

  return (
    <div className="chart-wrap" onPointerLeave={() => setHover(null)}>
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Dollars lost by generation">
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line className={f === 0 ? "c-base" : "c-grid"} x1={M.left} x2={W - M.right} y1={yAt(f * top)} y2={yAt(f * top)} />
            <text className="c-tick" x={M.left - 8} y={yAt(f * top) + 4} textAnchor="end">
              {moneyShort(f * top)}
            </text>
          </g>
        ))}
        {points.map((p, i) => {
          const cx = M.left + band * (i + 0.5);
          const v = p.stats.dollarsLost;
          const y = yAt(v);
          return (
            <g key={p.gen.key}>
              {v > 0 && <path className="c-bar" d={roundedTop(cx - barW / 2, y, barW, M.top + plotH - y, 4)} />}
              {v > 0 && (
                <text className="c-value" x={cx} y={y - 8} textAnchor="middle">
                  {moneyShort(v)}
                </text>
              )}
              <text className="c-xlabel" x={cx} y={H - 10} textAnchor="middle">
                {p.label}
              </text>
              <rect className="c-hit" x={cx - band / 2} y={M.top} width={band} height={plotH} onPointerEnter={() => setHover(i)} />
            </g>
          );
        })}
      </svg>
      {h && (
        <div
          className="tooltip"
          style={{ left: `${((M.left + band * (hover! + 0.5)) / W) * 100}%`, top: `${(yAt(h.stats.dollarsLost) / H) * 100}%` }}
        >
          <b>{h.gen.exam ? "Final exam" : `Generation ${h.gen.generation}`}</b>
          {money(h.stats.dollarsLost)} overpaid · {h.stats.breaches} breaches
        </div>
      )}
    </div>
  );
}

function HBar({ label, value, max, color }: { label: string; value: number; max: number; color: string }) {
  return (
    <div>
      <div className="hbar-head">
        <span>{label}</span>
        <span className="num">{secs(value)}</span>
      </div>
      <div className="hbar-track">
        <div className="hbar-fill" style={{ width: `${Math.max(2, (value / max) * 100)}%`, background: color }} />
      </div>
    </div>
  );
}

function niceCeil(v: number): number {
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

/** A column with a 4px rounded data-end, square at the baseline. */
function roundedTop(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, h, w / 2);
  return `M${x},${y + h} L${x},${y + rr} Q${x},${y} ${x + rr},${y} L${x + w - rr},${y} Q${x + w},${y} ${x + w},${y + rr} L${x + w},${y + h} Z`;
}
