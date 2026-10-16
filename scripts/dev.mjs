import { spawn } from 'node:child_process';

// Start and stop the model controller, role workspace controller, and frontend together.
const commands = [
  ['--filter', '@antibody/server', 'dev'],
  ['--filter', '@antibody/server', 'exec', 'node', '--import', 'tsx', 'src/scripts/role-workspace-server.ts'],
  ['--filter', '@antibody/web', 'dev'],
];
let stopping = false;
const children = commands.map(args => spawn('pnpm', args, { stdio: 'inherit', detached: process.platform !== 'win32' }));
const stop = (code = 0) => {
  if (stopping) return; stopping = true; process.exitCode = code;
  for (const child of children) {
    if (!child.pid || child.exitCode !== null) continue;
    try { if (process.platform === 'win32') child.kill('SIGTERM'); else process.kill(-child.pid, 'SIGTERM'); } catch {}
  }
};
for (const child of children) {
  child.once('error', () => stop(1));
  child.once('exit', code => { if (!stopping) stop(code ?? 1); });
}
process.once('SIGINT', () => stop());
process.once('SIGTERM', () => stop());
