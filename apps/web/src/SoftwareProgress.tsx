import { useEffect, useMemo, useState } from 'react';
import { ArrowDownToLine, ArrowRight, Check, ChevronDown, GitBranch, Loader2, LockKeyhole, RotateCcw, ShieldCheck, X } from 'lucide-react';
import type { SoftwareCandidate, SoftwareRun, SoftwareRunSummary } from '@hollow-purple/shared/software';
import { checkOutcome, countChecks, DIRECTED_CHECKS, softwareProgress, type CandidateProgress, type CheckOutcome, type VerificationPoint } from '@hollow-purple/shared/software-progress';
import './software-progress.css';

const elapsed = (milliseconds: number) => `${Math.floor(Math.max(0, milliseconds) / 60000)}:${String(Math.floor(Math.max(0, milliseconds) / 1000) % 60).padStart(2, '0')}`;
const date = (at: number) => new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
async function read<T>(path: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(path, { signal });
  if (!response.ok) throw new Error(`Could not load software evidence (${response.status}).`);
  return response.json() as Promise<T>;
}

export default function SoftwareProgress() {
  const [runs, setRuns] = useState<SoftwareRunSummary[]>([]);
  const [id, setId] = useState(() => new URLSearchParams(window.location.search).get('softwareRun') ?? '');
  const [run, setRun] = useState<SoftwareRun | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    void read<SoftwareRunSummary[]>('/api/software/runs', controller.signal).then(items => {
      const sorted = items.toSorted((a, b) => b.createdAt - a.createdAt);
      setRuns(sorted); setError('');
      setId(current => current || sorted.find(item => item.status === 'completed' && item.championId)?.id || sorted[0]?.id || '');
      if (!sorted.length) setLoading(false);
    }).catch(error => { if (!controller.signal.aborted) { setError(error.message); setLoading(false); } });
    return () => controller.abort();
  }, [refresh]);
  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    setLoading(true); setError(''); setRun(previous => previous?.id === id ? previous : null);
    const load = async () => {
      try {
        const next = await read<SoftwareRun | { id: string; status: 'queued' }>(`/api/software/runs/${encodeURIComponent(id)}`, controller.signal);
        if (controller.signal.aborted) return;
        if (next.status !== 'queued') { setRun(next); setLoading(false); }
        if (next.status === 'running' || next.status === 'queued') timer = setTimeout(() => void load(), 1500);
      } catch (error) {
        if (!controller.signal.aborted) { setError((error as Error).message); setLoading(false); }
      }
    };
    void load();
    const url = new URL(window.location.href); url.searchParams.set('softwareRun', id); window.history.replaceState(null, '', url);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [id, refresh]);
  return <div className="software-progress" data-testid="software-progress">
    <div className="software-toolbar">
      <label>SOFTWARE RUN <span className="software-select"><select aria-label="Software run" value={id} onChange={event => setId(event.target.value)}>
        {!runs.length && <option value="">No saved software runs</option>}
        {id && !runs.some(item => item.id === id) && <option value={id}>{id}</option>}
        {runs.map(item => <option value={item.id} key={item.id}>{date(item.createdAt)} · {item.status} · {item.id.slice(0, 24)}</option>)}
      </select><ChevronDown size={13}/></span></label>
      <div><button className="button subtle" onClick={() => setRefresh(value => value + 1)} aria-label="Refresh software evidence"><RotateCcw size={14}/>Refresh</button>
        {run && <a className="button subtle" href={`/api/software/runs/${encodeURIComponent(run.id)}/export`} download><ArrowDownToLine size={14}/>Export evidence</a>}</div>
    </div>
    {error && <div className="error-banner" role="alert">{error}</div>}
    {loading && !run && <div className="loading-state" role="status"><Loader2 size={21} className="spin"/>Loading software evidence…</div>}
    {!loading && !run && !error && <div className="empty-state"><GitBranch size={28}/><h2>No measured software run yet</h2><p>Run the checkout experiment to collect real browser failures and repair verdicts.</p><code>pnpm software:demo --open</code></div>}
    {run && <SoftwareProgressCharts key={run.id} run={run}/>}
  </div>;
}

export function SoftwareProgressCharts({ run }: { run: SoftwareRun }) {
  const progress = useMemo(() => softwareProgress(run), [run]);
  const [selectedId, setSelectedId] = useState(run.championId ?? run.candidates[0]?.id ?? '');
  const candidate = run.candidates.find(item => item.id === selectedId) ?? run.candidates[0];
  const selected = progress.candidates.find(item => item.id === candidate?.id);
  const champion = run.candidates.find(item => item.id === run.championId);
  const checks = countChecks(champion?.checks ?? []);
  const failures = run.regressions.filter(failure => failure.reproduced);
  const end = Math.max(run.createdAt + 1000, run.finishedAt ?? Date.now(), ...run.events.map(event => event.at));
  const timePoints = progress.candidates.filter(point => point.at !== null && point.remaining !== null);
  const timed = progress.timeline.at(-1)!;
  return <>
    <div className="software-scope"><ShieldCheck size={17}/><p><strong>Checkout reliability</strong> · Measured retries, receipts, validation and inventory consistency. Broader website security and UX quality need their own checks.</p><span className={`run-badge ${run.status}`}>{run.status}</span></div>
    {run.error && <div className="error-banner" role="alert">Run {run.status}: {run.error}</div>}
    <div className="software-stats">
      <Stat label="SELECTED REPAIR" value={champion ? champion.id.toUpperCase() : '—'} detail={champion?.label ?? 'Awaiting a verified candidate'}/>
      <Stat label="SELECTED REPAIR CHECKS" value={champion ? `${checks.passed}/${checks.total}` : '—'} detail="Actual HTTP and SQLite verification"/>
      <Stat label="REPRODUCED FAILURES" value={String(failures.length).padStart(2, '0')} detail="Confirmed again with a fresh process and database"/>
      <Stat label="PURCHASE REQUESTS" value={String(run.budget.usedRequests)} detail={`${run.budget.usedBrowserActions} browser actions · ${elapsed(end - run.createdAt)} elapsed`}/>
    </div>
    <ol className="software-roles" aria-label="Agent ownership">
      <li><b className="role-red">R</b><span><strong>Red finds</strong><small>Proposes form actions; Anchor executes</small></span><ArrowRight size={14}/></li>
      <li><b>V</b><span><strong>Verifier reproduces</strong><small>Replays and checks HTTP + SQLite</small></span><ArrowRight size={14}/></li>
      <li><b className="role-blue">B</b><span><strong>Blue repairs</strong><small>Writes checkout.py in a separate model session</small></span><ArrowRight size={14}/></li>
      <li><b>V</b><span><strong>Verifier gates</strong><small>Regressions, new Red tests and held-out checks</small></span></li>
    </ol>
    <div className="software-chart-grid">
      <section className="panel software-chart-panel">
        <div className="panel-heading"><div className="panel-title"><GitBranch size={16}/><h2>Known failures by version</h2></div><span className="panel-meta">Same reproduced scenarios</span></div>
        <p className="software-chart-caption">Each point is one candidate’s verdict against the {failures.length || 'current'} known regression{failures.length === 1 ? '' : 's'}.</p>
        {timePoints.length ? <RegressionChart points={timePoints} count={failures.length} start={run.createdAt} end={end} selected={candidate?.id ?? ''} onSelect={setSelectedId}/> : <div className="software-chart-empty">A reproduced failure and timed candidate verdicts will appear here.</div>}
        <p className="software-chart-note">Lower is better. Unmeasured candidates are omitted. The repairs below retain their actual parent relationships.</p>
      </section>
      <section className="panel software-chart-panel">
        <div className="panel-heading"><div className="panel-title"><ShieldCheck size={16}/><h2>Verification over time</h2></div><span className="panel-meta">{timed.total} timed results</span></div>
        <div className="software-chart-legend"><span><i className="passed"/>Passed results</span><span><i className="failed"/>Failed results</span></div>
        <VerificationChart points={progress.timeline} start={run.createdAt} end={end}/>
        <p className="software-chart-note">Cumulative executions across versions, including repeated tests. {progress.historicalTiming ? 'Historical checks are grouped at recorded verdicts; individual check times were not saved.' : 'Each result is placed at its recorded verification time.'}{progress.untimedResults > 0 && ` ${progress.untimedResults} untimed results appear only in the version details.`}</p>
      </section>
    </div>
    <div className="software-version-list" aria-label="Inspect a software candidate">
      {progress.candidates.map(point => {
        const item = run.candidates.find(candidate => candidate.id === point.id)!;
        return <button className={`software-version ${candidate?.id === point.id ? 'selected' : ''}`} key={point.id} aria-pressed={candidate?.id === point.id} onClick={() => setSelectedId(point.id)}>
          <span><b>{point.id.toUpperCase()}</b><span className={`software-outcome ${item.status === 'verified' ? 'passed' : item.status === 'rejected' ? 'failed' : 'unmeasured'}`}>{run.championId === item.id ? 'Selected repair' : item.status}</span></span>
          <strong>{point.label}</strong><small>{item.importedFixture ? 'Manual fault fixture' : `Blue repair of ${point.parentId?.toUpperCase() ?? 'new design'}`} · {point.passed}/{point.total} recorded checks passed</small>
        </button>;
      })}
    </div>
    <section className="panel software-coverage">
      <div className="panel-heading"><div className="panel-title"><ShieldCheck size={16}/><h2>What was actually checked</h2></div><span className="panel-meta">Unmeasured stays unmeasured</span></div>
      <div className="table-scroll"><table><caption className="software-chart-caption">The baseline was stopped after the first reproduced failure. It did not run the full acceptance suite.</caption><thead><tr><th scope="col">Requirement / check</th>{run.candidates.map(item => <th scope="col" key={item.id}>{item.id.toUpperCase()}{item.parentId && <small>Repair of {item.parentId.toUpperCase()}</small>}</th>)}</tr></thead><tbody>
        {failures.map(failure => <tr key={failure.id}><th scope="row">{failure.discovery.attack.name}<small>Identical browser regression</small></th>{progress.candidates.map(point => <td key={point.id}><Outcome value={point.regressions.find(result => result.id === failure.id)!.outcome}/></td>)}</tr>)}
        {DIRECTED_CHECKS.map(([id, name]) => <tr key={id}><th scope="row">{name}<small>Directed API check</small></th>{run.candidates.map(item => <td key={item.id}><Outcome value={checkOutcome(item.checks.filter(check => check.id === id))}/></td>)}</tr>)}
        <tr><th scope="row">Independent held-out streams<small>Different seeded inputs per repair</small></th>{run.candidates.map(item => { const checks = item.checks.filter(check => check.hidden); return <td key={item.id}><Outcome value={checkOutcome(checks)} count={checks.length}/></td>; })}</tr>
        <tr><th scope="row">Red browser scenarios<small>Exploratory cases vary by version; includes inherited cases</small></th>{run.candidates.map(item => { const checks = item.checks.filter(check => /^(red|inherited|adapted)-/.test(check.id)); return <td key={item.id}><Outcome value={checkOutcome(checks)} count={checks.length}/></td>; })}</tr>
      </tbody></table></div>
    </section>
    {candidate && selected && <CandidateDetails candidate={candidate} point={selected} start={run.createdAt}/>}
    <footer className="software-footer"><span><LockKeyhole size={12}/> Frozen contract <code>{run.contract.hash.slice(0, 16)}</code></span><span>{run.id} · No overall security score</span></footer>
  </>;
}

function Stat({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <div className="software-stat"><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>;
}
function Outcome({ value, count }: { value: CheckOutcome; count?: number }) {
  return <span className={`software-outcome ${value}`}>{value === 'passed' ? <Check size={12}/> : value === 'failed' ? <X size={12}/> : <span aria-hidden="true">—</span>}{value === 'unmeasured' ? 'Not run' : `${value === 'passed' ? 'Passed' : 'Failed'}${count ? ` (${count})` : ''}`}</span>;
}

const W = 620, H = 262, LEFT = 45, RIGHT = 22, TOP = 26, BOTTOM = 51;
const xAt = (at: number, start: number, end: number) => LEFT + (at - start) / (end - start) * (W - LEFT - RIGHT);
const yAt = (value: number, max: number) => H - BOTTOM - value / max * (H - TOP - BOTTOM);
function Axes({ max, start, end, unit, integer = false }: { max: number; start: number; end: number; unit: string; integer?: boolean }) {
  const steps = integer ? Math.min(4, max) : 4;
  return <g className="software-chart-axes">
    <text x={LEFT} y={13}>{unit}</text>
    {Array.from({ length: steps + 1 }, (_, index) => {
      const value = max * index / steps, y = yAt(value, max);
      return <g key={index}><line x1={LEFT} y1={y} x2={W - RIGHT} y2={y}/><text x={LEFT - 12} y={y + 4} textAnchor="end">{Number(value.toFixed(1))}</text></g>;
    })}
    {Array.from({ length: 5 }, (_, index) => { const at = start + (end - start) * index / 4; return <text key={index} x={xAt(at, start, end)} y={H - 28} textAnchor={index === 0 ? 'start' : index === 4 ? 'end' : 'middle'}>{elapsed(at - start)}</text>; })}
    <text x={(W + LEFT - RIGHT) / 2} y={H - 5} textAnchor="middle">Elapsed run time (min:sec)</text>
  </g>;
}
function RegressionChart({ points, count, start, end, selected, onSelect }: { points: CandidateProgress[]; count: number; start: number; end: number; selected: string; onSelect: (id: string) => void }) {
  const max = Math.max(1, count);
  return <div className="software-chart-scroll"><svg className="software-chart" viewBox={`0 0 ${W} ${H}`} role="group" aria-label="Known regression failures at each candidate verdict. Select a point to inspect that version.">
    <Axes max={max} start={start} end={end} unit="Failing known regressions" integer/>
    {points.map(point => {
      const x = xAt(point.at!, start, end), y = yAt(point.remaining!, max);
      return <g className={`software-chart-point ${point.remaining === 0 ? 'passed' : 'failed'} ${selected === point.id ? 'selected' : ''}`} key={point.id} role="button" tabIndex={0}
        aria-label={`${point.id.toUpperCase()}: ${point.remaining} failing known regressions at ${elapsed(point.at! - start)}. Inspect candidate.`}
        onClick={() => onSelect(point.id)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(point.id); } }}>
        <title>{`${point.label}: ${point.remaining} failing known regressions; ${point.passed}/${point.total} recorded checks passed.`}</title>
        <circle className="software-point-hit" cx={x} cy={y} r={16}/><circle className="software-point-ring" cx={x} cy={y} r={10}/><circle cx={x} cy={y} r={5}/>
        <text x={x} y={y + (point.remaining === 0 ? -17 : 24)} textAnchor="middle">{point.id.toUpperCase()} · {point.remaining === 0 ? 'Pass' : `${point.remaining} failed`}</text>
      </g>;
    })}
  </svg></div>;
}
function VerificationChart({ points, start, end }: { points: VerificationPoint[]; start: number; end: number }) {
  const max = Math.max(4, Math.ceil(Math.max(...points.map(point => Math.max(point.passed, point.failed))) / 4) * 4);
  const path = (key: 'passed' | 'failed') => points.map((point, index) => `${index ? 'H' : 'M'}${xAt(point.at, start, end)}${index ? 'V' : ','}${yAt(point[key], max)}`).join(' ') + ` H${xAt(end, start, end)}`;
  return <div className="software-chart-scroll"><svg className="software-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Recorded verification results over time: ${points.at(-1)!.passed} passed, ${points.at(-1)!.failed} failed. These count executions across versions, not a security percentage.`}>
    <Axes max={max} start={start} end={end} unit="Recorded check results"/>
    <path className="software-result-line passed" d={path('passed')}/><path className="software-result-line failed" d={path('failed')}/>
    {points.slice(1).map(point => <g key={point.at}><title>{`${elapsed(point.at - start)}: ${point.passed} passed results, ${point.failed} failed results.`}</title><circle className="software-result-mark passed" cx={xAt(point.at, start, end)} cy={yAt(point.passed, max)} r={3.5}/><circle className="software-result-mark failed" cx={xAt(point.at, start, end)} cy={yAt(point.failed, max)} r={3.5}/></g>)}
  </svg></div>;
}
function CandidateDetails({ candidate, point, start }: { candidate: SoftwareCandidate; point: CandidateProgress; start: number }) {
  return <section className="panel software-details" aria-label={`Details for ${candidate.id.toUpperCase()}`}>
    <div className="panel-heading"><div className="panel-title"><GitBranch size={16}/><h2>{candidate.id.toUpperCase()} · {candidate.label}</h2></div><span className="panel-meta">{point.at === null ? 'Verdict time unavailable' : `Verdict at ${elapsed(point.at - start)}`}</span></div>
    <div className="software-detail-body"><div><h3>{candidate.importedFixture ? 'Explicitly seeded baseline' : 'Blue’s repair'}</h3><p>{candidate.importedFixture ? 'This demo starts from a manually fault-seeded checkout. Red discovered and reproduced its actual retry failure. The baseline is not model-generated.' : candidate.rationale ?? 'The actual Blue invocation and repair source are retained with this run.'}</p>
      <dl className="software-agent-facts">{(['blueAgent', 'redAgent'] as const).map(key => { const agent = candidate[key]; return <div key={key}><dt>{key === 'blueAgent' ? 'Blue' : 'Red'}</dt><dd>{agent ? `${agent.provider} · ${agent.model} · ${(agent.durationMs / 1000).toFixed(1)}s` : key === 'blueAgent' && candidate.importedFixture ? 'Manual fixture' : 'No invocation recorded'}</dd></div>; })}</dl>
      <p className="software-tool-note">Separate model sessions return structured proposals. The controller owns browser execution, deployment and verdicts.</p>
      <details><summary>Inspect the actual source</summary><pre><code>{candidate.source}</code></pre></details><div className="software-source-hash">SHA-256 <code>{candidate.sourceHash}</code></div></div>
      <div><h3>{point.passed}/{point.total} recorded checks passed</h3><ul className="software-check-list">{candidate.checks.map((check, index) => <li key={`${check.id}-${index}`}><Outcome value={check.passed ? 'passed' : 'failed'}/><span>{check.id}<small>{check.hidden ? 'Held-out inputs withheld from agents' : `${check.requests} purchase requests`}</small></span></li>)}</ul>{!candidate.checks.length && <p>No check results recorded yet.</p>}</div></div>
  </section>;
}
