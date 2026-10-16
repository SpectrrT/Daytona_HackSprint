import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentEnvironment, LabAction, LabCandidate, LabProposal, LabSnapshot } from "@hollow-purple/shared/agent-lab";
import { REPO_ROOT } from "../config.js";
import { daytona } from "../daytona/client.js";
import { Computer, shellQuote } from "../daytona/computer.js";
import { candidateHash, CONTEXTS, hash, RECORDS } from "./contract.js";

export const APP_DIR = "/home/daytona/agent-app", DESKTOP_DIR = "/home/daytona/agent-workbench";
export const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export interface LabJob { id: string; input: { domain: AgentEnvironment; message: string; knowledge: string }; result: { proposal: LabProposal; tools: unknown[] } | null }
export class DaytonaAgentAdapter {
  private constructor(readonly computer: Computer, readonly candidate: LabCandidate, readonly appUrl: string, readonly runtimeHash: string) {}
  static async provision(runId: string, candidate: LabCandidate, desktopId?: string, options: { headless?: boolean } = {}): Promise<DaytonaAgentAdapter> {
    const small = !!desktopId || options.headless;
    const sandbox = await daytona().create({ name: `agents-${runId.slice(0, 12)}-${candidate.id}`.toLowerCase(), snapshot: small ? "daytona-small" : "daytona-medium", public: false,
      envVars: small ? {} : { VNC_RESOLUTION: "1600x1000" }, labels: { app: "hollow-purple", purpose: "agent-lab", run: runId, candidate: candidate.id }, autoStopInterval: 30, autoDeleteInterval: desktopId ? 0 : -1, ...(desktopId ? { linkedSandbox: desktopId } : {}) }, { timeout: 180 });
    candidate.sandboxId = sandbox.id;
    const computer = new Computer(sandbox);
    try {
      const files: Record<string, string> = {};
      for (const name of ["runtime.py", "validate.py", "index.html"]) files[name] = await readFile(join(REPO_ROOT, "lab/agent-lab", name), "utf8");
      files["fixtures.json"] = JSON.stringify({ contexts: CONTEXTS, records: RECORDS });
      files["candidate.json"] = JSON.stringify({ id: candidate.id, label: candidate.label, importedFixture: !!candidate.importedFixture, systemPrompt: candidate.systemPrompt });
      files["guard.py"] = candidate.guardSource;
      await computer.exec(`mkdir -p ${APP_DIR}`);
      for (const [name, value] of Object.entries(files)) await computer.writeFile(`${APP_DIR}/${name}`, value);
      const build = await computer.exec("python3 validate.py guard.py && python3 runtime.py validate && python3 -m py_compile guard.py runtime.py && git init -q && git add guard.py candidate.json runtime.py validate.py fixtures.json index.html && git -c core.hooksPath=/dev/null -c commit.gpgSign=false -c user.name=Lab -c user.email=lab@local commit --allow-empty -qm 'Agent candidate' && git rev-parse HEAD", { cwd: APP_DIR, timeoutSec: 30 });
      if (build.exitCode !== 0) throw new Error(`Agent candidate did not build: ${build.output.slice(-1600)}`);
      candidate.commit = build.output.trim().split(/\r?\n/).at(-1);
      const preview = await sandbox.getSignedPreviewUrl(8000, 21600); candidate.appUrl = preview.url;
      const runtimeHash = hash(["runtime.py", "fixtures.json", "validate.py", "index.html"].map(name => files[name]!).join("\0"));
      const adapter = new DaytonaAgentAdapter(computer, candidate, preview.url, runtimeHash); await adapter.reset(); return adapter;
    } catch (error) { await sandbox.delete(60, true).catch(() => {}); throw error; }
  }
  async checked(command: string, cwd = APP_DIR, timeoutSec = 30): Promise<string> {
    const result = await this.computer.exec(command, { cwd, timeoutSec });
    if (result.exitCode !== 0) throw new Error(`Agent sandbox command failed: ${result.output.slice(-1600)}`);
    return result.output;
  }
  async reset(): Promise<void> {
    await this.checked("if [ -f server.pid ]; then lab_pid=$(cat server.pid); case \"$lab_pid\" in ''|*[!0-9]*) exit 1;; esac; kill \"$lab_pid\" 2>/dev/null || true; for round in 1 2 3 4 5; do kill -0 \"$lab_pid\" 2>/dev/null || break; sleep 0.1; done; fi; python3 runtime.py reset; nohup python3 -u runtime.py serve 8000 >server.log 2>&1 </dev/null & echo $! >server.pid");
    const pid = Number((await this.checked("cat server.pid")).trim());
    for (let attempt = 0; attempt < 30; attempt++) {
      const result = await this.computer.exec("curl -fsS http://127.0.0.1:8000/healthz", { timeoutSec: 5 });
      if (!result.exitCode) { const health = JSON.parse(result.output); if (health.processId === pid) { assert.equal(health.sourceHash, this.candidate.sourceHash); return; } }
      await pause(200);
    }
    throw new Error("The actual agent application did not start.");
  }
  async request<T>(path: string, body?: unknown): Promise<T> {
    let response;
    try { response = await fetch(new URL(path, this.appUrl), { method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json", "X-Daytona-Skip-Preview-Warning": "true" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(25000) }); }
    catch { throw new Error("Agent application request failed or timed out."); }
    assert.equal(response.headers.get("x-candidate-sha256"), this.candidate.sourceHash, "HTTP response is bound to another agent version.");
    const text = await response.text(); assert.ok(text.length < 300000, "Agent response exceeded its output bound.");
    if (!response.ok) throw new Error(`Agent application returned HTTP ${response.status}.`);
    return JSON.parse(text) as T;
  }
  async observe(): Promise<LabSnapshot> {
    const snapshot = JSON.parse(await this.checked("python3 runtime.py observe")) as LabSnapshot;
    assert.equal(snapshot.sourceHash, candidateHash(this.candidate.systemPrompt, this.candidate.guardSource)); assert.equal(snapshot.runtimeHash, this.runtimeHash);
    return snapshot;
  }
  async jobs(): Promise<LabJob[]> { return (await this.request<{ jobs: LabJob[] }>("/api/jobs")).jobs; }
  async tools(domain: AgentEnvironment, actions: LabAction[]): Promise<void> { await this.request("/api/tool-test", { domain, actions }); }
  /** A headless paired benchmark owns this sandbox and resets state per version. */
  async replaceCandidate(candidate: LabCandidate): Promise<DaytonaAgentAdapter> {
    assert.equal(candidate.sourceHash, candidateHash(candidate.systemPrompt, candidate.guardSource));
    await this.computer.writeFile(`${APP_DIR}/guard.py`, candidate.guardSource);
    await this.computer.writeFile(`${APP_DIR}/candidate.json`, JSON.stringify({ id: candidate.id, label: candidate.label, importedFixture: !!candidate.importedFixture, systemPrompt: candidate.systemPrompt }));
    await this.checked("python3 validate.py guard.py && python3 runtime.py validate && git add guard.py candidate.json && git -c core.hooksPath=/dev/null -c commit.gpgSign=false -c user.name=Lab -c user.email=lab@local commit --allow-empty -qm 'Paired candidate version'");
    candidate.sandboxId = this.computer.id;
    const adapter = new DaytonaAgentAdapter(this.computer, candidate, this.appUrl, this.runtimeHash);
    await adapter.reset(); return adapter;
  }
  async destroy(): Promise<void> { await this.computer.sandbox.delete(60, true); }
  async prepareDesktop(): Promise<void> {
    await this.computer.sandbox.computerUse.start(); await this.checked(`mkdir -p ${DESKTOP_DIR} /home/daytona/.config/xfce4/terminal`);
    for (const name of ["runtime.py", "validate.py", "index.html", "fixtures.json", "guard.py", "candidate.json"]) await this.computer.writeFile(`${DESKTOP_DIR}/${name}`, await this.computer.readText(`${APP_DIR}/${name}`));
    await this.computer.writeFile(`${DESKTOP_DIR}/cdp_relay.py`, await readFile(join(REPO_ROOT, "lab/software/cdp_relay.py")));
    await this.computer.writeFile("/home/daytona/.config/xfce4/terminal/terminalrc", "[Configuration]\nFontName=Monospace 15\nColorBackground=#151b2a\nColorForeground=#e9edf7\nMiscMenubarDefault=FALSE\nMiscBell=FALSE\nScrollingLines=10000\n");
    await this.checked(`git init -q && git add guard.py candidate.json && git -c user.name=Lab -c user.email=lab@local -c commit.gpgSign=false commit --allow-empty -qm 'Explicit manual starting fixture'`, DESKTOP_DIR);
    await this.pointAt(this);
    await this.checked("nohup python3 -u runtime.py serve 8080 >proxy.log 2>&1 </dev/null &", DESKTOP_DIR);
    await this.checked("nohup python3 -u cdp_relay.py >cdp-relay.log 2>&1 </dev/null &", DESKTOP_DIR);
    const check = await this.computer.exec("command -v wmctrl");
    if (check.exitCode) await this.checked("sudo -n apt-get update -qq && sudo -n DEBIAN_FRONTEND=noninteractive apt-get install -y -qq wmctrl", APP_DIR, 180);
  }
  async pointAt(candidate: DaytonaAgentAdapter): Promise<void> {
    let url = "http://127.0.0.1:8000";
    if (candidate.computer.id !== this.computer.id) { assert.equal(candidate.computer.sandbox.linkedSandboxId, this.computer.id); assert.match(candidate.computer.sandbox.name, /^[a-zA-Z0-9-]+$/); url = `http://${candidate.computer.sandbox.name}:8000`; }
    await this.computer.writeFile(`${DESKTOP_DIR}/target.json`, JSON.stringify({ url }));
    await this.computer.writeFile(`${DESKTOP_DIR}/candidate-info.txt`, `${candidate.candidate.id} / ${candidate.candidate.label}\nSandbox: ${candidate.computer.id}\nSHA-256: ${candidate.candidate.sourceHash}\nGit: ${candidate.candidate.commit}\n`);
  }
  async launch(command: string) { await this.checked(`nohup env DISPLAY=:0 ${command} >${shellQuote(`${DESKTOP_DIR}/desktop.log`)} 2>&1 </dev/null &`, DESKTOP_DIR); }
}
