import { useEffect, useRef, useState } from 'react';
import type { LabRun, LabRunSummary } from '@antibody/shared/agent-lab';
import RunWorkspace, { workspaceApi as api } from './RunWorkspace';
import './agent-lab.css';
export { AgentLabEvidence } from './AgentLabEvidence';

export default function AgentLab() {
  const selectionChanged = useRef(false);
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
      setId(current => selectionChanged.current ? current : current || history.find(item => item.status === 'running')?.id || history.find(item => item.status === 'completed')?.id || history[0]?.id || '');
    }).catch(error => { if (!cancelled) { setError(error.message); setLoaded(true); } });
    return () => { cancelled = true; };
  }, [refresh]);

  useEffect(() => {
    if (!id) { const url = new URL(window.location.href); url.searchParams.delete('agentRun'); window.history.replaceState(null, '', url); return; }
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

  async function start(prompt: string) {
    if (busy || pending) return;
    const active = runs.find(item => item.status === 'running');
    if (active) { setId(active.id); return; }
    setBusy('start'); setError('');
    try {
      const created = await api<{ id: string }>('/api/agent-lab/runs', { method: 'POST', body: JSON.stringify({ suite: 'cross-domain', prompt }) });
      setRun(null); setPending(true); setId(created.id); setRefresh(value => value + 1);
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

  return <RunWorkspace run={run} runs={runs} id={id} loaded={loaded} pending={pending} ready={ready} busy={busy} error={error} runLoadFailed={runLoadFailed}
    onSelect={next => { selectionChanged.current = true; setPending(false); setError(''); setRunLoadFailed(false); setId(next); if (!next) setRun(null); }}
    onStart={value => void start(value)} onStop={() => void stop()} onRetry={() => setRefresh(value => value + 1)}/>;
}
