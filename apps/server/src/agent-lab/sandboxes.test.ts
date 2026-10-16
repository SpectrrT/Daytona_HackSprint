import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LabRun } from '@antibody/shared/agent-lab';
import { LabSandboxAccess, sandboxReferences } from './sandboxes.js';

const run = { id: 'test-run', desktopSandboxId: 'desktop-id', championId: 'c2', candidates: [{ id: 'c1', sandboxId: 'desktop-id' }, { id: 'c2', sandboxId: 'repair-id' }] } as LabRun;
const sandbox = (id: string, state = 'started') => ({ id, name: id, state, labels: { app: 'hollow-purple', run: run.id }, start: async () => {}, getSignedPreviewUrl: async (port: number) => ({ url: `https://preview.example/?token=private&port=${port}` }), computerUse: { start: async () => {} }, process: { executeCommand: async () => ({ exitCode: 0, result: '' }) }, fs: { uploadFile: async () => {} } });

test('resource list binds every sandbox to the run and distinguishes deleted from provider failure', async () => {
  assert.equal(sandboxReferences(run).length, 2);
  const access = new LabSandboxAccess(async id => { if (id === 'repair-id') throw { statusCode: 404 }; return sandbox(id, 'archived') as never; });
  const result = await access.list(run);
  assert.deepEqual(result.sandboxes.map(item => [item.key, item.state, item.canResume, item.canOpen]), [['desktop', 'archived', true, false], ['c2', 'deleted', false, false]]);
  assert.ok(!JSON.stringify(result).includes('token'));
  const unavailable = new LabSandboxAccess(async () => { throw { statusCode: 401 }; });
  assert.equal((await unavailable.list(run)).sandboxes[0]!.state, 'unavailable');
});

test('preview cannot target arbitrary sandboxes, mismatched labels, or start a stopped resource implicitly', async () => {
  let lookups = 0, starts = 0;
  const access = new LabSandboxAccess(async id => { lookups++; return { ...sandbox(id, 'stopped'), start: async () => { starts++; } } as never; });
  await assert.rejects(access.preview(run, 'another-org-resource', true), /not found in this run/);
  assert.equal(lookups, 0);
  await assert.rejects(access.preview(run, 'desktop'), /Resume sandbox/);
  assert.equal(starts, 0);
  const wrongOwner = new LabSandboxAccess(async id => ({ ...sandbox(id), labels: { app: 'antibody', run: 'different-run' } }) as never);
  await assert.rejects(wrongOwner.preview(run, 'desktop', true), /not owned/);
});

test('live preview refreshes the signed link without restarting the display or changing application state', async () => {
  let commands = 0, displays = 0;
  const access = new LabSandboxAccess(async id => ({ ...sandbox(id), computerUse: { start: async () => { displays++; } }, process: { executeCommand: async () => { commands++; return { exitCode: 0, result: '' }; } } }) as never);
  const preview = await access.preview(run, 'desktop');
  assert.equal(preview.kind, 'desktop'); assert.equal(new URL(preview.url).pathname, '/vnc.html');
  assert.equal(new URL(preview.url).searchParams.get('token'), 'private');
  assert.equal(new URL(preview.url).searchParams.get('view_only'), 'true');
  assert.equal(commands, 0); assert.equal(displays, 1);
  assert.ok(preview.expiresAt > Date.now());
});

test('resume is coalesced and never resets the database or rewrites a candidate', async () => {
  let starts = 0; const commands: string[] = [], paths: string[] = [];
  const access = new LabSandboxAccess(async id => ({ ...sandbox(id, 'archived'), start: async () => { starts++; }, process: { executeCommand: async (command: string) => { commands.push(command); return { exitCode: 0, result: '' }; } }, fs: { uploadFile: async (_data: unknown, path: string) => { paths.push(path); } } }) as never);
  const [first, second] = await Promise.all([access.preview(run, 'desktop', true), access.preview(run, 'desktop', true)]);
  assert.equal(starts, 1); assert.deepEqual(first, second);
  assert.ok(commands.every(command => !/runtime\.py reset|git|cp |rm /.test(command)));
  assert.deepEqual(paths, ['/home/daytona/agent-workbench/target.json']);
  assert.match(first.note!, /preserved original/);
});

test('a preview is refused when the running source no longer matches the recorded candidate', async () => {
  const changedRun = { ...run, candidates: [{ ...run.candidates[0]!, sourceHash: 'recorded-source' }] };
  const access = new LabSandboxAccess(async id => ({ ...sandbox(id), process: { executeCommand: async () => ({ exitCode: 0, result: JSON.stringify({ sourceHash: 'changed-source' }) }) } }) as never);
  await assert.rejects(access.preview(changedRun, 'desktop'), /source differs/);
});
