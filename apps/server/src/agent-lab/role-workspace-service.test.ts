import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { claimRoleWorkspaceLease, readRoleWorkspaceState } from './role-workspace-service.js';

test('only one process can claim role-worker creation and a dead owner can be recovered', async () => {
  const id = `lease-test-${randomUUID()}`, directory = join(config.DATA_DIR, 'agent-runs', id);
  await mkdir(directory, { recursive: true });
  try {
    assert.equal(await claimRoleWorkspaceLease(id), true);
    assert.equal(await claimRoleWorkspaceLease(id), false);
    await writeFile(join(directory, 'role-workspaces.json.lock'), JSON.stringify({ pid: 2147483647, createdAt: 1 }));
    assert.equal(await claimRoleWorkspaceLease(id), true);
    assert.equal(await claimRoleWorkspaceLease(id), false);
    await assert.rejects(claimRoleWorkspaceLease('../outside'), /Invalid run ID/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('saved role metadata rejects duplicate roles, shared VM identities, and invalid identifiers', async () => {
  const id = `metadata-test-${randomUUID()}`, directory = join(config.DATA_DIR, 'agent-runs', id);
  await mkdir(directory, { recursive: true });
  try {
    const path = join(directory, 'role-workspaces.json');
    assert.equal(await readRoleWorkspaceState(id), undefined);
    const blue = { role: 'blue', sandboxId: 'blue-id', ready: true };
    await writeFile(path, JSON.stringify({ updatedAt: 1, workspaces: [blue, { role: 'red', sandboxId: 'red-id', ready: true }] }));
    assert.equal((await readRoleWorkspaceState(id))?.workspaces.length, 2);
    for (const rows of [[blue, blue], [blue, { role: 'red', sandboxId: 'blue-id', ready: true }], [{ ...blue, sandboxId: '../arbitrary' }]]) {
      await writeFile(path, JSON.stringify({ updatedAt: 1, workspaces: rows }));
      await assert.rejects(readRoleWorkspaceState(id), /metadata is invalid/);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
