import { useEffect, useState } from 'react';
import type { ApprovalChannel, EvolutionRun } from '@hollow-purple/shared/evolution';
import { Check, FlaskConical, LockKeyhole, PackageCheck, PhoneCall, ShieldCheck, TrendingUp, X } from 'lucide-react';

async function post<T>(path: string, body: unknown = {}): Promise<T> {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((data as { error?: string }).error || `Request failed (${response.status})`);
  return data as T;
}
const time = (value: number) => new Date(value).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
const short = (hash: string) => hash.slice(0, 12);

type StepState = 'done' | 'active' | 'blocked' | 'idle';

/** A verified champion is released only after a human says yes: by phone (ElevenLabs) or here. */
export function ReleaseGate({ run, channel, readOnly, onRun, onError }: { run: EvolutionRun; channel?: ApprovalChannel; readOnly: boolean; onRun: (run: EvolutionRun) => void; onError: (message: string) => void }) {
  const [busy, setBusy] = useState(false);
  const champion = run.candidates.find(c => c.id === run.championId);
  const approval = run.approval;
  const waitingOnPhone = approval?.status === 'requested' && approval.channel === 'phone';

  // A phone decision arrives through the voice agent's webhook: poll until it lands.
  useEffect(() => {
    if (!waitingOnPhone) return;
    const timer = window.setInterval(() => { void fetch(`/api/runs/${run.id}`).then(r => r.json()).then(onRun).catch(() => {}); }, 1500);
    return () => clearInterval(timer);
  }, [waitingOnPhone, run.id, onRun]);

  async function act(path: string, body?: unknown) {
    setBusy(true);
    try { onRun(await post<EvolutionRun>(path, body)); } catch (e) { onError(e instanceof Error ? e.message : 'The release gate request failed.'); } finally { setBusy(false); }
  }

  const championState: StepState = champion ? 'done' : run.status === 'completed' || run.status === 'failed' || run.status === 'stopped' ? 'blocked' : 'active';
  const approvalState: StepState = !approval ? 'idle' : approval.status === 'approved' ? 'done' : approval.status === 'requested' ? 'active' : 'blocked';
  const releaseState: StepState = run.release ? 'done' : approvalState === 'blocked' || championState === 'blocked' ? 'blocked' : 'idle';
  const canRequest = !readOnly && run.status === 'completed' && !!champion && !approval && !run.release;
  const dashboardDecision = !readOnly && approval?.status === 'requested' && approval.channel === 'dashboard';

  return <section className="panel release-panel" data-testid="release-gate">
    <div className="panel-heading"><div className="panel-title"><PackageCheck size={16}/><h2>Release gate</h2><span className="panel-meta">Nothing ships without a verified champion and a human yes</span></div>
      {canRequest && <button className="button primary" disabled={busy} onClick={() => void act(`/api/runs/${run.id}/approval/request`)}><PhoneCall size={13}/>{(channel ?? 'dashboard') === 'phone' ? 'Call the approver' : 'Request approval'}</button>}
    </div>
    <ol className="release-steps">
      <Step state={championState} icon={<ShieldCheck size={15}/>} title="Verified champion">
        {champion ? <>{champion.label} · passed {champion.checks.filter(c => c.passed).length}/{champion.checks.length} checks and {run.regressions.length} regression tests</>
          : championState === 'blocked' ? 'No design passed every gate in this run.' : 'Waiting for a design that passes every gate.'}
      </Step>
      <Step state={approvalState} icon={<PhoneCall size={15}/>} title="Human approval">
        {!approval ? (champion ? 'Not requested yet.' : 'Requested once a champion exists.')
          : approval.status === 'requested' ? (approval.channel === 'phone' ? <>Calling the approver{approval.conversationId ? <> · <span className="mono-inline">{approval.conversationId.slice(0, 14)}</span></> : null}. The decision comes from the call.</> : 'Waiting for your decision.')
          : approval.status === 'approved' ? <>Approved by {approval.channel === 'phone' ? 'phone' : 'dashboard'} at {time(approval.decidedAt ?? approval.requestedAt)}.</>
          : approval.status === 'declined' ? 'Declined. Nothing was released.'
          : <>The call failed{approval.detail ? ` (${approval.detail})` : ''}. Nothing was released.</>}
        {dashboardDecision && <div className="release-actions"><button className="button primary" disabled={busy} onClick={() => void act(`/api/runs/${run.id}/approval`, { decision: 'approve' })}><Check size={13}/>Approve release</button><button className="button stop" disabled={busy} onClick={() => void act(`/api/runs/${run.id}/approval`, { decision: 'decline' })}><X size={13}/>Decline</button></div>}
      </Step>
      <Step state={releaseState} icon={run.release ? <PackageCheck size={15}/> : <LockKeyhole size={15}/>} title="Released design">
        {run.release ? <>Source <span className="mono-inline">{short(run.release.sourceHash)}</span> · contract <span className="mono-inline">{short(run.release.contractHash)}</span> · bundle <span className="mono-inline">{run.release.bundlePath}</span></>
          : releaseState === 'blocked' ? 'Locked for this run.' : 'Locked until approval.'}
      </Step>
    </ol>
  </section>;
}

function Step({ state, icon, title, children }: { state: StepState; icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return <li className={`release-step ${state}`}><span className="release-icon">{state === 'done' ? <Check size={14}/> : state === 'blocked' ? <X size={14}/> : icon}</span><div><strong>{title}</strong><div className="release-detail">{children}</div></div></li>;
}

/** The controlled comparison: the same model's single-shot designs against the design that survived Red. */
export function BaselineComparison({ run }: { run: EvolutionRun }) {
  const first = run.candidates.filter(c => c.generation === 0);
  if (!first.length) return null;
  const champion = run.candidates.find(c => c.id === run.championId);
  const evolved = champion ?? [...run.candidates].sort((a, b) => b.score - a.score)[0]!;
  const bestFirst = Math.max(...first.map(c => c.score));
  const acceptedFirst = first.filter(c => c.status === 'verified').length;
  const rows = [
    { label: 'Single-shot designs', detail: `generation 0 · ${first.length} designs · ${acceptedFirst} accepted`, score: bestFirst, tone: 'red' },
    { label: champion ? 'Evolved champion' : 'Best design so far', detail: `generation ${evolved.generation} · ${run.regressions.length} regression tests inherited`, score: evolved.score, tone: 'purple' },
  ];
  return <section className="panel compare-panel" data-testid="baseline-comparison">
    <div className="panel-heading"><div className="panel-title"><TrendingUp size={16}/><h2>Single-shot vs evolved</h2><span className="panel-meta">Same model, same frozen contract</span></div></div>
    <div className="compare-body">
      {rows.map(row => <div className="compare-row" key={row.label}>
        <div className="compare-head"><span><span className={`tiny-dot ${row.tone}`}/>{row.label}</span><b>{Math.round(row.score)}%</b></div>
        <div className="compare-track"><div className={`compare-fill ${row.tone}`} style={{ width: `${Math.max(2, row.score)}%` }}/></div>
        <small>{row.detail}</small>
      </div>)}
      <p className="compare-note"><FlaskConical size={12}/>Best share of checks passed. Only the verifier's checks count; no model grades itself.</p>
    </div>
  </section>;
}
