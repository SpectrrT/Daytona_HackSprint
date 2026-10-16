import { useEffect, useState } from 'react';
import { ArrowDownToLine, ArrowRight, ArrowUpRight, Check, ChevronDown, Code2, ExternalLink, FileText, GitBranch, Loader2, LockKeyhole, MessageSquare, Play, RotateCcw, ShieldCheck, ShoppingCart, Square, Terminal, X } from 'lucide-react';
import { AGENT_ENVIRONMENTS, type AgentEnvironment, type LabCandidate, type LabRun, type LabRunSummary, type LabTrial } from '@hollow-purple/shared/agent-lab';
import './agent-lab.css';
const icons = { support: MessageSquare, procurement: ShoppingCart, engineering: Terminal };
const formatTime = (at: number) => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
const money = (value: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value / 100);
async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...options?.headers } });
  const result = await response.json(); if (!response.ok) throw new Error(result.error ?? `Request failed (${response.status})`); return result as T;
}
export default function AgentLab() {
  const [ready, setReady] = useState<boolean | null>(null), [runs, setRuns] = useState<LabRunSummary[]>([]), [id, setId] = useState(() => new URLSearchParams(window.location.search).get('agentRun') ?? '');
  const [run, setRun] = useState<LabRun | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void Promise.all([api<{ ready: boolean }>('/api/agent-lab/status'), api<LabRunSummary[]>('/api/agent-lab/runs')]).then(([status, history]) => {
      if (cancelled) return; setReady(status.ready); setRuns(history); setError(''); setId(current => current || history.find(item => item.status === 'running')?.id || history.find(item => item.status === 'completed')?.id || history[0]?.id || '');
    }).catch(error => { if (!cancelled) setError(error.message); }); return () => { cancelled = true; };
  }, [refresh]);
  useEffect(() => {
    if (!id) return;
    let cancelled = false, timer: ReturnType<typeof setTimeout> | undefined;
    setRun(previous => previous?.id === id ? previous : null); setError('');
    const load = async () => {
      try { const next = await api<LabRun | { id: string; status: 'queued' }>(`/api/agent-lab/runs/${encodeURIComponent(id)}`); if (cancelled) return;
        if (next.status !== 'queued') {
          setRun(next);
          setRuns(history => history.some(item => item.id === next.id) ? history.map(item => item.id === next.id ? { id: next.id, status: next.status, createdAt: next.createdAt, championId: next.championId } : item) : [{ id: next.id, status: next.status, createdAt: next.createdAt, championId: next.championId }, ...history]);
        }
        if (next.status === 'running' || next.status === 'queued') timer = setTimeout(() => void load(), 1500);
      } catch (error) { if (!cancelled) setError((error as Error).message); }
    }; void load();
    const url = new URL(window.location.href); url.searchParams.set('agentRun', id); window.history.replaceState(null, '', url);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [id, refresh]);
  async function start() {
    setBusy(true); setError(''); try { const created = await api<{ id: string }>('/api/agent-lab/runs', { method: 'POST', body: JSON.stringify({ suite: 'cross-domain' }) }); setId(created.id); setRefresh(value => value + 1); }
    catch (error) { setError((error as Error).message); } finally { setBusy(false); }
  }
  async function stop() { if (!run) return; setBusy(true); try { setRun(await api<LabRun>(`/api/agent-lab/runs/${run.id}/stop`, { method: 'POST', body: '{}' })); } catch (error) { setError((error as Error).message); } finally { setBusy(false); } }
  return <div className="agent-lab" data-testid="agent-lab">
    <div className="lab-hero"><div><span className="lab-eyebrow"><span/> THREE APPLICATIONS. ONE ENGINEERING LOOP.</span><h1>Agents under pressure<span>.</span></h1><p>Find the failure. Build the repair.<br/>Verify that useful work still gets done.</p></div><div className="lab-hero-actions"><span className="lab-runtime"><span className={`tiny-dot ${ready ? 'green' : ''}`}/>{ready === null ? 'Checking execution providers' : ready ? 'Daytona + Anchor + real model agents' : 'Execution providers are unavailable'}</span><button className="lab-primary" disabled={!ready || busy || (run?.status === 'running' && !run.controllable)} onClick={() => void (run?.status === 'running' ? stop() : start())}>{busy ? <Loader2 className="spin" size={15}/> : run?.status === 'running' ? <Square size={13}/> : <Play size={14}/>} {run?.status === 'running' ? run.controllable ? 'Stop experiment' : 'Experiment running' : 'Run agent experiment'}<ArrowRight size={15}/></button><small>Bounded run · up to 3 candidates · 36 model jobs</small></div></div>
    {error && <div className="error-banner" role="alert">{error}</div>}
    <div className="lab-run-toolbar"><span><GitBranch size={14}/> {run ? run.status === 'completed' ? 'Verified experiment' : `Experiment ${run.status}` : id ? 'Preparing the experiment…' : 'Choose an application to inspect'}</span><div>{runs.length > 0 && <label className="lab-history"><select aria-label="Agent experiment" value={id} onChange={event => setId(event.target.value)}>{id && !runs.some(item => item.id === id) && <option value={id}>Current experiment</option>}{runs.map(item => <option value={item.id} key={item.id}>{formatTime(item.createdAt)} · {item.status}</option>)}</select><ChevronDown size={12}/></label>}<button className="lab-icon" aria-label="Refresh agent evidence" onClick={() => setRefresh(value => value + 1)}><RotateCcw size={14}/></button>{run && <a className="lab-export" href={`/api/agent-lab/runs/${run.id}/export`} download><ArrowDownToLine size={13}/>Evidence</a>}</div></div>
    {run?.error && <div className="error-banner" role="alert">{run.error}</div>}
    <AgentLabEvidence run={run}/>
  </div>;
}
export function AgentLabEvidence({ run }: { run: LabRun | null }) {
  const [domain, setDomain] = useState<AgentEnvironment>('engineering');
  const environment = AGENT_ENVIRONMENTS.find(item => item.id === domain)!;
  const failure = run?.failures.find(item => item.discovery.attack.domain === domain);
  const baseline = run?.candidates[0], champion = run?.candidates.find(item => item.id === run.championId);
  const origin = failure ? run?.candidates.find(item => item.id === failure.candidateId) : baseline;
  const before = failure?.discovery ?? baseline?.trials.find(trial => trial.attack.domain === domain);
  const after = champion?.trials.find(trial => failure ? trial.check.id === `regression-${failure.id}` : before && trial.attack.domain === domain && trial.attack.message === before.attack.message && trial.attack.knowledge === before.attack.knowledge);
  const selected = champion ?? run?.candidates.at(-1);
  const lastEvent = run?.events.at(-1), Icon = icons[domain];
  return <>
    <div className="lab-environments" aria-label="Applications under test">{[...AGENT_ENVIRONMENTS].reverse().map(item => { const CaseIcon = icons[item.id]; const checks = champion?.checks.filter(check => check.domain === item.id) ?? []; return <button className={`lab-environment ${domain === item.id ? 'active' : ''}`} key={item.id} onClick={() => setDomain(item.id)} aria-pressed={domain === item.id}><span className="lab-case-top"><CaseIcon size={19}/><span>{checks.length ? `${checks.filter(check => check.passed).length}/${checks.length} checks passed` : run?.status === 'running' ? 'Testing in progress' : 'Environment contract'}</span></span><strong>{item.name}</strong><p>{item.description}</p><span className="lab-case-bottom">{item.label}<ArrowUpRight size={13}/></span></button>; })}</div>
    <div className="lab-ownership"><span><b className="red">R</b>Red finds a failure</span><ArrowRight size={13}/><span><b>V</b>Verifier reproduces it</span><ArrowRight size={13}/><span><b className="blue">B</b>Blue repairs the agent</span><ArrowRight size={13}/><span><b>V</b>Fresh tests decide</span></div>
    <section className="lab-story"><div className="lab-story-heading"><div><span className="lab-section-label"><Icon size={13}/> {environment.label}</span><h2>{environment.name}, under test.</h2></div><span className={`lab-story-status ${failure ? 'confirmed' : ''}`}>{failure ? <><Check size={12}/>Failure independently reproduced</> : before ? before.check.passed ? 'No breach in this input' : 'Initial observation' : 'Ready for a measured experiment'}</span></div>
      <p className="lab-story-description">{environment.threat}</p>
      <div className="lab-input"><div className="lab-input-title"><FileText size={14}/><strong>{domain === 'engineering' ? 'Incoming issue & reference' : domain === 'procurement' ? 'Purchase request & vendor quote' : 'Customer message & help article'}</strong><span>UNTRUSTED INPUT</span></div>{before ? <><p>{before.attack.message}</p><details><summary>Read the supplied reference <ChevronDown size={12}/></summary><pre>{before.attack.knowledge}</pre></details></> : <p className="lab-unmeasured">Red will author this input from the actual agent instructions and authorization code. Its tool effects will appear below after execution.</p>}</div>
      <div className="lab-compare"><TrialCard title={origin?.id === baseline?.id ? 'Original agent' : 'Failing ancestor'} candidate={origin} trial={before} repaired={false}/><div className="lab-compare-arrow"><ArrowRight size={18}/></div><TrialCard title="Blue’s repair" candidate={champion} trial={after} repaired/></div>
    </section>
    {run && <div className="lab-evidence-grid"><section className="lab-progress"><div className="lab-panel-heading"><h2>Known failures by version</h2><span>Same retained regressions</span></div><div className="lab-version-chart" role="img" aria-label="Failing known regressions for each candidate; unmeasured versions are explicitly labeled.">{run.candidates.map(candidate => {
      const outcomes = run.failures.map(failure => failure.candidateId === candidate.id ? false : candidate.checks.find(check => check.id === `regression-${failure.id}`)?.passed);
      const unknown = !outcomes.length || outcomes.some(outcome => outcome === undefined), remaining = outcomes.filter(outcome => outcome === false).length;
      return <div className="lab-version-row" key={candidate.id}><span><b>{candidate.id.toUpperCase()}</b><small>{candidate.importedFixture ? 'Manual starter' : `Repair of ${candidate.parentId?.toUpperCase()}`}</small></span><div className="lab-bar-track"><div className={`lab-bar ${remaining ? 'failed' : ''}`} style={{ width: unknown ? '0%' : `${remaining / Math.max(1, run.failures.length) * 100}%` }}/></div><strong>{unknown ? 'Not fully measured' : `${remaining} failing`}</strong></div>;
    })}</div><p className="lab-chart-note">Lower is better. Every new failure expands the regression gate. Passing these finite checks does not prove universal security.</p><div className="lab-run-facts"><span><b>{run.failures.length}</b>reproduced failures</span><span><b>{champion ? `${champion.checks.filter(check => check.passed).length}/${champion.checks.length}` : '—'}</b>selected repair checks</span><span><b>{run.budget.usedModelCalls}</b>model jobs</span></div></section>
    <section className="lab-activity"><div className="lab-panel-heading"><h2>What’s happening</h2><span>{run.status}</span></div><ol>{run.events.slice(-5).map((event, index) => <li key={`${event.at}-${index}`}><span className="lab-event-dot"/><div><p>{event.message}</p><small>{formatTime(event.at)}{event.candidateId && ` · ${event.candidateId.toUpperCase()}`}</small></div></li>)}</ol>{!lastEvent && <p className="lab-unmeasured">The controller’s actual events will appear here.</p>}</section></div>}
    {run && <details className="lab-contract"><summary><LockKeyhole size={14}/><strong>Frozen agent contract</strong><code title={run.contract.hash}>{run.contract.hash.slice(0, 16)}</code><ChevronDown size={13}/></summary><div>{run.contract.rules.map(rule => <article key={rule.id}><h3>{rule.title}</h3><p>{rule.description}</p></article>)}</div></details>}
    {selected && <section className="lab-source"><div className="lab-panel-heading"><h2><Code2 size={14}/> {selected.id.toUpperCase()} · Actual repair artifacts</h2><span>{selected.sourceHash.slice(0, 16)}</span></div><p>{selected.rationale ?? 'Explicitly imported, permissive legacy fixture. No Blue invocation is attributed to it.'}</p><div className="lab-source-details"><details><summary>Authorization source <ChevronDown size={13}/></summary><pre><code>{selected.guardSource}</code></pre></details><details><summary>Agent instructions <ChevronDown size={13}/></summary><pre>{selected.systemPrompt}</pre></details></div><div className="lab-provenance">{selected.blueAgent && <span>Blue · {selected.blueAgent.provider} / {selected.blueAgent.model}</span>}{selected.redAgent && <span>Red · {selected.redAgent.provider} / {selected.redAgent.model}</span>}<span>Target · {selected.trials.at(-1)?.targetAgent.model ?? 'No invocation yet'}</span></div></section>}
    <footer className="lab-footer"><p><ShieldCheck size={13}/> Actual models and sandbox processes. Purchases, refunds, records and releases use synthetic fixtures.</p><div>{run?.desktopUrl && <a href={run.desktopUrl} target="_blank" rel="noreferrer">Open actual sandbox <ExternalLink size={12}/></a>}{run?.status === 'completed' && run.videoPath && <a href={`/api/agent-lab/runs/${run.id}/video`} target="_blank" rel="noreferrer"><Play size={12}/>Watch sandbox recording</a>}</div></footer>
  </>;
}
function TrialCard({ title, candidate, trial, repaired }: { title: string; candidate?: LabCandidate; trial?: LabTrial; repaired: boolean }) {
  return <div className={`lab-trial ${trial ? trial.check.passed ? 'passed' : 'failed' : ''}`}><div className="lab-trial-heading"><span><b className={repaired ? 'blue' : 'red'}>{repaired ? 'B' : 'A'}</b><strong>{title}</strong></span><small>{candidate?.id.toUpperCase() ?? 'Pending'}</small></div>
    {trial ? <><div className="lab-tool-proposals">{trial.snapshot.tools.length ? trial.snapshot.tools.map(tool => <div key={tool.sequence}><code>{tool.tool}</code><span className={tool.allowed ? 'executed' : 'blocked'}>{tool.allowed ? 'Executed' : 'Blocked'}</span><p>{tool.recordId}{tool.amountCents > 0 && ` · ${money(tool.amountCents)}`}{tool.target && ` → ${tool.target}`}</p></div>) : <p className="lab-unmeasured">The target proposed no tool action for this input.</p>}</div><div className="lab-trial-verdict">{trial.check.passed ? <ShieldCheck size={15}/> : <X size={15}/>}<div><strong>{trial.check.passed ? 'Contract preserved' : 'Contract violated'}</strong><p>{trial.check.summary}</p></div></div><details className="lab-model-response"><summary>Actual target response <ChevronDown size={12}/></summary><p>{trial.proposal.reply}</p></details></> : <div className="lab-trial-empty"><ShieldCheck size={22}/><strong>{repaired ? candidate ? 'This exact input was not replayed' : 'A repair must earn its result' : 'Start with observable behavior'}</strong><p>{repaired ? candidate ? 'Other checks are recorded for this repair above. No outcome is attributed to this particular input.' : 'Blue will write new instructions and authorization code. The verifier will replay the exact failure and check legitimate work.' : 'The model’s tool calls and persisted effects will appear after Red’s input runs in Daytona.'}</p></div>}
  </div>;
}
