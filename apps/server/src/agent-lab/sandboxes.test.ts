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

const roleRun: LabRun = {
  ...run,
  candidates: run.candidates.map(candidate => ({ ...candidate, sourceHash: `recorded-${candidate.id}` })),
  roleWorkspaces: [{ role: 'blue', sandboxId: 'blue-id', ready: true }, { role: 'red', sandboxId: 'red-id', ready: true }],
};
const roleSandbox = (role: 'blue' | 'red', state = 'started') => ({ ...sandbox(`${role}-id`, state), labels: { app: 'antibody', run: run.id, purpose: 'role-workspace', role } });

test('separate role references preserve the target desktop and the verified candidate', () => {
  const references = sandboxReferences(roleRun);
  assert.deepEqual(references.map(item => [item.key, item.id, item.role, item.kind, item.candidateId]), [
    ['blue', 'blue-id', 'blue', 'desktop', undefined],
    ['red', 'red-id', 'red', 'desktop', undefined],
    ['desktop', 'desktop-id', 'target', 'desktop', 'c1'],
    ['c2', 'repair-id', undefined, 'app', 'c2'],
  ]);
  assert.equal(new Set(references.map(item => item.id)).size, references.length);
  assert.equal(references.find(item => item.key === 'c2')?.title, 'Verified repair');
  const malformed = { ...roleRun, roleWorkspaces: [
    { role: 'blue', sandboxId: 'blue-id', ready: true },
    { role: 'red', sandboxId: 'blue-id', ready: true },
    { role: 'red', sandboxId: '../other-run', ready: true },
  ] } as LabRun;
  assert.deepEqual(sandboxReferences(malformed).map(item => item.key), ['blue', 'desktop', 'c2']);
});

test('role desktops are not advertised as open until their workspace preparation finishes', async () => {
  const starting = { ...roleRun, roleWorkspaces: roleRun.roleWorkspaces!.map(item => ({ ...item, ready: item.role !== 'blue' })) };
  const access = new LabSandboxAccess(async id => (id === 'blue-id' ? roleSandbox('blue') : id === 'red-id' ? roleSandbox('red') : sandbox(id)) as never);
  const result = await access.list(starting);
  assert.deepEqual(result.sandboxes.filter(item => item.role === 'blue' || item.role === 'red').map(item => [item.key, item.state, item.canOpen]), [['blue', 'starting', false], ['red', 'started', true]]);
  assert.ok(!JSON.stringify(result).includes('token'));
});

test('role previews reject mismatched role or purpose before starting or signing any resource', async () => {
  for (const labels of [
    { app: 'antibody', run: run.id, purpose: 'role-workspace', role: 'red' },
    { app: 'antibody', run: run.id, purpose: 'agent-lab', role: 'blue' },
    { app: 'antibody', run: run.id, purpose: 'role-workspace' },
  ]) {
    let mutations = 0, signatures = 0;
    const access = new LabSandboxAccess(async () => ({
      ...roleSandbox('blue', 'stopped'), labels,
      start: async () => { mutations++; },
      computerUse: { start: async () => { mutations++; } },
      getSignedPreviewUrl: async () => { signatures++; return { url: 'https://preview.example/' }; },
    }) as never);
    await assert.rejects(access.preview(roleRun, 'blue', true), /requested agent role/);
    assert.equal(mutations, 0);
    assert.equal(signatures, 0);
  }
});

test('live Blue and Red previews sign different desktops without invoking candidate health or application commands', async () => {
  const signed: [string, number][] = []; let commands = 0;
  const access = new LabSandboxAccess(async id => ({
    ...roleSandbox(id === 'blue-id' ? 'blue' : 'red'),
    process: { executeCommand: async () => { commands++; throw new Error('Role preview must not touch the candidate application.'); } },
    getSignedPreviewUrl: async (port: number) => { signed.push([id, port]); return { url: `https://${id}.preview.example/?token=private` }; },
  }) as never);
  const [blue, red] = await Promise.all([access.preview(roleRun, 'blue'), access.preview(roleRun, 'red')]);
  assert.deepEqual(new Set(signed.map(([id]) => id)), new Set(['blue-id', 'red-id']));
  assert.ok(signed.every(([, port]) => port === 6080));
  assert.equal(blue.sandboxId, 'blue-id'); assert.equal(red.sandboxId, 'red-id');
  assert.notEqual(blue.url, red.url);
  assert.equal(new URL(blue.url).pathname, '/vnc.html');
  assert.equal(new URL(red.url).searchParams.get('view_only'), 'true');
  assert.equal(commands, 0);
});

test('resuming a role desktop reopens display.py without restoring or modifying the target application', async () => {
  const commands: { command: string; cwd: string | undefined }[] = []; const ports: number[] = [];
  let starts = 0, displays = 0, uploads = 0;
  const before = structuredClone(roleRun);
  const access = new LabSandboxAccess(async () => ({
    ...roleSandbox('blue', 'stopped'),
    start: async () => { starts++; },
    computerUse: { start: async () => { displays++; } },
    process: { executeCommand: async (command: string, cwd?: string) => { commands.push({ command, cwd }); return { exitCode: 0, result: '' }; } },
    fs: { uploadFile: async () => { uploads++; throw new Error('Role resume must not rewrite files.'); } },
    getSignedPreviewUrl: async (port: number) => { ports.push(port); return { url: 'https://blue.preview.example/?token=private' }; },
  }) as never);
  await assert.rejects(access.preview(roleRun, 'blue'), /Resume sandbox/);
  assert.equal(starts, 0);
  const [first, second] = await Promise.all([access.preview(roleRun, 'blue', true), access.preview(roleRun, 'blue', true)]);
  assert.deepEqual(first, second); assert.equal(starts, 1); assert.equal(displays, 1);
  assert.equal(commands.length, 1);
  assert.match(commands[0]!.command, /python3 display\.py/);
  assert.equal(commands[0]!.cwd, '/home/daytona/role-workspace');
  assert.doesNotMatch(commands[0]!.command, /runtime\.py|target\.json|guard\.py|sqlite|healthz|reset|git\b/);
  assert.equal(uploads, 0); assert.deepEqual(ports, [6080]);
  assert.match(first.note!, /Model inference is managed by the controller/);
  assert.deepEqual(roleRun, before);
});
