import { useEffect, useMemo, useRef, useState } from 'react';
import type { Candidate, EvolutionRun } from '@antibody/shared/evolution';
import { activeWork, buildTranscript, type Speaker, type TranscriptLine } from '@antibody/shared/transcript';
import { ArrowDownToLine, Check, Terminal, Users, X } from 'lucide-react';

const SPEAKER_LABEL: Record<Speaker, string> = { blue: 'BLUE', red: 'RED', daytona: 'DAYTONA', verifier: 'VERIFIER', memory: 'MEMORY', human: 'HUMAN', anchor: 'ANCHOR', system: 'LAB' };
const FILTERS: { id: 'all' | Speaker; label: string }[] = [
  { id: 'all', label: 'All' }, { id: 'blue', label: 'Blue' }, { id: 'red', label: 'Red' }, { id: 'daytona', label: 'Daytona' },
  { id: 'verifier', label: 'Verifier' }, { id: 'memory', label: 'Memory' }, { id: 'human', label: 'Human' },
];
const clock = (ts: number) => new Date(ts).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
const elapsed = (ms: number) => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`; };
const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/**
 * Everything Blue and Red said, what ran in Daytona, and what the verifier decided, as a live terminal.
 * Built from the run's event log with the same transcript builder the MCP server uses.
 */
export function AgentConsole({ run, selectedId, onSelect }: { run: EvolutionRun; selectedId?: string; onSelect: (id: string) => void }) {
  const [focus, setFocus] = useState<string>('all');
  const [speaker, setSpeaker] = useState<'all' | Speaker>('all');
  const [following, setFollowing] = useState(true);
  const [now, setNow] = useState(Date.now());
  const transcript = useMemo(() => buildTranscript(run), [run.id, run.events.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const working = activeWork(run);
  const lines = transcript.filter(line => (focus === 'all' || line.candidateId === focus) && (speaker === 'all' || line.speaker === speaker));
  const screen = useRef<HTMLDivElement>(null);
  const seenAtMount = useRef<number>(transcript.length ? transcript[transcript.length - 1]!.seq : 0);

  // Follow the live edge unless the reader scrolled up.
  useEffect(() => { if (following && screen.current) screen.current.scrollTop = screen.current.scrollHeight; }, [lines.length, following, working?.text]);
  useEffect(() => { if (!working) return; const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [working?.text]);
  // Open on every agent; afterwards, follow a design the user picks elsewhere (the lineage graph).
  const initialSelection = useRef(selectedId);
  useEffect(() => {
    if (selectedId === initialSelection.current) return;
    initialSelection.current = selectedId;
    if (selectedId && run.candidates.some(c => c.id === selectedId)) setFocus(selectedId);
  }, [selectedId, run.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const onScroll = () => { const el = screen.current; if (el) setFollowing(el.scrollHeight - el.scrollTop - el.clientHeight < 40); };
  const live = run.status === 'running' || run.status === 'queued';
  const latestAgentLine = [...lines].reverse().find(line => line.speaker === 'blue' || line.speaker === 'red');

  return <div className="console-layout" data-testid="agent-console">
    <section className="panel console-roster">
      <div className="panel-heading"><div className="panel-title"><Users size={15}/><h2>Agents</h2><span className="panel-meta">{run.candidates.length} designs</span></div></div>
      <div className="roster-list">
        <button className={`roster-item ${focus === 'all' ? 'active' : ''}`} onClick={() => setFocus('all')}><span className="roster-id">ALL</span><span className="roster-name">Every agent, in order</span><span className="roster-count">{transcript.length}</span></button>
        {run.candidates.map(c => <RosterItem key={c.id} candidate={c} champion={c.id === run.championId} active={focus === c.id} working={working?.candidateId === c.id ? working.speaker : undefined} onClick={() => { setFocus(c.id); onSelect(c.id); }}/>)}
      </div>
      <p className="roster-note">Recorded outputs: each agent's rationale, hypotheses and attacks. Models' private reasoning is never stored.</p>
    </section>

    <section className="panel console-panel">
      <div className="panel-heading">
        <div className="panel-title"><Terminal size={15}/><h2>Agent console</h2><span className="panel-meta">{focus === 'all' ? 'Blue, Red and the verifier, as it happened' : `Design ${focus}`}</span></div>
        <span className={`console-status ${live ? 'live' : ''}`}><span className={`tiny-dot ${live ? 'red' : 'green'}`}/>{live ? 'LIVE' : run.status.toUpperCase()}</span>
      </div>
      <div className="console-filters" role="group" aria-label="Filter by speaker">
        {FILTERS.map(f => <button key={f.id} className={`console-chip ${f.id} ${speaker === f.id ? 'active' : ''}`} aria-pressed={speaker === f.id} onClick={() => setSpeaker(f.id)}>{f.label}</button>)}
      </div>
      <div className="console-screen" ref={screen} onScroll={onScroll} aria-live="polite">
        <div className="console-scanline" aria-hidden="true"/>
        {lines.length === 0 && <div className="console-empty">No activity for this filter yet.</div>}
        {lines.map(line => <Line key={line.id} line={line} animate={line.seq > seenAtMount.current} type={line === latestAgentLine && line.seq > seenAtMount.current} onFocus={id => setFocus(id)}/>)}
        {working && (focus === 'all' || focus === working.candidateId) && (speaker === 'all' || speaker === working.speaker) && <div className={`console-line thinking ${working.speaker}`}>
          <span className="console-time">{clock(now)}</span><span className="console-who">{SPEAKER_LABEL[working.speaker]}</span><span className="console-cand">{working.candidateId}</span>
          <div className="console-text">{working.text}<span className="console-dots"><span>.</span><span>.</span><span>.</span></span><span className="console-elapsed">{elapsed(now - working.since)}</span><span className="console-cursor">▍</span></div>
        </div>}
      </div>
      {!following && <button className="console-jump" onClick={() => setFollowing(true)}><ArrowDownToLine size={12}/>Jump to live</button>}
    </section>
  </div>;
}

function RosterItem({ candidate: c, champion, active, working, onClick }: { candidate: Candidate; champion: boolean; active: boolean; working?: Speaker; onClick: () => void }) {
  const verdict = c.status === 'verified' ? (champion ? 'champion' : 'verified') : c.status === 'failed' || c.status === 'rejected' ? c.status : 'running';
  const imported = !c.agent && !!c.source;
  return <button className={`roster-item ${active ? 'active' : ''}`} onClick={onClick}>
    <span className="roster-id">{c.id}</span>
    <span className="roster-name">{c.label}<small>{imported ? 'imported, not written by Blue' : c.parentId ? `repair of ${c.parentId}` : `generation ${c.generation}`}</small></span>
    <span className="roster-agents">
      <span className={`agent-pip blue ${imported ? 'imported' : c.agent ? 'done' : working === 'blue' ? 'busy' : ''}`} title={imported ? 'Imported source: no Blue model call' : c.agent ? 'Blue answered' : 'Blue pending'}>B</span>
      <span className={`agent-pip red ${c.attacks?.length ? 'done' : working === 'red' ? 'busy' : ''}`} title={c.attacks?.length ? `Red authored ${c.attacks.length} attacks` : 'Red pending'}>R</span>
    </span>
    <span className={`roster-verdict ${verdict}`}>{verdict === 'champion' || verdict === 'verified' ? <Check size={11}/> : verdict === 'failed' || verdict === 'rejected' ? <X size={11}/> : null}{verdict}</span>
  </button>;
}

function Line({ line, animate, type, onFocus }: { line: TranscriptLine; animate: boolean; type: boolean; onFocus: (id: string) => void }) {
  const text = useTypewriter(line.text, type);
  return <div className={`console-line ${line.speaker} ${line.tone ?? ''} ${animate ? 'enter' : ''}`}>
    <span className="console-time">{clock(line.ts)}</span>
    <span className="console-who">{SPEAKER_LABEL[line.speaker]}</span>
    {line.candidateId ? <button className="console-cand" onClick={() => onFocus(line.candidateId!)} title={`Show only ${line.candidateId}`}>{line.candidateId}</button> : <span className="console-cand"/>}
    <div className="console-text">
      {line.tone === 'ok' && <span className="console-mark ok">✓ </span>}{line.tone === 'fail' && <span className="console-mark fail">✗ </span>}{text}{text.length < line.text.length && <span className="console-cursor">▍</span>}
      {line.meta && <div className="console-meta">{line.meta}</div>}
      {line.details && line.details.length > 0 && <ul className="console-details">{line.details.map((d, i) => <li key={i}>{d}</li>)}</ul>}
    </div>
  </div>;
}

/** Types out the newest agent line once; everything else renders instantly. */
function useTypewriter(text: string, active: boolean): string {
  const [shown, setShown] = useState(active && !reducedMotion() ? 0 : text.length);
  useEffect(() => {
    if (!active || reducedMotion()) { setShown(text.length); return; }
    let frame = 0; const start = performance.now();
    const tick = (t: number) => { const n = Math.min(text.length, Math.floor((t - start) * 0.09)); setShown(n); if (n < text.length) frame = requestAnimationFrame(tick); };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [text, active]);
  return text.slice(0, shown);
}
