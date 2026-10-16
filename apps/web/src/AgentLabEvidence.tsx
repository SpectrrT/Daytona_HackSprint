import { useId, useState, type KeyboardEvent } from 'react';
import { ArrowRight, Check, ChevronDown, Code2, ShieldCheck, X } from 'lucide-react';
import type { AgentEnvironment, LabCandidate, LabRun, LabTrial } from '@antibody/shared/agent-lab';
import { compareDomain, regressionProgress } from './agent-lab-view';
const domains: { id: AgentEnvironment; label: string }[] = [{ id: 'engineering', label: 'Engineering' }, { id: 'procurement', label: 'Purchasing' }, { id: 'support', label: 'Support' }];
const money = (cents: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
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
