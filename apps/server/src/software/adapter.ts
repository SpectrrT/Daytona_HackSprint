import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CheckoutInput, HttpObservation, LedgerSnapshot, ObservedRequest, SoftwareCandidate } from "@antibody/shared/software";
import { REPO_ROOT } from "../config.js";
import { daytona } from "../daytona/client.js";
import { Computer, shellQuote } from "../daytona/computer.js";
import { sourceHash } from "./contract.js";

export const APP_DIR = "/home/daytona/software";
export const LAB_DIR = "/home/daytona/software-lab";
export const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export interface SoftwareExecutionAdapter {
  reset(): Promise<void>;
  request(input: CheckoutInput): Promise<HttpObservation>;
  observe(): Promise<LedgerSnapshot>;
  events(): Promise<ObservedRequest[]>;
  destroy(): Promise<void>;
}

/** One private Daytona sandbox and immutable harness per candidate. No provider keys are uploaded. */
export class DaytonaSoftwareAdapter implements SoftwareExecutionAdapter {
  readonly computer: Computer;
  readonly runtimeHash: string;
  private constructor(computer: Computer, readonly candidate: SoftwareCandidate, readonly appUrl: string, runtime: string) {
    this.computer = computer;
    this.runtimeHash = sourceHash(runtime);
  }
  static async attach(candidate: SoftwareCandidate): Promise<DaytonaSoftwareAdapter> {
    assert.ok(candidate.sandboxId && candidate.appUrl);
    const sandbox = await daytona().get(candidate.sandboxId);
    assert.ok(sandbox.labels.app === "antibody" && sandbox.labels.purpose === "software-demo");
    const runtime = await readFile(join(REPO_ROOT, "lab/software/runtime.py"), "utf8");
    const adapter = new DaytonaSoftwareAdapter(new Computer(sandbox), candidate, candidate.appUrl, runtime);
    await adapter.observe();
    return adapter;
  }
  static async provision(runId: string, candidate: SoftwareCandidate, existingDesktopId?: string, linkedDesktopId?: string): Promise<DaytonaSoftwareAdapter> {
    const sandbox = existingDesktopId ? await daytona().get(existingDesktopId) : await daytona().create({
      name: `software-${runId.slice(0, 12)}-${candidate.id}`, snapshot: candidate.id === "c1" ? "daytona-medium" : "daytona-small",
      public: false, envVars: candidate.id === "c1" ? { VNC_RESOLUTION: "1600x1000" } : {},
      labels: { app: "hollow-purple", purpose: "software-demo", run: runId, candidate: candidate.id }, autoStopInterval: 30,
      autoDeleteInterval: linkedDesktopId ? 0 : -1, ...(linkedDesktopId ? { linkedSandbox: linkedDesktopId } : {}),
    }, { timeout: 180 });
    if (existingDesktopId) assert.ok(sandbox.labels.app === "antibody" && sandbox.labels.purpose === "software-demo", "Unrelated desktop sandbox.");
    const computer = new Computer(sandbox);
    candidate.sandboxId = sandbox.id;
    const runtime = await readFile(join(REPO_ROOT, "lab/software/runtime.py"), "utf8");
    const files: Record<string, string> = { "checkout.py": candidate.source, "runtime.py": runtime,
      "validate.py": await readFile(join(REPO_ROOT, "lab/software/validate.py"), "utf8"), "index.html": await readFile(join(REPO_ROOT, "lab/software/index.html"), "utf8") };
    const created = await computer.exec(`mkdir -p ${APP_DIR}`);
    assert.equal(created.exitCode, 0, "Cannot create software candidate workspace.");
    for (const [name, value] of Object.entries(files)) await computer.writeFile(`${APP_DIR}/${name}`, value);
    const build = await computer.exec("python3 validate.py checkout.py && python3 -m py_compile checkout.py runtime.py && git init -q && git add checkout.py runtime.py index.html validate.py && git -c core.hooksPath=/dev/null -c commit.gpgSign=false -c user.name=Blue -c user.email=blue@local commit --allow-empty -qm 'Software candidate' && git rev-parse HEAD", { cwd: APP_DIR, timeoutSec: 30 });
    if (build.exitCode !== 0) throw new Error(`Software candidate did not build: ${build.output.slice(-1800)}`);
    candidate.commit = build.output.trim().split(/\r?\n/).at(-1);
    const preview = await sandbox.getSignedPreviewUrl(8000, 21600);
    candidate.appUrl = preview.url;
    const adapter = new DaytonaSoftwareAdapter(computer, candidate, preview.url, runtime);
    await adapter.reset();
    return adapter;
  }
  async checked(command: string, cwd = APP_DIR, timeoutSec = 30): Promise<string> {
    const result = await this.computer.exec(command, { cwd, timeoutSec });
    if (result.exitCode !== 0) throw new Error(`Software sandbox command failed: ${result.output.slice(-1800)}`);
    return result.output;
  }
  async reset(): Promise<void> {
    // A fresh process and database are required for every attack replay and acceptance case.
    await this.checked("if [ -f server.pid ]; then candidate_pid=$(cat server.pid); case \"$candidate_pid\" in ''|*[!0-9]*) exit 1;; esac; kill \"$candidate_pid\" 2>/dev/null || true; for round in 1 2 3 4 5; do kill -0 \"$candidate_pid\" 2>/dev/null || break; sleep 0.1; done; fi; python3 runtime.py reset; nohup python3 -u runtime.py serve 8000 >server.log 2>&1 </dev/null & echo $! >server.pid");
    for (let attempt = 0; attempt < 25; attempt++) {
      const result = await this.computer.exec("curl -fsS http://127.0.0.1:8000/healthz", { timeoutSec: 5 });
      if (result.exitCode === 0) {
        const health = JSON.parse(result.output) as { sourceHash: string };
        assert.equal(health.sourceHash, this.candidate.sourceHash);
        return;
      }
      await pause(200);
    }
    throw new Error("The actual candidate web server did not start.");
  }
  async request(input: CheckoutInput): Promise<HttpObservation> {
    let response;
    try { response = await fetch(new URL("/api/checkout", this.appUrl), { method: "POST", headers: { "Content-Type": "application/json", "X-Daytona-Skip-Preview-Warning": "true" }, body: JSON.stringify(input), signal: AbortSignal.timeout(25000) }); }
    catch { throw new Error("Candidate HTTP request failed or timed out."); }
    const text = await response.text();
    assert.ok(text.length < 16384, "Candidate HTTP response exceeded its bound.");
    let body: unknown;
    try { body = JSON.parse(text); } catch { throw new Error("Candidate returned a non-JSON response."); }
    return { status: response.status, body, sourceHash: response.headers.get("X-Candidate-SHA256") ?? "" };
  }
  async observe(): Promise<LedgerSnapshot> {
    const [text, hashes] = await Promise.all([
      this.checked("python3 runtime.py observe"), this.checked("sha256sum checkout.py runtime.py"),
    ]);
    const observed = JSON.parse(text) as LedgerSnapshot;
    assert.ok(hashes.includes(this.candidate.sourceHash) && hashes.includes(this.runtimeHash), "Candidate or trusted runtime changed after deployment.");
    return observed;
  }
  async events(): Promise<ObservedRequest[]> {
    const text = await this.computer.readText(`${APP_DIR}/requests.ndjson`, 128000);
    return text.trim() ? text.trim().split(/\r?\n/).map(line => JSON.parse(line) as ObservedRequest) : [];
  }
  async destroy(): Promise<void> { await this.computer.sandbox.delete(60, true); }

  /** Stable native storefront window; its API requests go to the selected actual candidate. */
  async prepareDesktop(): Promise<void> {
    await this.computer.sandbox.computerUse.start();
    await this.checked(`mkdir -p ${LAB_DIR} /home/daytona/.config/xfce4/terminal`);
    for (const name of ["runtime.py", "index.html", "cdp_relay.py"]) await this.computer.writeFile(`${LAB_DIR}/${name}`, await readFile(join(REPO_ROOT, "lab/software", name)));
    await this.computer.writeFile(`${LAB_DIR}/checkout.py`, this.candidate.source);
    await this.computer.writeFile(`${LAB_DIR}/CONTRACT.txt`, "This actual web app executes in Daytona. Red drives native Chromium through Anchor + noVNC. Orders are persisted in SQLite. The initial backend is an explicitly fault-seeded manual fixture; Blue writes the repair children. Provider keys and the verifier remain outside this machine.\n");
    await this.computer.writeFile("/home/daytona/.config/xfce4/terminal/terminalrc", "[Configuration]\nFontName=Monospace 16\nColorBackground=#11151b\nColorForeground=#e6edf3\nMiscMenubarDefault=FALSE\nMiscBell=FALSE\nScrollingLines=10000\n");
    await this.checked(`cd ${LAB_DIR} && git init -q && git add checkout.py && git -c user.name=Demo -c user.email=demo@local -c commit.gpgSign=false commit --allow-empty -qm 'Explicit manual checkout fixture'`);
    await this.pointDesktopAt(this);
    await this.checked(`nohup python3 -u runtime.py serve 8080 >proxy.log 2>&1 </dev/null & echo $! >proxy.pid`, LAB_DIR);
    await this.checked(`nohup python3 -u cdp_relay.py >cdp-relay.log 2>&1 </dev/null & echo $! >cdp-relay.pid`, LAB_DIR);
    const tools = await this.computer.exec("command -v wmctrl && command -v mousepad");
    if (tools.exitCode !== 0) await this.checked("sudo -n apt-get update -qq && sudo -n DEBIAN_FRONTEND=noninteractive apt-get install -y -qq wmctrl mousepad", APP_DIR, 180);
  }
  async pointDesktopAt(candidate: DaytonaSoftwareAdapter): Promise<void> {
    let url = "http://127.0.0.1:8000";
    if (candidate.computer.id !== this.computer.id) {
      assert.equal(candidate.computer.sandbox.linkedSandboxId, this.computer.id, "The app must belong to this desktop's Daytona link network.");
      assert.match(candidate.computer.sandbox.name, /^[a-zA-Z0-9-]+$/);
      url = `http://${candidate.computer.sandbox.name}:8000`;
    }
    await this.computer.writeFile(`${LAB_DIR}/target.json`, JSON.stringify({ url }));
    await this.computer.writeFile(`${LAB_DIR}/candidate-info.txt`, `Actual Daytona candidate ${candidate.candidate.id}\nSandbox: ${candidate.computer.id}\nSource SHA-256: ${candidate.candidate.sourceHash}\nGit commit: ${candidate.candidate.commit}\n`);
  }
  async launch(command: string): Promise<void> {
    await this.checked(`nohup env DISPLAY=:0 ${command} >${shellQuote(`${LAB_DIR}/desktop-app.log`)} 2>&1 </dev/null &`, LAB_DIR);
  }
}
