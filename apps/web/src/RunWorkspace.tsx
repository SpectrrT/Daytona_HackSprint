import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowDownToLine, ArrowUp, ArrowUpRight, Check, ChevronDown, ExternalLink, Loader2, Maximize2, Monitor, Play, Plus, RotateCcw, Server, Square, X } from 'lucide-react';
import type { LabConnections, LabPreview, LabRun, LabRunSummary, LabSandbox, LabSandboxList } from '@antibody/shared/agent-lab';
import { AgentLabEvidence } from './AgentLabEvidence';
import { runOutcome } from './agent-lab-view';
import { panelReceives } from '@antibody/shared/agent-lab-presentation';
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
  const promptInput = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => { const input = promptInput.current; if (input) { input.style.height = '24px'; input.style.height = `${Math.max(24, Math.min(input.scrollHeight, 168))}px`; } }, [prompt]);
  const [panel, setPanel] = useState<'activity' | 'results'>('activity');
  const tabId = useId();
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
  useEffect(() => { if (!connectionError) return; const timer = setTimeout(() => setCheckCount(value => value + 1), 5000); return () => clearTimeout(timer); }, [connectionError, checkCount]);
  function submit(event: FormEvent) { event.preventDefault(); if (prompt.trim().length < 5 || running || busy || pending) return; props.onStart(prompt.trim()); }

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
        <div className="work-panel-bar"><div className="work-panel-tabs" role="tablist" aria-label="Run information" onKeyDown={event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const next = event.key === 'Home' ? 'activity' : event.key === 'End' ? 'results' : panel === 'activity' ? 'results' : 'activity'; setPanel(next); document.getElementById(`${tabId}-${next}`)?.focus(); } }}>{(['activity', 'results'] as const).map(item => <button key={item} id={`${tabId}-${item}`} role="tab" tabIndex={panel === item ? 0 : -1} aria-controls={`${tabId}-content`} aria-selected={panel === item} onClick={() => setPanel(item)}>{item === 'activity' ? <>Activity{running && <i className="work-live-dot"/>}</> : <>Results{outcome?.verified && <Check size={12}/>}</>}</button>)}</div>{run && <a className="work-icon-button" href={`/api/agent-lab/runs/${run.id}/export`} download aria-label="Export run evidence"><ArrowDownToLine size={14}/></a>}</div>
        <div className="work-agent-content" id={`${tabId}-content`} role="tabpanel" aria-labelledby={`${tabId}-${panel}`}>
          {run && <div className="work-outcome"><span className={outcome?.verified ? 'work-success' : ''}>{outcome?.verified ? <Check size={14}/> : running ? <Loader2 size={14} className="spin"/> : <Server size={14}/>}<strong>{outcome?.verified ? `${outcome.fixed} failures fixed` : running ? 'Agents are working' : run.status === 'failed' ? 'Run failed' : 'Run finished'}</strong></span><small>{outcome?.verified ? `${outcome.passed}/${outcome.total} checks passed` : `${run.failures.length} reproduced failures`}</small></div>}
          {panel === 'activity' ? <ActivityFeed run={run} pending={pending}/> : run ? <div className="work-results"><AgentLabEvidence run={run}/></div> : <div className="work-panel-empty"><Check size={21}/><p>Verified results appear here.</p></div>}
        </div>
      </aside>
    </div>
    <form className="work-composer" onSubmit={submit}>
      <label htmlFor="run-prompt" className="sr-only">Run prompt</label>
      <textarea ref={promptInput} id="run-prompt" placeholder="Ask Antibody to test your agents…" value={prompt} maxLength={2000} rows={1} disabled={running || pending || !!busy} onChange={event => setPrompt(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }}/>
      {active && active.id !== id ? <button type="button" className="work-submit" title="View active run" onClick={() => props.onSelect(active.id)}><ArrowUpRight size={17}/><span className="sr-only">View active run</span></button> : <button type="submit" className="work-submit" title={pending || busy === 'start' ? 'Starting…' : running ? 'Running' : 'Start run'} disabled={prompt.trim().length < 5 || running || pending || !!busy || props.ready === false || connections?.ready === false}>{pending || busy === 'start' ? <Loader2 size={17} className="spin"/> : <ArrowUp size={18}/>}<span className="sr-only">{pending || busy === 'start' ? 'Starting…' : running ? 'Running' : 'Start run'}</span></button>}
    </form>
    <div className="work-composer-hint">{!prompt && !running && !pending ? <button type="button" onClick={() => { setPrompt('Find and fix unauthorized actions in the demo agents.'); promptInput.current?.focus(); }}>Try an example<ArrowUpRight size={11}/></button> : <span>{running ? 'Agents are running in Daytona.' : 'Engineering · Purchasing · Support'}</span>}<span>Enter to run · Shift+Enter for a new line</span></div>
    <div className="work-connections" aria-label="Connections"><div>{checking && !connections ? <span><Loader2 size={11} className="spin"/>Checking connections…</span> : connectionError ? <span className="work-danger">{connectionError}</span> : connections?.connections.map(connection => <details key={connection.id} className={`work-connection ${connection.state}`}><summary><i/>{connection.name}<span>{connection.state === 'connected' ? 'Connected' : connection.state === 'authenticated' ? 'Signed in' : connection.state === 'configured' ? 'Configured' : connection.state === 'missing' ? 'Not configured' : 'Unavailable'}</span></summary><div>{connection.detail}<small>Checked {new Date(connections.checkedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</small></div></details>)}</div><button type="button" aria-label="Check connections" disabled={checking} onClick={() => setCheckCount(value => value + 1)}><RotateCcw size={12} className={checking ? 'spin' : ''}/></button></div>
  </div>;
}

function SandboxScreen({ run, pending, loadFailed, onRetry }: { run: LabRun | null; pending: boolean; loadFailed: boolean; onRetry: () => void }) {
  const [resources, setResources] = useState<LabSandboxList | null>(null);
  const [selected, setSelected] = useState('all');
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [mode, setMode] = useState<'live' | 'recording'>('live');
  const [expanded, setExpanded] = useState<string | null>(null);
  const statusRequest = useRef(0);
  const roleResources = resources?.sandboxes.filter(item => item.key === 'blue' || item.key === 'red') ?? [];
  useEffect(() => {
    if (!expanded) return;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = overflow; };
  }, [expanded]);
  useEffect(() => {
    if (!run) return;
    let cancelled = false;
    const load = async () => {
      const revision = ++statusRequest.current;
      try { const result = await workspaceApi<LabSandboxList>(`/api/agent-lab/runs/${run.id}/sandboxes`); if (!cancelled && revision === statusRequest.current) {
        setResources(current => {
          // Keep insertion order and component identity stable: moving an iframe
          // in the DOM can reconnect its browser even when React keys survive.
          const incoming = result.sandboxes.filter((item, index, all) => all.findIndex(other => other.id === item.id) === index);
          const previous = current?.sandboxes ?? [];
          return { ...result, sandboxes: [...previous.map(item => incoming.find(next => next.id === item.id) ?? { ...item, state: 'unavailable', canOpen: false, canResume: false, detail: 'This sandbox is no longer listed in the current run.' }), ...incoming.filter(item => !previous.some(old => old.id === item.id))] };
        });
        setError(result.error ?? '');
      } }
      catch (error) { if (!cancelled && revision === statusRequest.current) setError((error as Error).message); }
    };
    void load(); const timer = setInterval(() => void load(), 10_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [run?.id, run?.status, refresh]);
  function select(key: string) { setSelected(key); setExpanded(null); setMode('live'); }
  return <section className="work-sandbox" aria-label="Daytona sandboxes">
    <div className="work-panel-bar"><h2><Monitor size={15}/>Sandboxes</h2><div>{run?.status === 'completed' && run.videoPath && <button className="work-recording-button" aria-pressed={mode === 'recording'} onClick={() => { setExpanded(null); setMode(current => current === 'recording' ? 'live' : 'recording'); }}><Play size={12}/>{mode === 'recording' ? 'Back to live' : 'Recording'}</button>}<button className="work-icon-button" aria-label="Refresh sandbox status" onClick={() => setRefresh(value => value + 1)}><RotateCcw size={13}/></button></div></div>
    {!!resources?.sandboxes.length && <div className="work-sandbox-tabs" aria-label="Sandbox list">{resources.sandboxes.length > 1 && <button aria-pressed={selected === 'all' && mode === 'live'} onClick={() => select('all')}><Monitor size={13}/>All sandboxes</button>}{resources.sandboxes.map(resource => <button key={resource.id} aria-pressed={(selected === resource.key || selected === 'all' && resources.sandboxes.length === 1) && mode === 'live'} onClick={() => select(resource.key)} title={resource.id}><Server size={13}/><span>{resource.key === 'desktop' && roleResources.length ? 'Target' : resource.title}</span><small className={`sandbox-state state-${resource.state}`}><i/>{resource.state === 'started' ? 'Live' : resource.state === 'deleted' ? 'Deleted' : resource.state}</small></button>)}</div>}
    {error && resources && <div className="work-error" role="alert"><span>Sandbox status could not refresh: {error}</span><button aria-label="Retry sandbox status" onClick={() => setRefresh(value => value + 1)}><RotateCcw size={13}/></button></div>}
    <div className={`work-sandbox-grid${mode === 'recording' || !resources?.sandboxes.length ? ' work-pane-hidden' : ''}`} aria-label="Live Daytona sandbox previews" aria-hidden={mode === 'recording' || !resources?.sandboxes.length || undefined}>{run && resources?.sandboxes.map(resource => <SandboxViewport key={`${run.id}/${resource.id}`} resource={resource} run={run} onRefresh={() => setRefresh(value => value + 1)} hidden={selected !== 'all' && selected !== resource.key} expanded={expanded === resource.id} onExpand={() => setExpanded(resource.id)} onCollapse={() => setExpanded(null)}/>)}</div>
    {mode === 'recording' && run && <><div className="work-screen"><video controls autoPlay playsInline src={`/api/agent-lab/runs/${run.id}/video`} aria-label="Actual Daytona sandbox recording"/></div><div className="work-screen-footer">Recorded during the real Daytona run</div></>}
    {!resources?.sandboxes.length && mode === 'live' && <div className="work-screen"><div className="work-screen-empty"><span className="work-screen-icon">{pending ? <Loader2 className="spin" size={26} strokeWidth={1.4}/> : <Monitor size={27} strokeWidth={1.3}/>}</span><h3>{loadFailed ? 'Run unavailable' : pending ? 'Preparing the sandboxes…' : error ? 'Couldn’t load the sandboxes.' : run ? resources ? 'No sandboxes were created.' : 'Checking the sandboxes…' : 'Your sandboxes open here.'}</h3><p>{error || (loadFailed ? 'Reconnect to load this run.' : pending ? 'Each real Daytona sandbox appears as it is created.' : !run ? 'Describe what to test below, then start a run.' : 'Watch the recorded run or check its current status.')}</p>{(loadFailed || error) && <button className="work-button" onClick={() => { onRetry(); setRefresh(value => value + 1); }}>Try again</button>}</div></div>}
  </section>;
}

function SandboxViewport({ run, resource, onRefresh, hidden, expanded, onExpand, onCollapse }: { run: LabRun; resource: LabSandbox; onRefresh: () => void; hidden: boolean; expanded: boolean; onExpand: () => void; onCollapse: () => void }) {
  const [preview, setPreview] = useState<LabPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const request = useRef(0);
  const opening = useRef(false);
  const container = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const title = resource.key === 'blue' ? 'Blue' : resource.key === 'red' ? 'Red' : resource.key === 'desktop' ? 'Target' : resource.title;
  useEffect(() => {
    const dialog = container.current;
    if (!expanded || !dialog) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButton.current?.focus();
    const keepFocus = (event: FocusEvent) => { if (event.target instanceof Node && !dialog.contains(event.target)) closeButton.current?.focus(); };
    const keyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onCollapse(); return; }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>('a[href],button:not(:disabled),iframe,[tabindex="0"]')).filter(element => element.getClientRects().length > 0 && element.tabIndex >= 0);
      const first = focusable[0], last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    // Switching to an Example hides this workspace without disconnecting it.
    // Collapse its overlay and release the body scroll lock at the same time.
    const visibility = new MutationObserver(() => { if (dialog.closest('[hidden]')) onCollapse(); });
    for (let ancestor = dialog.parentElement; ancestor; ancestor = ancestor.parentElement) visibility.observe(ancestor, { attributes: true, attributeFilter: ['hidden'] });
    document.addEventListener('focusin', keepFocus, true);
    document.addEventListener('keydown', keyDown, true);
    return () => {
      visibility.disconnect();
      document.removeEventListener('focusin', keepFocus, true);
      document.removeEventListener('keydown', keyDown, true);
      if (previous?.isConnected && previous.getClientRects().length && !previous.closest('[hidden]')) previous.focus();
    };
  }, [expanded]);
  useEffect(() => () => { request.current++; }, []);
  useEffect(() => {
    if (!resource.canOpen) {
      // A failed metadata probe does not prove an established viewer disconnected.
      // Only a confirmed stop/delete clears the frame; an explicit Resume can
      // return its fresh preview before metadata has caught up.
      if (['stopped', 'archived', 'deleted', 'destroyed', 'error'].includes(resource.state)) { request.current++; opening.current = false; setPreview(null); setLoading(false); }
      return;
    }
    // Defer initial auto-open by one tick so Strict Mode's setup/cleanup cycle
    // does not issue two signed-preview requests for the same mounted viewer.
    const timer = setTimeout(() => { if (!preview && !opening.current) void open(false); }, 0);
    return () => clearTimeout(timer);
  }, [resource.id, resource.canOpen, resource.state]);
  useEffect(() => {
    if (!preview) return;
    const timer = setTimeout(() => { request.current++; setPreview(null); setError('This preview link expired. Reconnect to get a fresh link.'); }, Math.max(1, preview.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [preview]);
  async function open(resume: boolean) {
    if (opening.current) return;
    opening.current = true;
    const revision = ++request.current; setLoading(true); setError('');
    try { const result = await workspaceApi<LabPreview>(`/api/agent-lab/runs/${run.id}/sandboxes/${resource.key}/preview`, { method: 'POST', body: JSON.stringify({ resume }) }); if (request.current === revision) { setPreview(result); if (resume) onRefresh(); } }
    catch (error) { if (request.current === revision) setError((error as Error).message); }
    finally { if (request.current === revision) { opening.current = false; setLoading(false); } }
  }
  return <div ref={container} className={`work-role-sandbox role-${resource.key}${hidden ? ' work-pane-hidden' : ''}${expanded ? ' is-expanded' : ''}`} data-sandbox-id={resource.id} aria-hidden={hidden || undefined} role={expanded ? 'dialog' : undefined} aria-modal={expanded || undefined} aria-label={expanded ? `${title} sandbox` : undefined}>
    <div className="work-role-heading"><strong>{title}</strong><small className={`sandbox-state state-${resource.state}`}><i/>{resource.state === 'started' ? 'Live' : resource.state}</small><div className="work-role-actions">{preview && <a className="work-icon-button" href={preview.url} target="_blank" rel="noreferrer" aria-label={`Open ${title} sandbox in a new tab`}><ExternalLink size={13}/></a>}<button ref={closeButton} type="button" className="work-icon-button" aria-label={expanded ? `Collapse ${title} sandbox` : `Expand ${title} sandbox`} onClick={expanded ? onCollapse : onExpand}>{expanded ? <X size={15}/> : <Maximize2 size={13}/>}</button></div></div>
    <div className="work-screen">{preview ? <><iframe src={preview.url} title={resource.role === 'blue' || resource.role === 'red' ? `Actual Daytona ${title} sandbox` : `Actual Daytona ${preview.kind === 'desktop' ? 'desktop' : 'application'} sandbox`} allow="fullscreen; clipboard-read; clipboard-write" referrerPolicy="no-referrer" tabIndex={expanded ? 0 : -1}/><button type="button" className="work-preview-expand" hidden={expanded} aria-hidden={expanded || undefined} tabIndex={expanded ? -1 : 0} aria-label={`Expand ${title} preview`} onClick={onExpand}><span><Maximize2 size={14}/>Expand</span></button></> : <div className="work-screen-empty"><span className="work-screen-icon">{loading ? <Loader2 className="spin" size={26} strokeWidth={1.4}/> : <Monitor size={27} strokeWidth={1.3}/>}</span><h3>{loading ? `Opening ${title}…` : resource.canResume ? 'This sandbox is paused.' : resource.state === 'deleted' ? 'This sandbox was deleted.' : resource.canOpen ? 'Open the sandbox.' : 'Sandbox unavailable'}</h3><p>{error || resource.detail || (loading ? 'Connecting to the actual Daytona desktop.' : resource.canResume ? 'Resume its preserved environment to see the live desktop.' : 'Its saved test evidence remains available in Results.')}</p>{(resource.canOpen || resource.canResume) && <button className="work-button work-button-dark" disabled={loading} onClick={() => void open(resource.canResume)}>{loading ? <Loader2 size={14} className="spin"/> : <Play size={13}/>} {resource.canResume ? 'Resume sandbox' : error ? 'Reconnect' : 'Open sandbox'}</button>}</div>}</div>
    <div className="work-screen-footer"><span>{preview?.note ?? (preview ? resource.canOpen ? 'Live Daytona sandbox · view only' : 'Viewer kept open · status check unavailable' : 'Daytona')}</span><code title={resource.id}>{resource.id}</code></div>
  </div>;
}

function ActivityFeed({ run, pending }: { run: LabRun | null; pending: boolean }) {
  const list = useRef<HTMLOListElement>(null), follow = useRef(true);
  useEffect(() => { if (list.current && follow.current) list.current.scrollTop = list.current.scrollHeight; }, [run?.events.length]);
  if (!run?.events.length) return <div className="work-panel-empty"><span className="work-agent-symbol">A</span><h3>{pending ? 'Starting the team' : 'Follow the agents'}</h3><p>{pending ? 'Waiting for the controller’s first event…' : 'Sandbox launches, Red’s findings, Blue’s repairs, and verification appear here.'}</p></div>;
  return <ol className="work-feed" ref={list} onScroll={event => { const node = event.currentTarget; follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 60; }} aria-label="Recorded agent events">{run.events.map((event, index) => {
    const role = /^Daytona\b/.test(event.message) ? 'Daytona' : /^Anchor: connected/.test(event.message) ? 'Anchor' : panelReceives('blue', event.message) && /^Blue\b/.test(event.message) ? 'Blue' : panelReceives('red', event.message) && /^(Red\b|Anchor is testing)/.test(event.message) ? 'Red' : panelReceives('verifier', event.message) ? 'Verifier' : 'Controller';
    return <li key={`${event.at}-${index}`} className={`role-${role.toLowerCase()}`}><div className="work-event-meta"><strong>{role}</strong>{event.candidateId && <span>{event.candidateId.toUpperCase()}</span>}<time>{new Date(event.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time></div><p>{event.message}</p></li>;
  })}</ol>;
}
