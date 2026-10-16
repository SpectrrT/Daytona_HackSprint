import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowDownToLine, ArrowUp, ArrowUpRight, Check, ChevronDown, ExternalLink, Loader2, Monitor, Play, Plus, RotateCcw, Server, Square, X } from 'lucide-react';
import type { LabConnections, LabPreview, LabRun, LabRunSummary, LabSandbox, LabSandboxList } from '@antibody/shared/agent-lab';
import { AgentLabEvidence } from './AgentLabEvidence';
import { runOutcome } from './agent-lab-view';
import './run-workspace.css';

export const DEFAULT_RUN_PROMPT = 'Test the engineering, purchasing, and support agents for unauthorized actions. Reproduce any failures, repair the guard, and verify that legitimate tasks still work.';
export async function workspaceApi<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...options?.headers } });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `Request failed (${response.status})`);
  return result as T;
}
const shortDate = (at: number) => new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

interface Props {
  run: LabRun | null; runs: LabRunSummary[]; id: string; loaded: boolean; pending: boolean;
  ready: boolean | null; busy: 'start' | 'stop' | null; error: string; runLoadFailed: boolean;
  onSelect: (id: string) => void; onStart: (prompt: string) => void; onStop: () => void; onRetry: () => void;
}
export default function RunWorkspace(props: Props) {
  const { run, runs, id, busy, pending } = props;
  const [prompt, setPrompt] = useState('');
  const [panel, setPanel] = useState<'activity' | 'results'>('activity');
  const [connections, setConnections] = useState<LabConnections | null>(null);
  const [connectionError, setConnectionError] = useState('');
  const [checking, setChecking] = useState(true);
  const [checkCount, setCheckCount] = useState(0);
  const active = runs.find(item => item.status === 'running');
  const outcome = run ? runOutcome(run) : null;
  const running = run?.status === 'running';
  useEffect(() => {
    let cancelled = false; setChecking(true);
    void workspaceApi<LabConnections>('/api/agent-lab/connections').then(value => { if (!cancelled) { setConnections(value); setConnectionError(''); } }).catch(error => { if (!cancelled) setConnectionError(error.message); }).finally(() => { if (!cancelled) setChecking(false); });
    return () => { cancelled = true; };
  }, [checkCount]);
  useEffect(() => { setPanel('activity'); }, [id]);
  function submit(event: FormEvent) { event.preventDefault(); if (!prompt.trim() || running || busy || pending) return; props.onStart(prompt.trim()); }

  return <div className="run-workspace" data-testid="agent-lab">
    <div className="run-toolbar">
      <div className="run-toolbar-title"><h1>Run</h1>{id && <span className={`work-status ${running ? 'is-live' : ''}`}><i/>{pending ? 'Starting' : running ? 'Running' : run?.status === 'completed' ? 'Completed' : run?.status === 'failed' ? 'Failed' : run?.status === 'stopped' ? 'Stopped' : 'Loading'}</span>}</div>
      <div className="run-toolbar-actions">{runs.length > 0 && <label className="run-history"><select aria-label="Run history" value={id} onChange={event => props.onSelect(event.target.value)}><option value="">New run</option>{id && !runs.some(item => item.id === id) && <option value={id}>Starting…</option>}{runs.map(item => <option key={item.id} value={item.id}>{shortDate(item.createdAt)} · {item.status}</option>)}</select><ChevronDown size={13}/></label>}
        {running ? run.controllable ? <button className="work-button" disabled={!!busy} onClick={props.onStop}>{busy === 'stop' ? <Loader2 size={13} className="spin"/> : <Square size={11}/>}Stop run</button> : <span className="work-muted">Started outside this controller</span> : <button className="work-button" disabled={!!busy || pending} onClick={() => { props.onSelect(''); setPrompt(''); }}><Plus size={14}/>New run</button>}
      </div>
    </div>
    {props.error && <div className="work-error" role="alert"><X size={15}/><span>{props.error}</span><button aria-label="Retry connection" onClick={props.onRetry}><RotateCcw size={14}/></button></div>}
    {run?.error && !props.error && <div className="work-error" role="alert"><X size={15}/><span>{run.error}</span></div>}
    <div className="work-panels">
      <SandboxScreen key={id || 'empty'} run={run} pending={pending || !!id && !run && !props.runLoadFailed} onRetry={props.onRetry} loadFailed={props.runLoadFailed}/>
      <aside className="work-agents" aria-label="Agent activity and results">
        <div className="work-panel-bar"><div className="work-panel-tabs" role="tablist" aria-label="Run information"><button role="tab" aria-selected={panel === 'activity'} onClick={() => setPanel('activity')}>Activity{running && <i className="work-live-dot"/>}</button><button role="tab" aria-selected={panel === 'results'} onClick={() => setPanel('results')}>Results{outcome?.verified && <Check size={12}/>}</button></div>{run && <a className="work-icon-button" href={`/api/agent-lab/runs/${run.id}/export`} download aria-label="Export run evidence"><ArrowDownToLine size={14}/></a>}</div>
        <div className="work-agent-content" role="tabpanel" aria-label={panel === 'activity' ? 'Activity' : 'Results'}>
          {run && <div className="work-outcome"><span className={outcome?.verified ? 'work-success' : ''}>{outcome?.verified ? <Check size={14}/> : running ? <Loader2 size={14} className="spin"/> : <Server size={14}/>}<strong>{outcome?.verified ? `${outcome.fixed} failures fixed` : running ? 'Agents are working' : run.status === 'failed' ? 'Run failed' : 'Run finished'}</strong></span><small>{outcome?.verified ? `${outcome.passed}/${outcome.total} checks passed` : `${run.failures.length} reproduced failures`}</small></div>}
          {panel === 'activity' ? <ActivityFeed run={run} pending={pending}/> : run ? <div className="work-results"><AgentLabEvidence run={run}/></div> : <div className="work-panel-empty"><Check size={21}/><p>Verified results appear here.</p></div>}
        </div>
      </aside>
    </div>
    <form className="work-composer" onSubmit={submit}>
      {run?.prompt && <details className="work-original-prompt"><summary>Run request<ChevronDown size={12}/></summary><p>{run.prompt}</p></details>}
      <label htmlFor="run-prompt" className="sr-only">Run prompt</label>
      <textarea id="run-prompt" placeholder="What should the agents test and improve?" value={prompt} maxLength={2000} rows={2} disabled={running || pending || !!busy} onChange={event => setPrompt(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }}/>
      <div className="work-composer-footer"><div className="work-scope"><span>Engineering · Purchasing · Support</span>{!prompt && !running && !pending && <button type="button" onClick={() => setPrompt(DEFAULT_RUN_PROMPT)}>Use example<ArrowUpRight size={12}/></button>}{running && <span className="work-muted">Watch the sandbox and agent activity above.</span>}</div>
        {active && active.id !== id ? <button type="button" className="work-submit" onClick={() => props.onSelect(active.id)}>View active run<ArrowUpRight size={14}/></button> : <button type="submit" className="work-submit" disabled={!prompt.trim() || prompt.trim().length < 5 || running || pending || !!busy || props.ready === false || connections?.ready === false}>{pending || busy === 'start' ? <Loader2 size={15} className="spin"/> : <ArrowUp size={16}/>}<span>{pending || busy === 'start' ? 'Starting…' : running ? 'Running' : 'Start run'}</span></button>}
      </div>
    </form>
    <div className="work-connections" aria-label="Connections"><div>{checking && !connections ? <span><Loader2 size={11} className="spin"/>Checking connections…</span> : connectionError ? <span className="work-danger">{connectionError}</span> : connections?.connections.map(connection => <details key={connection.id} className={`work-connection ${connection.state}`}><summary><i/>{connection.name}<span>{connection.state === 'connected' ? 'Connected' : connection.state === 'authenticated' ? 'Signed in' : connection.state === 'configured' ? 'Configured' : connection.state === 'missing' ? 'Not configured' : 'Unavailable'}</span></summary><div>{connection.detail}<small>Checked {new Date(connections.checkedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</small></div></details>)}</div><button type="button" aria-label="Check connections" disabled={checking} onClick={() => setCheckCount(value => value + 1)}><RotateCcw size={12} className={checking ? 'spin' : ''}/></button></div>
  </div>;
}

function SandboxScreen({ run, pending, loadFailed, onRetry }: { run: LabRun | null; pending: boolean; loadFailed: boolean; onRetry: () => void }) {
  const [resources, setResources] = useState<LabSandboxList | null>(null);
  const [selected, setSelected] = useState('desktop');
  const [preview, setPreview] = useState<LabPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [mode, setMode] = useState<'live' | 'recording'>('live');
  const request = useRef(0);
  useEffect(() => () => { request.current++; }, []);
  const selectedResource = resources?.sandboxes.find(item => item.key === selected);
  useEffect(() => {
    if (!run) return;
    let cancelled = false;
    const load = async () => {
      try { const result = await workspaceApi<LabSandboxList>(`/api/agent-lab/runs/${run.id}/sandboxes`); if (!cancelled) { setResources(result); setPreview(current => current && result.sandboxes.some(item => item.id === current.sandboxId && item.canOpen) ? current : null); setSelected(current => result.sandboxes.some(item => item.key === current) ? current : result.sandboxes[0]?.key ?? 'desktop'); } }
      catch (error) { if (!cancelled) setError((error as Error).message); }
    };
    void load(); const timer = setInterval(() => void load(), 10_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [run?.id, run?.status, refresh]);
  useEffect(() => { if (selectedResource?.canOpen && !preview && !loading && !error) void open(selectedResource, false); }, [selectedResource?.key, selectedResource?.canOpen]);
  useEffect(() => {
    if (!preview) return;
    const timer = setTimeout(() => { request.current++; setPreview(null); setError('This preview link expired. Reconnect to get a fresh link.'); }, Math.max(1, preview.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [preview]);
  async function open(resource: LabSandbox, resume: boolean) {
    if (!run) return;
    const revision = ++request.current; setLoading(true); setError(''); setMode('live');
    try { const result = await workspaceApi<LabPreview>(`/api/agent-lab/runs/${run.id}/sandboxes/${resource.key}/preview`, { method: 'POST', body: JSON.stringify({ resume }) }); if (request.current === revision) { setPreview(result); setRefresh(value => value + 1); } }
    catch (error) { if (request.current === revision) setError((error as Error).message); }
    finally { if (request.current === revision) setLoading(false); }
  }
  function select(key: string) { if (key === selected) return; request.current++; setSelected(key); setPreview(null); setLoading(false); setError(''); setMode('live'); }
  return <section className="work-sandbox" aria-label="Daytona sandboxes">
    <div className="work-panel-bar"><h2><Monitor size={15}/>Sandboxes</h2><div>{run?.status === 'completed' && run.videoPath && <button className="work-recording-button" aria-pressed={mode === 'recording'} onClick={() => setMode(current => current === 'recording' ? 'live' : 'recording')}><Play size={12}/>{mode === 'recording' ? 'Back to live' : 'Recording'}</button>}{preview && mode === 'live' && <a className="work-icon-button" href={preview.url} target="_blank" rel="noreferrer" aria-label="Open actual sandbox in a new tab"><ExternalLink size={14}/></a>}<button className="work-icon-button" aria-label="Refresh sandbox status" onClick={() => setRefresh(value => value + 1)}><RotateCcw size={13}/></button></div></div>
    {!!resources?.sandboxes.length && <div className="work-sandbox-tabs" aria-label="Sandbox list">{resources.sandboxes.map(resource => <button key={resource.key} aria-pressed={selected === resource.key && mode === 'live'} onClick={() => select(resource.key)} title={resource.id}><Server size={13}/><span>{resource.title}</span><small className={`sandbox-state state-${resource.state}`}><i/>{resource.state === 'started' ? 'Live' : resource.state === 'deleted' ? 'Deleted' : resource.state}</small></button>)}</div>}
    <div className="work-screen">
      {mode === 'recording' && run ? <video controls autoPlay playsInline src={`/api/agent-lab/runs/${run.id}/video`} aria-label="Actual Daytona sandbox recording"/> : preview ? <iframe key={preview.url} src={preview.url} title={`Actual Daytona ${preview.kind === 'desktop' ? 'desktop' : 'application'} sandbox`} allow="fullscreen; clipboard-read; clipboard-write" referrerPolicy="no-referrer"/> : <div className="work-screen-empty"><span className="work-screen-icon">{loading || pending ? <Loader2 className="spin" size={26} strokeWidth={1.4}/> : <Monitor size={27} strokeWidth={1.3}/>}</span><h3>{loading ? 'Opening the actual sandbox…' : loadFailed ? 'Run unavailable' : pending ? 'Preparing the sandboxes…' : selectedResource ? selectedResource.canResume ? 'This sandbox is paused.' : selectedResource.state === 'deleted' ? 'This sandbox was deleted.' : selectedResource.canOpen ? 'Open the sandbox.' : 'Sandbox unavailable' : error ? 'Couldn’t load the sandbox.' : run ? resources ? 'No sandboxes were created.' : 'Checking the sandboxes…' : 'Your sandbox opens here.'}</h3><p>{error || (loadFailed ? 'Reconnect to load this run.' : selectedResource?.detail) || (loading ? 'Daytona is starting the desktop and creating a fresh access link.' : pending ? 'Each sandbox appears here as Daytona provisions it.' : !run ? 'Describe what to test below, then start a run.' : 'Watch the recorded run or check its current status.')}</p>{selectedResource && (selectedResource.canOpen || selectedResource.canResume) && <button className="work-button work-button-dark" disabled={loading} onClick={() => void open(selectedResource, selectedResource.canResume)}>{loading ? <Loader2 size={14} className="spin"/> : <Play size={13}/>} {selectedResource.canResume ? 'Resume sandbox' : error ? 'Reconnect' : 'Open sandbox'}</button>}{loadFailed && <button className="work-button" onClick={onRetry}>Try again</button>}{selectedResource?.state === 'deleted' && run?.videoPath && <button className="work-button" onClick={() => setMode('recording')}><Play size={13}/>Watch recording</button>}</div>}
    </div>
    <div className="work-screen-footer"><span>{mode === 'recording' ? 'Recorded during the real Daytona run' : preview?.note ?? (preview ? 'Live Daytona sandbox · view only' : 'Daytona')} </span>{selectedResource && <code title={selectedResource.id}>{selectedResource.id}</code>}</div>
    {error && preview && <div className="work-error" role="alert">{error}</div>}
  </section>;
}

function ActivityFeed({ run, pending }: { run: LabRun | null; pending: boolean }) {
  const list = useRef<HTMLOListElement>(null), follow = useRef(true);
  useEffect(() => { if (list.current && follow.current) list.current.scrollTop = list.current.scrollHeight; }, [run?.events.length]);
  if (!run?.events.length) return <div className="work-panel-empty"><span className="work-agent-symbol">A</span><h3>{pending ? 'Starting the team' : 'Follow the agents'}</h3><p>{pending ? 'Waiting for the controller’s first event…' : 'Sandbox launches, Red’s findings, Blue’s repairs, and verification appear here.'}</p></div>;
  return <ol className="work-feed" ref={list} onScroll={event => { const node = event.currentTarget; follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 60; }} aria-label="Recorded agent events">{run.events.map((event, index) => {
    const role = /^(Daytona|Anchor)\b/.exec(event.message)?.[1] ?? (/^Red\b/.test(event.message) || /new .+input:/.test(event.message) ? 'Red' : /^Blue\b/.test(event.message) ? 'Blue' : /verif|replay|confirmed|Selected/.test(event.message) ? 'Verifier' : 'Controller');
    return <li key={`${event.at}-${index}`} className={`role-${role.toLowerCase()}`}><div className="work-event-meta"><strong>{role}</strong>{event.candidateId && <span>{event.candidateId.toUpperCase()}</span>}<time>{new Date(event.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time></div><p>{event.message}</p></li>;
  })}</ol>;
}
