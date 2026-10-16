import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { LabAttack, LabCandidate, LabRoleWorkspace, LabRun } from "@antibody/shared/agent-lab";
import { config, REPO_ROOT } from "../config.js";
import { Computer, shellQuote } from "../daytona/computer.js";
import { daytona } from "../daytona/client.js";
import { assertContract, candidateHash, hash } from "./contract.js";

export type WorkspaceRole = "blue" | "red";
export interface RoleWorkspaceMetadata { role: WorkspaceRole; sandboxId: string; ready: boolean; error?: string }
interface Workspace { computer: Computer; metadata: RoleWorkspaceMetadata; version?: string; receipt?: Record<string, unknown> }
interface CreateOptions { signal?: AbortSignal; onProvisioned?: (workspace: RoleWorkspaceMetadata) => void | Promise<void> }
const ROOT = "/home/daytona/role-workspace";

/** Setup diagnostics are local and bounded; provider URLs and credentials never enter the report. */
export function safeRoleSetupLog(value: string): string {
  let result = value.slice(-6000).replace(/https?:\/\/[^\s'"<>]+/gi, "[provider URL removed]").replace(/\bBearer\s+\S+/gi, "Bearer [removed]").replace(/\b(?:dtn_|sk-|ak_)[A-Za-z0-9_.-]+/g, "[credential removed]");
  for (const secret of [config.DAYTONA_API_KEY, config.ANCHOR_API_KEY]) if (secret) result = result.replaceAll(secret, "[credential removed]");
  return [...result].filter(char => char === "\n" || char === "\t" || char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127).join("").slice(-3000);
}

/** Only the model's actual returned attacks are written to Red's workspace. */
export function validateWorkspaceAttacks(attacks: LabAttack[]): void {
  assert.equal(attacks.length, 3, "Red must return three attacks.");
  assert.equal(new Set(attacks.map(attack => attack.domain)).size, 3, "Red must cover three domains.");
  assert.equal(new Set(attacks.map(attack => attack.id)).size, 3, "Attack IDs must be unique.");
  for (const attack of attacks) {
    assert.match(attack.id, /^[a-z][a-z0-9-]{0,39}$/);
    assert.ok(["support", "procurement", "engineering"].includes(attack.domain));
    assert.ok(attack.name.length >= 3 && attack.name.length <= 100);
    assert.ok(attack.hypothesis.length >= 10 && attack.hypothesis.length <= 1500);
    for (const text of [attack.message, attack.knowledge]) {
      assert.ok(text.length >= 1 && text.length <= 1400);
      assert.match(text, /^[\x0a\x20-\x7e]*$/);
    }
    assert.ok(!/[a-z][a-z0-9+.-]*:\/\/|\bwww\./i.test(JSON.stringify(attack)), "External URLs are outside the fixed lab.");
  }
}

/** Public evidence only: hidden test inputs and target invocation paths never enter either VM. */
export function workspacePublicState(run: LabRun, role: WorkspaceRole) {
  assertContract(run.contract);
  const currentSource = run.candidates.at(-1);
  const candidate = role === "red" ? [...run.candidates].reverse().find(row => row.redAgent) ?? currentSource : currentSource;
  return {
    runId: run.id, role, status: run.status, contractHash: run.contract.hash,
    sourceCandidateId: currentSource?.id,
    candidate: candidate && { id: candidate.id, sourceHash: candidate.sourceHash, label: candidate.label, importedFixture: !!candidate.importedFixture,
      agent: candidate[role === "blue" ? "blueAgent" : "redAgent"] && (() => { const agent = candidate[role === "blue" ? "blueAgent" : "redAgent"]!; return { provider: agent.provider, model: agent.model, startedAt: agent.startedAt, durationMs: agent.durationMs }; })() },
    events: run.events.slice(-14).map(event => ({ at: event.at, message: event.message, candidateId: event.candidateId })),
    findings: run.failures.map(failure => ({ candidateId: failure.candidateId, attackId: failure.discovery.attack.id, domain: failure.discovery.attack.domain, summary: failure.discovery.check.summary, reproduced: failure.reproduced })),
    publicChecks: (candidate?.checks ?? []).filter(check => !check.hidden).map(check => ({ id: check.id, domain: check.domain, passed: check.passed, summary: check.summary })),
    ...(role === "blue" ? { source: candidate?.guardSource, rationale: candidate?.rationale } : { attacks: candidate?.redAgent ? candidate.attacks : [] }),
  };
}

// This renderer is trusted. Model output is JSON data, never a shell command or terminal escape.
export const ROLE_WORKSPACE_DISPLAY = String.raw`import json, os, shutil, time
from pathlib import Path

def text(value):
    return ''.join(c for c in str(value) if c == '\n' or 32 <= ord(c) < 127)

last = None
while True:
    try:
        raw = Path('status.json').read_text()
        if raw != last:
            state = json.loads(raw)
            role = state['role'].upper()
            width = max(50, min(120, shutil.get_terminal_size(fallback=(100, 60)).columns))
            color = '\033[94m' if role == 'BLUE' else '\033[91m'
            print('\033[2J\033[H' + color + role + '  /  ANTIBODY WORKSPACE\033[0m')
            print('Daytona VM: ' + text(state['sandboxId']))
            print('Run: ' + text(state['runId']) + '  /  ' + text(state['status']))
            print('Model inference: controller. This VM owns role files and validation.')
            print('-' * width)
            candidate = state.get('candidate') or {}
            print('Candidate: ' + text(candidate.get('id', 'Waiting for source')))
            if state.get('sourceCandidateId'): print('Current public source: ' + text(state['sourceCandidateId']))
            if candidate.get('importedFixture'): print('Starting source is a MANUAL fixture; Blue did not generate it.')
            agent = candidate.get('agent')
            if agent: print('Returned model job: ' + text(agent['provider']) + ' / ' + text(agent['model']))
            receipt = state.get('receipt')
            if receipt:
                print('Workspace validation: ' + text(receipt.get('status', 'unknown')))
                if receipt.get('commit'): print('Actual VM Git commit: ' + text(receipt['commit']))
                print(text(receipt.get('detail', '')))
            print('-' * width)
            if role == 'BLUE':
                print('ACTUAL SOURCE' + (' / ' + text(candidate['sourceHash'])[:16] if candidate.get('sourceHash') else ''))
                for line in text(state.get('source') or 'Waiting for candidate source.').splitlines()[:14]: print(line[:width])
            else:
                print('ACTUAL RED MODEL OUTPUTS')
                attacks = state.get('attacks') or []
                if not attacks: print('Waiting for the Red model to return attacks.')
                for attack in attacks:
                    print(text(attack['domain']).upper() + ': ' + text(attack['name']))
                    print(text(attack['hypothesis'])[:width])
            print('-' * width)
            print('LATEST RECORDED ACTIVITY')
            for event in state.get('events', [])[-10:]:
                stamp = time.strftime('%H:%M:%S', time.gmtime(event['at'] / 1000))
                print(stamp + '  ' + text(event['message'])[:width-10])
            print('\nPublic files: ' + text(str(Path.cwd())) + ' / No hidden test inputs.')
            Path('display-ready').write_text('Native role terminal rendered successfully.\n')
            last = raw
    except FileNotFoundError: pass
    except (ValueError, KeyError, OSError): pass
    time.sleep(1)
`;

export const ROLE_ATTACK_VALIDATOR = String.raw`import json, re
from pathlib import Path
rows = json.loads(Path('attacks.json').read_text())
assert len(rows) == 3 and len({r['id'] for r in rows}) == 3
assert {r['domain'] for r in rows} == {'support', 'procurement', 'engineering'}
for row in rows:
    assert set(row) == {'id', 'name', 'domain', 'hypothesis', 'message', 'knowledge'}
    assert re.fullmatch(r'[a-z][a-z0-9-]{0,39}', row['id'])
    assert 3 <= len(row['name']) <= 100
    assert 10 <= len(row['hypothesis']) <= 1500
    for key in ['message', 'knowledge']:
        assert 1 <= len(row[key]) <= 1400
        assert all(c == '\n' or 32 <= ord(c) < 127 for c in row[key])
    assert not re.search(r'[a-z][a-z0-9+.-]*://|\bwww\.', json.dumps(row), re.I)
print('Three actual Red outputs validated: schema, domains, bounds, ASCII, no external URLs.')
`;

/** Distinct role-owned VMs. Model inference stays in the controller; no credentials are copied. */
export class RoleWorkspaces {
  private queue: Promise<void> = Promise.resolve();
  private constructor(readonly runId: string, private readonly rows: Workspace[], private readonly options: CreateOptions) {}
  get workspaces(): RoleWorkspaceMetadata[] { return this.rows.map(row => ({ ...row.metadata })); }
  get metadata(): RoleWorkspaceMetadata[] { return this.workspaces; }

  /** Reattach only this run's labelled role VMs. Inspection never starts, replaces or deletes a VM. */
  static async attach(runId: string, saved: LabRoleWorkspace[], options: CreateOptions = {}): Promise<RoleWorkspaces> {
    assert.match(runId, /^[a-zA-Z0-9_-]{1,100}$/);
    assert.equal(saved.length, 2, "Two persisted role workspaces are required.");
    assert.deepEqual(new Set(saved.map(row => row.role)), new Set(["blue", "red"]));
    assert.equal(new Set(saved.map(row => row.sandboxId)).size, 2, "Roles must own different VMs.");
    const rows: Workspace[] = [];
    try {
      for (const metadata of saved) {
        options.signal?.throwIfAborted();
        assert.match(metadata.sandboxId, /^[a-zA-Z0-9_-]{1,100}$/);
        const sandbox = await daytona().get(metadata.sandboxId);
        assert.equal(sandbox.id, metadata.sandboxId);
        assert.equal(sandbox.labels?.app, "antibody");
        assert.equal(sandbox.labels?.purpose, "role-workspace");
        assert.equal(sandbox.labels?.run, runId);
        assert.equal(sandbox.labels?.role, metadata.role);
        const computer = new Computer(sandbox);
        const rendered = sandbox.state === "started" ? await computer.exec(`test -f ${ROOT}/display.py && test -f ${ROOT}/display-ready`, { timeoutSec: 5 }) : undefined;
        const row: Workspace = { computer, metadata: { role: metadata.role, sandboxId: sandbox.id, ready: rendered?.exitCode === 0 } };
        rows.push(row); await options.onProvisioned?.({ ...row.metadata });
      }
      return new RoleWorkspaces(runId, rows, options);
    } catch (error) {
      if (options.signal?.aborted) throw error;
      throw new Error("Saved Blue/Red workspace ownership or availability could not be verified. No resource was started, replaced, or deleted.");
    }
  }

  static async create(runId: string, options: CreateOptions = {}): Promise<RoleWorkspaces> {
    assert.match(runId, /^[a-zA-Z0-9_-]{1,100}$/);
    const rows: Workspace[] = [];
    let stage = "sandbox allocation", activeRole: WorkspaceRole | undefined;
    let lastCommand: { exitCode: number; output: string } | undefined;
    try {
      // Sequential provisioning avoids briefly overcommitting the account's desktop memory quota.
      for (const role of ["blue", "red"] as const) {
        activeRole = role; stage = "sandbox allocation"; lastCommand = undefined;
        options.signal?.throwIfAborted();
        const sandbox = await daytona().create({ name: `role-${role}-${runId.slice(0, 12)}`.toLowerCase(), snapshot: "daytona-small", public: false,
          labels: { app: "antibody", purpose: "role-workspace", run: runId, role }, envVars: { VNC_RESOLUTION: "1200x900" }, autoStopInterval: 30, autoDeleteInterval: -1 }, { timeout: 180 });
        const row: Workspace = { computer: new Computer(sandbox), metadata: { role, sandboxId: sandbox.id, ready: false } }; rows.push(row);
        await options.onProvisioned?.({ ...row.metadata });
        options.signal?.throwIfAborted();
        stage = "workspace directory setup";
        lastCommand = await row.computer.exec(`mkdir -p ${ROOT} /home/daytona/.config/xfce4/terminal`);
        assert.equal(lastCommand.exitCode, 0);
        stage = "role file upload";
        await row.computer.writeFile(`${ROOT}/display.py`, ROLE_WORKSPACE_DISPLAY);
        await row.computer.writeFile(`${ROOT}/validate.py`, await readFile(join(REPO_ROOT, "lab/agent-lab/validate.py"), "utf8"));
        await row.computer.writeFile(`${ROOT}/validate_attacks.py`, ROLE_ATTACK_VALIDATOR);
        await row.computer.writeFile(`${ROOT}/status.json`, JSON.stringify({ runId, sandboxId: sandbox.id, role, status: "Workspace starting", events: [] }));
        await row.computer.writeFile("/home/daytona/.config/xfce4/terminal/terminalrc", "[Configuration]\nFontName=Monospace 13\nColorBackground=#151719\nColorForeground=#eef0f1\nMiscMenubarDefault=FALSE\nMiscBell=FALSE\nScrollingLines=10000\n");
        stage = "terminal dependency installation";
        lastCommand = await row.computer.exec("command -v xfce4-terminal >/dev/null 2>&1 || (sudo -n apt-get update -qq && sudo -n DEBIAN_FRONTEND=noninteractive apt-get install -y -qq xfce4-terminal)", { timeoutSec: 180 });
        assert.equal(lastCommand.exitCode, 0, "The role terminal dependency could not be installed.");
        stage = "native desktop startup";
        await sandbox.computerUse.start();
        stage = "native terminal launch";
        lastCommand = await row.computer.exec(`nohup env DISPLAY=:0 xfce4-terminal --disable-server --maximize --title=${shellQuote(`${role.toUpperCase()} | Antibody | Daytona`)} --working-directory=${ROOT} --command='python3 -u display.py' >${ROOT}/terminal.log 2>&1 </dev/null &`, { timeoutSec: 15 });
        assert.equal(lastCommand.exitCode, 0, "Role desktop terminal did not launch.");
        stage = "native terminal first render";
        lastCommand = await row.computer.exec("python3 -c 'from pathlib import Path; import time; ready=Path(\"display-ready\"); [(time.sleep(0.5)) for _ in range(20) if not ready.exists()]; assert ready.exists(), \"The native terminal has not rendered\"'", { cwd: ROOT, timeoutSec: 15 });
        assert.equal(lastCommand.exitCode, 0, "Role desktop terminal did not render.");
        row.metadata.ready = true; await options.onProvisioned?.({ ...row.metadata });
      }
      assert.notEqual(rows[0]!.computer.id, rows[1]!.computer.id);
      return new RoleWorkspaces(runId, rows, options);
    } catch (error) {
      let terminalLog = "";
      const active = rows.find(row => row.metadata.role === activeRole);
      if (active) try { terminalLog = await active.computer.readText(`${ROOT}/terminal.log`, 12000); } catch { /* No terminal log exists before its launch stage. */ }
      const diagnostic = { at: Date.now(), runId, role: activeRole, stage, sandboxId: active?.computer.id, commandExitCode: lastCommand?.exitCode,
        commandOutput: safeRoleSetupLog(lastCommand?.output ?? ""), terminalLog: safeRoleSetupLog(terminalLog), failure: options.signal?.aborted ? "Setup was cancelled." : `Role setup failed during ${stage}.` };
      let diagnosticSaved = false;
      try {
        const directory = join(config.DATA_DIR, "agent-runs", runId); await mkdir(directory, { recursive: true, mode: 0o700 });
        await writeFile(join(directory, "role-setup-error.json"), JSON.stringify(diagnostic, null, 2), { mode: 0o600 }); diagnosticSaved = true;
      } catch { /* Cleanup still runs when the local diagnostic location is unavailable. */ }
      // Never delete the app, a candidate, a teammate resource, or a VM not created here.
      await Promise.allSettled(rows.map(async row => {
        row.metadata.ready = false;
        try { await row.computer.sandbox.delete(60, true); row.metadata.error = `Setup failed during ${stage}; this newly created VM was removed.`; }
        catch { row.metadata.error = `Setup failed during ${stage}; automatic removal failed, so inspect this VM in Daytona.`; }
      }));
      await Promise.allSettled(rows.map(row => Promise.resolve(options.onProvisioned?.({ ...row.metadata }))));
      if (options.signal?.aborted) throw error;
      throw new Error(`Separate ${activeRole ?? "Blue/Red"} Daytona workspace setup failed during ${stage}.${diagnosticSaved ? " Safe diagnostics: role-setup-error.json." : " Local diagnostics could not be saved."} Application evidence is unchanged.`);
    }
  }

  /** Serialize updates so terminal readers never see a partial JSON file or mismatched version. */
  sync(run: LabRun): Promise<void> {
    assert.equal(run.id, this.runId, "A role workspace cannot receive another run's data.");
    const snapshot = structuredClone(run);
    const job = this.queue.then(() => this.update(snapshot));
    this.queue = job.catch(() => {});
    return job;
  }

  private async update(run: LabRun): Promise<void> {
    assertContract(run.contract);
    const candidate = run.candidates.at(-1);
    for (const row of this.rows) {
      if (!row.metadata.ready) continue;
      const computer = row.computer, role = row.metadata.role;
      await computer.writeFile(`${ROOT}/contract.json`, JSON.stringify(run.contract, null, 2));
      if (candidate) {
        assert.match(candidate.id, /^[a-zA-Z0-9_-]{1,100}$/);
        assert.equal(candidate.sourceHash, candidateHash(candidate.systemPrompt, candidate.guardSource), "Candidate source hash changed.");
        if (role === "blue") await this.blue(row, candidate);
        else {
          const returned = [...run.candidates].reverse().find(item => item.redAgent && item.attacks.length);
          await computer.writeFile(`${ROOT}/public-source.py`, candidate.guardSource);
          await computer.writeFile(`${ROOT}/instructions.txt`, candidate.systemPrompt);
          if (returned) await this.red(row, returned, run);
        }
      }
      const state = { ...workspacePublicState(run, role), sandboxId: computer.id, receipt: row.receipt };
      await computer.writeFile(`${ROOT}/status.json.next`, JSON.stringify(state));
      const published = await computer.exec(`mv ${ROOT}/status.json.next ${ROOT}/status.json`, { timeoutSec: 5 });
      assert.equal(published.exitCode, 0, "Role terminal state could not be published.");
    }
  }

  private async blue(row: Workspace, candidate: LabCandidate): Promise<void> {
    if (row.version === candidate.sourceHash) return;
    const computer = row.computer;
    await computer.writeFile(`${ROOT}/guard.py`, candidate.guardSource);
    await computer.writeFile(`${ROOT}/instructions.txt`, candidate.systemPrompt);
    await computer.writeFile(`${ROOT}/candidate.json`, JSON.stringify({ id: candidate.id, sourceHash: candidate.sourceHash, importedFixture: !!candidate.importedFixture, generatedByBlue: !!candidate.blueAgent }, null, 2));
    const result = await computer.exec("python3 validate.py guard.py && python3 -m py_compile guard.py && git init -q && git add guard.py instructions.txt candidate.json contract.json && git -c core.hooksPath=/dev/null -c commit.gpgSign=false -c user.name=Blue -c user.email=blue@local commit --allow-empty -qm 'Validate actual candidate source in Blue workspace' && git rev-parse HEAD", { cwd: ROOT, timeoutSec: 30 });
    const commit = result.exitCode === 0 ? result.output.trim().split(/\r?\n/).at(-1) : undefined;
    row.receipt = { sourceHash: candidate.sourceHash, status: result.exitCode === 0 ? "AST and Python compile passed" : "Source validation failed", commit,
      detail: "This is static source validation in Blue's own VM. Application acceptance is decided separately by the independent verifier.", validatedAt: Date.now() };
    await computer.writeFile(`${ROOT}/validation.json`, JSON.stringify(row.receipt, null, 2));
    row.version = candidate.sourceHash;
  }

  private async red(row: Workspace, candidate: LabCandidate, run: LabRun): Promise<void> {
    validateWorkspaceAttacks(candidate.attacks);
    const currentSource = run.candidates.at(-1) ?? candidate;
    const computer = row.computer, version = hash(JSON.stringify({ sourceHash: currentSource.sourceHash, attackCandidateId: candidate.id, attacks: candidate.attacks }));
    await computer.writeFile(`${ROOT}/public-findings.json`, JSON.stringify(workspacePublicState(run, "red").findings, null, 2));
    if (row.version === version) return;
    await computer.writeFile(`${ROOT}/attacks.json`, JSON.stringify(candidate.attacks, null, 2));
    const result = await computer.exec("python3 validate_attacks.py && git init -q && git add attacks.json public-source.py instructions.txt contract.json && git -c core.hooksPath=/dev/null -c commit.gpgSign=false -c user.name=Red -c user.email=red@local commit --allow-empty -qm 'Validate actual returned Red attacks' && git rev-parse HEAD", { cwd: ROOT, timeoutSec: 30 });
    row.receipt = { sourceHash: currentSource.sourceHash, attackCandidateId: candidate.id, status: result.exitCode === 0 ? "Three returned attacks validated" : "Attack validation failed", commit: result.exitCode === 0 ? result.output.trim().split(/\r?\n/).at(-1) : undefined,
      detail: "Red inputs are stored and schema-checked here. Anchor executes them against the separate application sandbox; the verifier reports actual effects.", validatedAt: Date.now() };
    await computer.writeFile(`${ROOT}/validation.json`, JSON.stringify(row.receipt, null, 2));
    row.version = version;
  }

  /** Preserve role-owned files and VM IDs for a later resume; do not delete evidence. */
  async stop(): Promise<void> {
    await this.queue;
    const results = await Promise.allSettled(this.rows.map(async row => { await row.computer.sandbox.stop(); row.metadata.ready = false; await this.options.onProvisioned?.({ ...row.metadata }); }));
    if (results.some(result => result.status === "rejected")) throw new Error("A role workspace could not be stopped. Its actual VM remains visible in Daytona.");
  }
  async close(): Promise<void> { await this.stop(); }
}
