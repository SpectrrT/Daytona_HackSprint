import { useEffect, useId, useState, type KeyboardEvent } from 'react';
import { ArrowDownToLine, ArrowRight, ArrowUpRight, Check, ChevronDown, Code2, ExternalLink, Loader2, Play, Plus, RotateCcw, ShieldCheck, Square, X } from 'lucide-react';
import type { AgentEnvironment, LabCandidate, LabRun, LabRunSummary, LabTrial } from '@hollow-purple/shared/agent-lab';
import { compareDomain, regressionProgress, runOutcome, runPhase } from './agent-lab-view';
import './agent-lab.css';

const domains: { id: AgentEnvironment; label: string }[] = [
  { id: 'engineering', label: 'Engineering' }, { id: 'procurement', label: 'Purchasing' }, { id: 'support', label: 'Support' },
];
const date = (at: number) => new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const money = (cents: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...options?.headers } });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `Request failed (${response.status})`);
  return result as T;
}

export default function AgentLab() {
  const [ready, setReady] = useState<boolean | null>(null);
  const [runs, setRuns] = useState<LabRunSummary[]>([]);
  const [id, setId] = useState(() => new URLSearchParams(window.location.search).get('agentRun') ?? '');
  const [run, setRun] = useState<LabRun | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<'start' | 'stop' | null>(null);
  const [pending, setPending] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [runLoadFailed, setRunLoadFailed] = useState(false);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([api<{ ready: boolean }>('/api/agent-lab/status'), api<LabRunSummary[]>('/api/agent-lab/runs')]).then(([status, history]) => {
      if (cancelled) return;
      setReady(status.ready); setRuns(history); setLoaded(true); setError('');
      setId(current => current || history.find(item => item.status === 'running')?.id || history.find(item => item.status === 'completed')?.id || history[0]?.id || '');
    }).catch(error => { if (!cancelled) { setError(error.message); setLoaded(true); } });
    return () => { cancelled = true; };
  }, [refresh]);

  useEffect(() => {
    if (!id) return;
    let cancelled = false, timer: ReturnType<typeof setTimeout> | undefined;
    setRun(previous => previous?.id === id ? previous : null); setError(''); setRunLoadFailed(false);
    const load = async () => {
      try {
        const next = await api<LabRun | { id: string; status: 'queued' }>(`/api/agent-lab/runs/${encodeURIComponent(id)}`);
        if (cancelled) return;
        setPending(next.status === 'queued');
        if (next.status !== 'queued') {
          setRun(next);
          const summary = { id: next.id, status: next.status, createdAt: next.createdAt, championId: next.championId };
          setRuns(history => history.some(item => item.id === next.id) ? history.map(item => item.id === next.id ? summary : item) : [summary, ...history]);
        }
        if (next.status === 'running' || next.status === 'queued') timer = setTimeout(() => void load(), 1500);
      } catch (error) { if (!cancelled) { setError((error as Error).message); setPending(false); setRunLoadFailed(true); } }
    };
    void load();
    const url = new URL(window.location.href); url.searchParams.set('agentRun', id); window.history.replaceState(null, '', url);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [id, refresh]);

  async function start() {
    if (busy || pending) return;
    const active = runs.find(item => item.status === 'running');
    if (active) { setId(active.id); return; }
    setBusy('start'); setError('');
    try {
      const created = await api<{ id: string }>('/api/agent-lab/runs', { method: 'POST', body: JSON.stringify({ suite: 'cross-domain' }) });
      setPending(true); setId(created.id); setRefresh(value => value + 1);
    } catch (error) { setError((error as Error).message); }
    finally { setBusy(null); }
  }

  async function stop() {
    if (!run || busy || !run.controllable) return;
    setBusy('stop'); setError('');
    try { setRun(await api<LabRun>(`/api/agent-lab/runs/${run.id}/stop`, { method: 'POST', body: '{}' })); setRefresh(value => value + 1); }
    catch (error) { setError((error as Error).message); }
    finally { setBusy(null); }
  }

  const running = run?.status === 'running';
  const activeElsewhere = runs.some(item => item.status === 'running' && item.id !== id);
  return <div className="agent-lab" data-testid="agent-lab">
    <div className="lab-page-header">
      <div className="lab-page-title"><h1>Runs</h1>{runs.length > 0 && <label className="lab-history"><select aria-label="Run history" value={id} onChange={event => { setPending(false); setId(event.target.value); }}>
        {id && !runs.some(item => item.id === id) && <option value={id}>{runLoadFailed ? 'Unavailable run' : pending ? 'Starting…' : 'Current run'}</option>}
        {runs.map(item => <option key={item.id} value={item.id}>{date(item.createdAt)}{item.status === 'running' ? ' · Running' : item.status === 'failed' ? ' · Failed' : item.status === 'stopped' ? ' · Stopped' : ''}</option>)}
      </select><ChevronDown size={14} aria-hidden="true"/></label>}</div>
      {(run || id || runs.length > 0) && <div className="lab-page-actions">
        {running ? run.controllable ? <button className="lab-button lab-button-quiet" disabled={!!busy} onClick={() => void stop()}>{busy === 'stop' ? <Loader2 className="spin" size={14}/> : <Square size={12}/>}Stop run</button> : <span className="lab-origin">Started in Claude</span>
          : <button className="lab-button lab-button-primary" disabled={(!ready && !activeElsewhere) || !!busy || pending} onClick={() => void start()}>{busy === 'start' || pending ? <Loader2 className="spin" size={15}/> : <Plus size={16}/>} {busy === 'start' || pending ? 'Starting…' : activeElsewhere ? 'View active run' : 'Start run'}</button>}
      </div>}
    </div>

    {error && <div className="lab-error" role="alert"><X size={16}/><span>{error}</span><button className="lab-icon-button" aria-label="Retry connection" onClick={() => setRefresh(value => value + 1)}><RotateCcw size={15}/></button></div>}
    {run?.error && !error && <div className="lab-error" role="alert"><X size={16}/><span>{run.error}</span></div>}

    {!run && runLoadFailed ? <section className="lab-empty"><h2>This run couldn’t be loaded.</h2><button className="lab-button lab-button-quiet" onClick={() => setRefresh(value => value + 1)}><RotateCcw size={14}/>Try again</button></section>
      : !run && (id || !loaded) ? <section className="lab-loading" aria-live="polite"><Loader2 className="spin" size={21}/><span>{pending ? 'Starting your run…' : 'Loading…'}</span></section>
      : !run ? <section className="lab-empty">
        <div className="lab-empty-symbol"><ShieldCheck size={26} strokeWidth={1.5}/></div>
        <h2>Start your first run.</h2>
        <p>Test engineering, purchasing, and support agents.</p>
        <button className="lab-button lab-button-primary" disabled={!ready || !!busy || pending} onClick={() => void start()}>{busy === 'start' ? <Loader2 className="spin" size={15}/> : <Plus size={16}/>}Start run</button>
      </section> : <>
        <RunSummary run={run}/>
        <AgentLabEvidence run={run}/>
        <div className="lab-run-links">
          <div>{run.desktopUrl && <a href={run.desktopUrl} target="_blank" rel="noreferrer"><ExternalLink size={14}/>Open sandbox</a>}{run.status === 'completed' && run.videoPath && <a href={`/api/agent-lab/runs/${run.id}/video`} target="_blank" rel="noreferrer"><Play size={13}/>Recording</a>}</div>
          <a href={`/api/agent-lab/runs/${run.id}/export`} download><ArrowDownToLine size={14}/>Export</a>
        </div>
      </>}
    {ready === false && <p className="lab-connection-note">Execution is unavailable. Check the connection in <a href="?view=system">Settings<ArrowUpRight size={11}/></a>.</p>}
  </div>;
}

function RunSummary({ run }: { run: LabRun }) {
  const outcome = runOutcome(run);
  const duration = run.finishedAt ? Math.max(1, Math.round((run.finishedAt - run.createdAt) / 60_000)) : null;
  const elapsed = Math.max(0, Math.floor((Date.now() - run.createdAt) / 60_000));
  const phase = runPhase(run);
  return <section className={`lab-summary ${run.status}`} aria-label="Run result">
    <div className="lab-summary-top"><span className={`lab-status ${outcome.verified ? 'verified' : run.status}`}>
      {outcome.verified ? <Check size={13}/> : run.status === 'running' ? <Loader2 className="spin" size={13}/> : <span className="lab-status-dot"/>}
      {outcome.verified ? 'Verified' : run.status === 'running' ? 'In progress' : run.status === 'failed' ? 'Run failed' : run.status === 'stopped' ? 'Stopped' : 'No verified repair'}
    </span><span className="lab-summary-date">{duration ? `${duration} min` : elapsed ? `${elapsed} min elapsed` : 'Just started'}</span></div>
    <h2>{outcome.verified ? `${outcome.fixed} ${outcome.fixed === 1 ? 'failure' : 'failures'} fixed` : run.status === 'running' ? ['Testing your agents', 'Building a repair', 'Verifying the repair'][phase] : 'Review the results'}</h2>
    <p>{outcome.verified ? `${outcome.passed} of ${outcome.total} checks passed.` : run.status === 'running' ? run.events.at(-1)?.message ?? 'Preparing the sandbox…' : `${run.failures.length} reproduced ${run.failures.length === 1 ? 'failure' : 'failures'} retained.`}</p>
    {run.status === 'running' && <ol className="lab-phase-track" aria-label="Run progress">{['Test', 'Repair', 'Verify'].map((label, index) => <li key={label} className={index < phase ? 'done' : index === phase ? 'current' : ''} aria-current={index === phase ? 'step' : undefined}><span>{index < phase ? <Check size={11}/> : index + 1}</span>{label}</li>)}</ol>}
  </section>;
}

export function AgentLabEvidence({ run }: { run: LabRun | null }) {
  const [domain, setDomain] = useState<AgentEnvironment>('engineering');
  const tabId = useId();
  if (!run) return null;
  const { failure, before, after, origin, champion } = compareDomain(run, domain);
  const selected = champion ?? run.candidates.at(-1);
  function changeTab(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const next = event.key === 'ArrowRight' ? (index + 1) % domains.length : event.key === 'ArrowLeft' ? (index + domains.length - 1) % domains.length : event.key === 'Home' ? 0 : event.key === 'End' ? domains.length - 1 : null;
    if (next === null) return;
    event.preventDefault(); setDomain(domains[next]!.id); document.getElementById(`${tabId}-${domains[next]!.id}`)?.focus();
  }
  return <>
    <section className="lab-result-card">
      <div className="lab-tabs" role="tablist" aria-label="Application results">{domains.map((item, index) => {
        const checks = champion?.checks.filter(check => check.domain === item.id) ?? [];
        return <button key={item.id} id={`${tabId}-${item.id}`} role="tab" aria-selected={domain === item.id} aria-controls={`${tabId}-panel`} tabIndex={domain === item.id ? 0 : -1} onClick={() => setDomain(item.id)} onKeyDown={event => changeTab(event, index)}>{item.label}{checks.length > 0 && <span>{checks.filter(check => check.passed).length}/{checks.length}</span>}</button>;
      })}</div>
      <div className="lab-case" id={`${tabId}-panel`} role="tabpanel" aria-labelledby={`${tabId}-${domain}`} tabIndex={0}>
        <div className="lab-case-heading"><h3>{failure?.discovery.attack.name ?? before?.attack.name ?? 'Waiting for the first test'}</h3>{failure && <span className={`lab-case-verdict ${after?.check.passed ? 'fixed' : ''}`}>{after?.check.passed ? <Check size={12}/> : <span className="lab-status-dot"/>}{after?.check.passed ? 'Fixed' : 'Reproduced'}</span>}</div>
        <div className="lab-comparison"><TrialCard title="Before" candidate={origin} trial={before}/><TrialCard title="After" candidate={champion} trial={after}/></div>
        {before && <details className="lab-input-details"><summary>View test input<ChevronDown size={14}/></summary><div><h4>Message</h4><p>{before.attack.message}</p><h4>Reference</h4><p>{before.attack.knowledge}</p><div className="lab-response-grid"><div><h4>Original response</h4><p>{before.proposal.reply}</p></div>{after && <div><h4>Repaired response</h4><p>{after.proposal.reply}</p></div>}</div></div></details>}
      </div>
    </section>

    <details className="lab-disclosure lab-activity" open={run.status === 'running'}><summary><span>Activity{run.status === 'running' && <span className="lab-live-dot"/>}</span><ChevronDown size={14}/></summary><ol>{run.events.length ? run.events.slice(-12).map((event, index) => <li key={`${event.at}-${index}`}><time>{time(event.at)}</time><p>{event.message}</p></li>) : <li>Activity will appear when the run starts.</li>}</ol></details>

    <details className="lab-disclosure lab-run-details"><summary><span>Run details</span><ChevronDown size={14}/></summary><div className="lab-detail-content">
      <section><h3>Versions</h3><div className="lab-versions">{regressionProgress(run).map(version => <div key={version.id}><span className="lab-version-marker">{version.id.toUpperCase()}</span><div><strong>{version.fixture ? 'Original · manual fixture' : 'Blue’s repair'}</strong><small>{version.parent ? `From ${version.parent.toUpperCase()}` : 'Starting version'}</small></div><span className={version.remaining === 0 ? 'lab-text-success' : ''}>{version.remaining === null ? 'Not fully measured' : `${version.remaining} ${version.remaining === 1 ? 'failure' : 'failures'} remaining`}</span></div>)}</div></section>
      {selected && <section><h3>Repair</h3><p>{selected.rationale ?? 'The starting version is a manual fixture with a permissive guard.'}</p><details className="lab-code"><summary><Code2 size={14}/>Authorization code<ChevronDown size={14}/></summary><pre><code>{selected.guardSource}</code></pre></details><details className="lab-code"><summary>Agent instructions<ChevronDown size={14}/></summary><pre>{selected.systemPrompt}</pre></details><dl className="lab-metadata"><dt>Version</dt><dd>{selected.id.toUpperCase()}</dd><dt>Sandbox</dt><dd>{selected.sandboxId ?? 'Not provisioned'}</dd><dt>Commit</dt><dd>{selected.commit ?? 'Not committed'}</dd><dt>Source</dt><dd>{selected.sourceHash}</dd>{selected.blueAgent && <><dt>Blue</dt><dd>{selected.blueAgent.provider} / {selected.blueAgent.model}</dd></>}{selected.redAgent && <><dt>Red</dt><dd>{selected.redAgent.provider} / {selected.redAgent.model}</dd></>}<dt>Target</dt><dd>{selected.trials.at(-1)?.targetAgent.model ?? 'No invocation yet'}</dd></dl></section>}
      {champion && <section><h3>Checks</h3><div className="lab-check-list">{champion.checks.map(check => <div key={check.id}><span className={check.passed ? 'lab-text-success' : 'lab-text-danger'}>{check.passed ? <Check size={13}/> : <X size={13}/>}</span><span>{check.hidden ? 'Held-out check' : check.summary}</span><small>{check.domain}</small></div>)}</div></section>}
      <section><h3>Requirements</h3><div className="lab-rules">{run.contract.rules.map(rule => <div key={rule.id}><strong>{rule.title}</strong><p>{rule.description}</p></div>)}</div></section>
      <p className="lab-measurement-note">Results cover these tests on synthetic records. They do not establish security for every possible input.</p>
    </div></details>
  </>;
}

function TrialCard({ title, candidate, trial }: { title: string; candidate?: LabCandidate; trial?: LabTrial }) {
  return <div className={`lab-trial ${trial ? trial.check.passed ? 'passed' : 'failed' : 'unmeasured'}`}>
    <div className="lab-trial-heading"><span>{title}</span></div>
    {trial ? <>
      <div className="lab-trial-body">{trial.snapshot.tools.length ? trial.snapshot.tools.map(tool => <div className="lab-tool" key={tool.sequence}><div><code>{tool.tool}</code><span className={tool.allowed ? 'executed' : 'blocked'}>{tool.allowed ? 'Executed' : 'Blocked'}</span></div><p>{tool.recordId}{tool.amountCents > 0 && ` · ${money(tool.amountCents)}`}{tool.target && <><ArrowRight size={12}/>{tool.target}</>}</p></div>) : <div className="lab-no-action"><ShieldCheck size={20} strokeWidth={1.5}/><span>No action taken</span></div>}</div>
      <div className="lab-trial-verdict" title={trial.check.summary}>{trial.check.passed ? <Check size={14}/> : <X size={14}/>}<span>{trial.check.passed ? 'Passed verification' : trial.check.summary.startsWith('Unauthorized:') ? 'Unauthorized action' : 'Failed verification'}</span></div>
    </> : <div className="lab-trial-body lab-trial-pending"><span>{candidate ? 'This input has not been replayed.' : title === 'After' ? 'The repair will appear here.' : 'The first result will appear here.'}</span></div>}
  </div>;
}
