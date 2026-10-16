import type { AgentEnvironment, LabRun } from '@antibody/shared/agent-lab';
import { demoVerdict } from '@antibody/shared/agent-lab-presentation';

/** Compare only the identical retained input. A different passing attack is not a repair replay. */
export function compareDomain(run: LabRun, domain: AgentEnvironment) {
  const champion = run.candidates.find(candidate => candidate.id === run.championId);
  const baseline = run.candidates[0];
  const failure = run.failures.find(item => item.discovery.attack.domain === domain);
  const origin = failure ? run.candidates.find(candidate => candidate.id === failure.candidateId) : baseline;
  const before = failure?.discovery ?? baseline?.trials.find(trial => trial.attack.domain === domain);
  const after = champion?.trials.find(trial => before && trial.attack.domain === domain && trial.attack.message === before.attack.message && trial.attack.knowledge === before.attack.knowledge);
  return { champion, failure, origin, before, after };
}

export function regressionProgress(run: LabRun) {
  return run.candidates.map(candidate => {
    const outcomes = run.failures.map(failure => failure.candidateId === candidate.id ? false : candidate.checks.find(check => check.id === `regression-${failure.id}`)?.passed);
    return { id: candidate.id, parent: candidate.parentId, fixture: !!candidate.importedFixture,
      remaining: !outcomes.length || outcomes.some(outcome => outcome === undefined) ? null : outcomes.filter(outcome => outcome === false).length };
  });
}

export function runOutcome(run: LabRun) {
  const champion = run.candidates.find(candidate => candidate.id === run.championId);
  const verified = demoVerdict(run).status === 'success';
  const fixed = verified && champion ? run.failures.filter(failure => champion.checks.some(check => check.id === `regression-${failure.id}` && check.passed)).length : 0;
  return { verified, fixed, passed: champion?.checks.filter(check => check.passed).length ?? 0, total: champion?.checks.length ?? 0 };
}

export function runPhase(run: LabRun): 0 | 1 | 2 {
  const repair = run.events.findLastIndex(event => event.message.startsWith('Blue is writing'));
  if (repair < 0 && !run.candidates.some(candidate => candidate.blueAgent)) return 0;
  const candidateId = run.events[repair]?.candidateId ?? run.candidates.at(-1)?.id;
  return run.events.slice(Math.max(0, repair + 1)).some(event => event.candidateId === candidateId && /tool boundary|tool-boundary|useful work|held-out/i.test(event.message)) ? 2 : 1;
}
