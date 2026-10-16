import { useEffect, useRef, useState } from 'react';
import type { ApprovalChannel, EvolutionRun } from '@antibody/shared/evolution';
import { ConversationProvider, useConversation } from '@elevenlabs/react';
import { Check, FlaskConical, LockKeyhole, Mic, MicOff, PackageCheck, PhoneCall, ShieldCheck, TrendingUp, X } from 'lucide-react';

async function call<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((data as { error?: string }).error || `Request failed (${response.status})`);
  return data as T;
}
const time = (value: number) => new Date(value).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
const short = (hash: string) => hash.slice(0, 12);
const channelName: Record<ApprovalChannel, string> = { voice: 'voice', phone: 'phone', dashboard: 'dashboard' };

type StepState = 'done' | 'active' | 'blocked' | 'idle';

/** A verified champion is released only after a human says yes: by voice (ElevenLabs), by phone, or here. */
export function ReleaseGate({ run, channel, channels, readOnly, onRun, onError }: { run: EvolutionRun; channel?: ApprovalChannel; channels?: ApprovalChannel[]; readOnly: boolean; onRun: (run: EvolutionRun) => void; onError: (message: string) => void }) {
  const [busy, setBusy] = useState(false);
  const champion = run.candidates.find(c => c.id === run.championId);
  const approval = run.approval;
  const waitingOnPhone = approval?.status === 'requested' && approval.channel === 'phone';
  const preferred = channel ?? 'dashboard';

  // A phone decision arrives through the voice agent's webhook: poll until it lands.
  useEffect(() => {
    if (!waitingOnPhone) return;
    const timer = window.setInterval(() => { void call<EvolutionRun>(`/api/runs/${run.id}`).then(onRun).catch(() => {}); }, 1500);
    return () => clearInterval(timer);
  }, [waitingOnPhone, run.id, onRun]);

  async function act(path: string, body: unknown = {}) {
    setBusy(true);
    try { onRun(await call<EvolutionRun>(path, body)); } catch (e) { onError(e instanceof Error ? e.message : 'The release gate request failed.'); } finally { setBusy(false); }
  }
  const request = (requested: ApprovalChannel) => act(`/api/runs/${run.id}/approval/request`, { channel: requested });

  const championState: StepState = champion ? 'done' : run.status === 'completed' || run.status === 'failed' || run.status === 'stopped' ? 'blocked' : 'active';
  const approvalState: StepState = !approval ? 'idle' : approval.status === 'approved' ? 'done' : approval.status === 'requested' ? 'active' : 'blocked';
  const releaseState: StepState = run.release ? 'done' : approvalState === 'blocked' || championState === 'blocked' ? 'blocked' : 'idle';
  const canRequest = !readOnly && run.status === 'completed' && !!champion && !approval && !run.release;
  const pendingOn = approval?.status === 'requested' ? approval.channel : undefined;

  return <section className="panel release-panel" data-testid="release-gate">
    <div className="panel-heading"><div className="panel-title"><PackageCheck size={16}/><h2>Release gate</h2><span className="panel-meta">Nothing ships without a verified champion and a human yes</span></div>
      {canRequest && <div className="release-request">
        {preferred !== 'dashboard' && <button className="button subtle" disabled={busy} onClick={() => void request('dashboard')}>Use dashboard</button>}
        <button className="button primary" disabled={busy} onClick={() => void request(preferred)}>{preferred === 'voice' ? <Mic size={13}/> : <PhoneCall size={13}/>}{preferred === 'voice' ? 'Approve by voice' : preferred === 'phone' ? 'Call the approver' : 'Request approval'}</button>
      </div>}
    </div>
    <ol className="release-steps">
      <Step state={championState} icon={<ShieldCheck size={15}/>} title="Verified champion">
        {champion ? <>{champion.label} · passed {champion.checks.filter(c => c.passed).length}/{champion.checks.length} checks and {run.regressions.length} regression tests</>
          : championState === 'blocked' ? 'No design passed every gate in this run.' : 'Waiting for a design that passes every gate.'}
      </Step>
      <Step state={approvalState} icon={<Mic size={15}/>} title="Human approval">
        {!approval ? (champion ? `Not requested yet${channels?.includes('voice') ? ' · the ElevenLabs release agent is ready' : ''}.` : 'Requested once a champion exists.')
          : approval.status === 'requested' ? (approval.channel === 'phone' ? <>Calling the approver{approval.conversationId ? <> · <span className="mono-inline">{approval.conversationId.slice(0, 14)}</span></> : null}. The decision comes from the call.</>
            : approval.channel === 'voice' ? 'Talk to the release agent. It reads the summary and records your yes or no.' : 'Waiting for your decision.')
          : approval.status === 'approved' ? <>Approved by {channelName[approval.channel]} at {time(approval.decidedAt ?? approval.requestedAt)}{approval.conversationId ? <> · conversation <span className="mono-inline">{approval.conversationId.slice(0, 16)}</span></> : null}.</>
          : approval.status === 'declined' ? <>Declined by {channelName[approval.channel]}. Nothing was released.</>
          : <>The call failed{approval.detail ? ` (${approval.detail})` : ''}. Nothing was released.</>}
        {!readOnly && pendingOn === 'dashboard' && <div className="release-actions"><button className="button primary" disabled={busy} onClick={() => void act(`/api/runs/${run.id}/approval`, { decision: 'approve' })}><Check size={13}/>Approve release</button><button className="button stop" disabled={busy} onClick={() => void act(`/api/runs/${run.id}/approval`, { decision: 'decline' })}><X size={13}/>Decline</button></div>}
        {!readOnly && pendingOn === 'voice' && <ConversationProvider><VoiceApproval run={run} onRun={onRun} onError={onError}/></ConversationProvider>}
      </Step>
      <Step state={releaseState} icon={run.release ? <PackageCheck size={15}/> : <LockKeyhole size={15}/>} title="Released design">
        {run.release ? <>Source <span className="mono-inline">{short(run.release.sourceHash)}</span> · contract <span className="mono-inline">{short(run.release.contractHash)}</span> · bundle <span className="mono-inline">{run.release.bundlePath}</span></>
          : releaseState === 'blocked' ? 'Locked for this run.' : 'Locked until approval.'}
      </Step>
    </ol>
  </section>;
}

/**
 * The approver talks to the ElevenLabs release agent. The agent calls the `record_decision` client tool; the decision
 * is posted with the conversation id, and the controller confirms the conversation with ElevenLabs before releasing.
 */
function VoiceApproval({ run, onRun, onError }: { run: EvolutionRun; onRun: (run: EvolutionRun) => void; onError: (message: string) => void }) {
  const [phase, setPhase] = useState<'idle' | 'connecting' | 'live' | 'recording'>('idle');
  const [lines, setLines] = useState<{ who: 'Agent' | 'You'; text: string }[]>([]);
  const [code, setCode] = useState('');
  const conversationId = useRef('');
  const conversation = useConversation({
    onConnect: ({ conversationId: id }) => { conversationId.current = id; setPhase('live'); },
    onDisconnect: () => setPhase(p => (p === 'recording' ? p : 'idle')),
    onError: (message) => { onError(`Voice session: ${message}`); setPhase('idle'); },
    onMessage: ({ message, source }) => setLines(l => [...l.slice(-3), { who: source === 'ai' ? 'Agent' : 'You', text: message }]),
  });

  async function start() {
    setPhase('connecting'); setLines([]);
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true });
      const session = await call<{ signedUrl: string; summary: string; code: string }>(`/api/runs/${run.id}/voice-session`);
      setCode(session.code); // shown to the approver only; never sent to the agent
      conversation.startSession({
        signedUrl: session.signedUrl,
        connectionType: 'websocket',
        dynamicVariables: { summary: session.summary, run_id: run.id },
        clientTools: {
          record_decision: async ({ decision }: { decision?: string }) => {
            if (decision !== 'approve' && decision !== 'decline') return 'Ask again: the decision must be approve or decline.';
            setPhase('recording');
            const id = conversationId.current || conversation.getId();
            // End the call first so ElevenLabs holds the final transcript; the controller looks for the code in it.
            window.setTimeout(() => {
              conversation.endSession();
              void call<EvolutionRun>(`/api/runs/${run.id}/approval`, { decision, conversation_id: id })
                .then(onRun)
                .catch(e => onError(e instanceof Error ? e.message : 'The decision was not recorded.'))
                .finally(() => setPhase('idle'));
            }, 3500);
            return decision === 'approve' ? 'Thank you. The dashboard is checking the confirmation code before anything is released.' : 'Thank you. Recording that you declined. Nothing will be released.';
          },
        },
      });
    } catch (e) {
      setPhase('idle');
      onError(e instanceof Error ? (e.name === 'NotAllowedError' ? 'Microphone access is needed to approve by voice.' : e.message) : 'Could not start the voice session.');
    }
  }

  const live = phase === 'live' || phase === 'recording';
  return <div className="voice-approval">
    <div className="release-actions">
      {!live ? <button className="button primary" disabled={phase === 'connecting'} onClick={() => void start()}><Mic size={13}/>{phase === 'connecting' ? 'Connecting…' : 'Talk to the release agent'}</button>
        : <button className="button stop" onClick={() => conversation.endSession()}><MicOff size={13}/>End conversation</button>}
      {live && <span className="voice-status"><span className={`tiny-dot ${conversation.isSpeaking ? 'purple' : 'green'}`}/>{phase === 'recording' ? 'Checking the code with ElevenLabs…' : conversation.isSpeaking ? 'Agent speaking' : 'Listening'}</span>}
    </div>
    {code && phase !== 'idle' && <div className="voice-code"><span>To approve, say yes and read this code aloud</span><strong>{code.split('').join(' ')}</strong></div>}
    {lines.length > 0 && <ul className="voice-transcript">{lines.map((line, i) => <li key={i}><b>{line.who}</b>{line.text}</li>)}</ul>}
  </div>;
}

function Step({ state, icon, title, children }: { state: StepState; icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return <li className={`release-step ${state}`}><span className="release-icon">{state === 'done' ? <Check size={14}/> : state === 'blocked' ? <X size={14}/> : icon}</span><div><strong>{title}</strong><div className="release-detail">{children}</div></div></li>;
}

/** Descriptive comparison; an imported fixture is never attributed to a model. */
export function BaselineComparison({ run }: { run: EvolutionRun }) {
  const first = run.candidates.filter(c => c.generation === 0);
  if (!first.length) return null;
  const champion = run.candidates.find(c => c.id === run.championId);
  const evolved = champion ?? [...run.candidates].sort((a, b) => b.score - a.score)[0]!;
  const bestFirst = Math.max(...first.map(c => c.score));
  const acceptedFirst = first.filter(c => c.status === 'verified').length;
  const initialLabel = run.verificationFixture ? 'Imported starter' : first.every(c => c.agent) ? 'Initial model designs' : 'Archived designs';
  const rows = [
    { label: initialLabel, detail: run.verificationFixture ? 'generation 0 · manual fault fixture' : `generation 0 · ${first.length} designs · ${acceptedFirst} accepted`, score: bestFirst, tone: 'red' },
    { label: champion ? 'Selected design' : 'Best design so far', detail: `generation ${evolved.generation} · ${run.regressions.length} regression tests inherited · ${evolved.checks.filter(check => check.passed).length}/${evolved.checks.length} checks passed`, score: evolved.score, tone: 'purple' },
  ];
  return <section className="panel compare-panel" data-testid="baseline-comparison">
    <div className="panel-heading"><div className="panel-title"><TrendingUp size={16}/><h2>Initial vs selected design</h2><span className="panel-meta">Same frozen contract</span></div></div>
    <div className="compare-body">
      {rows.map(row => <div className="compare-row" key={row.label}>
        <div className="compare-head"><span><span className={`tiny-dot ${row.tone}`}/>{row.label}</span><b>{Math.round(row.score)}%</b></div>
        <div className="compare-track"><div className={`compare-fill ${row.tone}`} style={{ width: `${Math.max(2, row.score)}%` }}/></div>
        <small>{row.detail}</small>
      </div>)}
      <p className="compare-note"><FlaskConical size={12}/>Best share of each version's recorded checks passed. Suites can grow as regressions are added; this is a descriptive comparison.</p>
    </div>
  </section>;
}
