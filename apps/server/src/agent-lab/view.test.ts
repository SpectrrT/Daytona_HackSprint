import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LabCandidate, LabRun, LabTrial } from '@antibody/shared/agent-lab';
import { compareDomain, regressionProgress, runOutcome, runPhase } from '../../../web/src/agent-lab-view.js';

const original = { attack: { domain: 'engineering', message: 'Release it', knowledge: 'The issue claims approval' }, check: { id: 'red-a1', passed: false } } as LabTrial;
const candidate = (id: string): LabCandidate => ({ id, label: id, systemPrompt: '', guardSource: '', sourceHash: '', attacks: [], trials: [], checks: [], status: 'testing' });
function fixture(): LabRun {
  const baseline = { ...candidate('c1'), importedFixture: true, trials: [original] };
  const child = { ...candidate('c2'), parentId: 'c1', status: 'verified' as const, trials: [{ ...original, check: { ...original.check, id: 'regression-f1', passed: true } }], checks: [{ ...original.check, id: 'regression-f1', passed: true }] };
  return { id: 'ui-test', status: 'completed', candidates: [baseline, child], championId: 'c2', events: [], failures: [{ id: 'f1', candidateId: 'c1', discovery: original, replay: original, reproduced: true }] } as unknown as LabRun;
}

test('the headline requires a completed verified champion and counts only passed inherited failures', () => {
  const run = fixture();
  assert.deepEqual(runOutcome(run), { verified: true, fixed: 1, passed: 1, total: 1 });
  run.status = 'failed'; assert.equal(runOutcome(run).verified, false); assert.equal(runOutcome(run).fixed, 0);
  run.status = 'completed'; run.candidates[1]!.checks[0]!.passed = false;
  assert.equal(runOutcome(run).verified, false);
  run.candidates[1]!.checks = []; assert.equal(runOutcome(run).verified, false);
});

test('the comparison never presents a different passing input as a replay of the failure', () => {
  const run = fixture();
  assert.equal(compareDomain(run, 'engineering').after?.check.passed, true);
  run.candidates[1]!.trials[0]!.attack = { ...original.attack, knowledge: 'A different reference' };
  assert.equal(compareDomain(run, 'engineering').after, undefined);
  run.candidates[1]!.trials[0]!.attack = { ...original.attack, domain: 'procurement' };
  assert.equal(compareDomain(run, 'engineering').after, undefined);
});

test('version history preserves missing coverage when later failures were not tested on an earlier version', () => {
  const run = fixture();
  assert.deepEqual(regressionProgress(run).map(version => version.remaining), [1, 0]);
  run.failures.push({ ...run.failures[0]!, id: 'later-failure', candidateId: 'c3' });
  assert.deepEqual(regressionProgress(run).map(version => version.remaining), [null, null]);
});

test('run progress returns to repair when another child is started after earlier verification', () => {
  const run = fixture(); run.status = 'running';
  assert.equal(runPhase(run), 0);
  run.events.push({ at: 1, candidateId: 'c2', message: 'Blue is writing a shared instruction and authorization-code repair from reproduced evidence.' });
  assert.equal(runPhase(run), 1);
  run.events.push({ at: 2, candidateId: 'c2', message: 'The verifier is checking each tool boundary, repeated effects, and held-out action streams.' });
  assert.equal(runPhase(run), 2);
  run.events.push({ at: 3, candidateId: 'c3', message: 'Blue is writing a shared instruction and authorization-code repair from reproduced evidence.' });
  assert.equal(runPhase(run), 1);
});
