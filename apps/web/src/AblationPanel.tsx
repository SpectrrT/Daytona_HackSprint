import { useEffect, useState } from 'react';
interface Count { passed: number; evaluated: number }
interface Arm { mode: string; heldOut: Count; transfer: Count; missingTrials: number; completedTrials: number; acceptedDesigns: number; medianGenerationsUntilAllGates: number | null; censoredTrials: number }
interface Study { status: string; task?: string; runId?: string; model?: string; corpusHash?: string; plannedSeeds?: number; summary: Arm[]; graphTransfer?: { lessonsRetrieved: number; path: string[]; passed: boolean | null }[]; arize?: {status?: string}; failed?: boolean }
export function AblationPanel() {
  const [study, setStudy] = useState<Study | null>(null);
  useEffect(() => { let disposed = false; const update = () => fetch('/api/ablation/latest').then(r => r.json()).then(value => { if (!disposed) setStudy(value); }).catch(() => {}); void update(); const timer = setInterval(update, 10000); return () => { disposed = true; clearInterval(timer); }; }, []);
  const count = (v?: Count) => v?.evaluated ? `${v.passed}/${v.evaluated}` : 'Pending';
  const labels = [['none', 'A', 'Claude alone', 'Contract and current public failures'], ['flat', 'B', 'Raw retrieval', 'Similar past failures and counterexample traces'], ['graph', 'C', 'Antibody graph', 'Validated lessons through family ancestry']];
  const transferred = study?.graphTransfer?.some(t => t.lessonsRetrieved > 0 && t.path.includes('occupancy'));
  return <section className="ablation-panel" aria-label="Memory ablation evidence">
    <div className="ablation-heading"><div><small>CONTROLLED MEMORY EXPERIMENT</small><h2>Does the lesson graph help Claude?</h2></div><span>{study?.status && study.status !== 'missing' ? study.status.replaceAll('-', ' ') : 'Awaiting a real run'}</span></div>
    <p>Same Claude model, frozen FIFO contract, seed-paired tests and budgets. Only memory changes.</p>
    {study?.task && <p className="ablation-provenance">Task: {study.task === 'compound-repair-v1' ? 'Repair three planted defects in the same supplied FIFO. Separate from the earlier synthesis study.' : 'Design a FIFO from its frozen contract.'}</p>}
    <div className="ablation-arms">{labels.map(([mode, letter, title, description]) => { const arm = study?.summary.find(a => a.mode === mode); return <article key={mode} className={mode === 'graph' ? 'ablation-graph' : ''}><small>ARM {letter}</small><h3>{title}</h3><p>{description}</p><dl><dt>Hidden test passed</dt><dd>{count(arm?.heldOut)}</dd><dt>First-try unseen sibling</dt><dd>{count(arm?.transfer)}</dd><dt>Median generations to all gates</dt><dd>{arm?.medianGenerationsUntilAllGates ?? 'Pending'}</dd></dl>{!!arm?.missingTrials && <p>{arm.missingTrials} missing trials</p>}{!!arm?.censoredTrials && <p>{arm.censoredTrials} trials exhausted or stopped without all gates passing</p>}</article>; })}</div>
    <div className="ablation-transfer"><strong>{transferred ? 'Observed graph retrieval' : 'Planned transfer test'}: simultaneous → occupancy → empty boundary</strong><p>A lesson is eligible only after a real descendant passes every gate. Retrieval demonstrates reachability; a higher held-out score is required to demonstrate benefit.</p></div>
    <p className="ablation-provenance">{study?.model ?? 'Model pending'} · {study?.plannedSeeds ? `${study.plannedSeeds} paired seeds` : 'Seeds pending'} · Corpus {study?.corpusHash?.slice(0, 12) ?? 'pending'} · Arize {study?.arize?.status ?? 'pending'}</p>
    <p className="ablation-provenance">Counts come from Daytona Verilator and the independent oracle. A small pilot can show no improvement. Missing evidence receives no invented score.</p>
  </section>;
}
