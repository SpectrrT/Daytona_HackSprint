import type { Sandbox } from "@daytona/sdk";
import type { LabPreview, LabRun, LabSandbox, LabSandboxList } from "@antibody/shared/agent-lab";
import { daytona } from "../daytona/client.js";
import { Computer } from "../daytona/computer.js";
import { APP_DIR, DESKTOP_DIR } from "./adapter.js";

export class SandboxAccessError extends Error {
  constructor(message: string, readonly status: 404 | 409 | 502 = 409) { super(message); }
}
type Resource = Pick<Sandbox, "id" | "name" | "labels" | "state" | "start" | "getSignedPreviewUrl" | "process" | "computerUse" | "fs">;
const statusCode = (error: unknown) => error && typeof error === "object" ? Number((error as { statusCode?: number; status?: number }).statusCode ?? (error as { status?: number }).status) : undefined;

/** Resource identifiers come only from the retained run, never from a client URL or sandbox ID. */
export function sandboxReferences(run: LabRun): LabSandbox[] {
  const result: LabSandbox[] = [];
  for (const workspace of run.roleWorkspaces ?? []) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(workspace.sandboxId) || !["blue", "red"].includes(workspace.role) || result.some(item => item.id === workspace.sandboxId)) continue;
    result.push({ key: workspace.role, role: workspace.role, id: workspace.sandboxId, title: workspace.role === "blue" ? "Blue workspace" : "Red workspace", kind: "desktop", state: workspace.ready ? "unknown" : "starting", canOpen: false, canResume: false, ...(workspace.error ? { detail: workspace.error } : {}) });
  }
  if (run.desktopSandboxId) result.push({ key: "desktop", role: "target", id: run.desktopSandboxId, candidateId: run.candidates.find(candidate => candidate.sandboxId === run.desktopSandboxId)?.id, title: run.roleWorkspaces?.length ? "Target application" : "Live desktop", kind: "desktop", state: "unknown", canOpen: false, canResume: false });
  for (const candidate of run.candidates) if (candidate.sandboxId && !result.some(item => item.id === candidate.sandboxId)) result.push({ key: candidate.id, id: candidate.sandboxId, candidateId: candidate.id, title: candidate.id === run.championId ? "Verified repair" : `Version ${candidate.id.toUpperCase()}`, kind: "app", state: "unknown", canOpen: false, canResume: false });
  return result;
}

export class LabSandboxAccess {
  private readonly opening = new Map<string, Promise<LabPreview>>();
  constructor(private readonly getSandbox: (id: string) => Promise<Resource> = id => daytona().get(id)) {}
  private async owned(run: LabRun, reference: LabSandbox): Promise<Resource> {
    const sandbox = await this.getSandbox(reference.id);
    if (sandbox.id !== reference.id || sandbox.labels.run !== run.id || !["antibody", "hollow-purple"].includes(sandbox.labels.app ?? "")) throw new SandboxAccessError("This sandbox is not owned by this run.", 404);
    if ((reference.role === "blue" || reference.role === "red") && (sandbox.labels.role !== reference.role || sandbox.labels.purpose !== "role-workspace")) throw new SandboxAccessError("This sandbox does not belong to the requested agent role.", 404);
    return sandbox;
  }
  async list(run: LabRun): Promise<LabSandboxList> {
    const sandboxes = await Promise.all(sandboxReferences(run).map(async reference => {
      try {
        const sandbox = await this.owned(run, reference), state = sandbox.state ?? "unknown";
        const ready = !["blue", "red"].includes(reference.role ?? "") || run.roleWorkspaces?.find(item => item.role === reference.role)?.ready;
        return { ...reference, state: state === "started" && !ready ? "starting" : state, canOpen: state === "started" && !!ready, canResume: ["stopped", "archived"].includes(state), ...(state === "archived" ? { detail: "Archived by Daytona. Resume to view the desktop." } : {}) };
      } catch (error) {
        const missing = statusCode(error) === 404 || error instanceof SandboxAccessError && error.status === 404;
        return { ...reference, state: missing ? "deleted" : "unavailable", detail: missing ? "Daytona no longer retains this sandbox. Its test evidence and recording are saved." : "Daytona could not read this sandbox. Retry the connection check." };
      }
    }));
    return { checkedAt: Date.now(), sandboxes };
  }
  async preview(run: LabRun, key: string, resume = false): Promise<LabPreview> {
    const reference = sandboxReferences(run).find(item => item.key === key);
    if (!reference) throw new SandboxAccessError("Sandbox not found in this run.", 404);
    const lock = `${run.id}/${key}`;
    const pending = this.opening.get(lock); if (pending) return pending;
    const task = this.open(run, reference, resume);
    this.opening.set(lock, task);
    try { return await task; } finally { this.opening.delete(lock); }
  }
  private async open(run: LabRun, reference: LabSandbox, resume: boolean): Promise<LabPreview> {
    try {
      const sandbox = await this.owned(run, reference);
      let resumed = false;
      if (sandbox.state !== "started") {
        if (!resume || !["stopped", "archived"].includes(sandbox.state ?? "")) throw new SandboxAccessError("This sandbox is stopped. Use Resume sandbox to open it.");
        await sandbox.start(60);
        resumed = true;
      }
      let note: string | undefined;
      if (reference.kind === "desktop") {
        // A resume restores the OS display. It never resets the database or rewrites a candidate.
        await sandbox.computerUse.start();
        if (resumed && reference.role !== "blue" && reference.role !== "red") {
          const computer = new Computer(sandbox as Sandbox);
          const result = await computer.exec("curl -fsS --max-time 3 http://127.0.0.1:8000/healthz >/dev/null || (nohup python3 -u runtime.py serve 8000 >inspection-server.log 2>&1 </dev/null &)", { cwd: APP_DIR, timeoutSec: 8 });
          if (result.exitCode) throw new SandboxAccessError("The desktop resumed, but its application server could not restart.");
          // The linked repair may have been automatically deleted. Show the preserved original app honestly.
          await computer.writeFile(`${DESKTOP_DIR}/target.json`, JSON.stringify({ url: "http://127.0.0.1:8000" }));
          await computer.exec("curl -fsS --max-time 3 http://127.0.0.1:8080/healthz >/dev/null || (nohup python3 -u runtime.py serve 8080 >inspection-proxy.log 2>&1 </dev/null &)", { cwd: DESKTOP_DIR, timeoutSec: 8 });
          await computer.exec("pgrep -x chromium >/dev/null || (nohup env DISPLAY=:0 chromium --no-sandbox --disable-dev-shm-usage --no-first-run --user-data-dir=/tmp/agent-workbench-chrome --start-maximized http://127.0.0.1:8080/ >inspection-chromium.log 2>&1 </dev/null &)", { cwd: DESKTOP_DIR, timeoutSec: 8 });
          note = "Resumed the preserved original sandbox. The recording shows the original test and repair run.";
        } else if (resumed) {
          const result = await sandbox.process.executeCommand("pgrep -x xfce4-terminal >/dev/null || (nohup env DISPLAY=:0 xfce4-terminal --disable-server --maximize --working-directory=/home/daytona/role-workspace --command='python3 display.py' >terminal.log 2>&1 </dev/null &)", "/home/daytona/role-workspace", undefined, 8);
          if (result.exitCode) throw new SandboxAccessError("The role workspace resumed but its terminal could not reopen.");
          note = `Resumed ${reference.role}’s actual Daytona workspace. Model inference is managed by the controller.`;
        }
      } else if (resumed) {
        const result = await sandbox.process.executeCommand("curl -fsS --max-time 3 http://127.0.0.1:8000/healthz >/dev/null || (nohup python3 -u runtime.py serve 8000 >inspection-server.log 2>&1 </dev/null &)", APP_DIR, undefined, 8);
        if (result.exitCode) throw new SandboxAccessError("The sandbox resumed, but the application server did not restart.");
      }
      const expected = run.candidates.find(candidate => candidate.id === reference.candidateId)?.sourceHash;
      if (expected) {
        const computer = new Computer(sandbox as Sandbox);
        let healthy = false;
        for (let attempt = 0; attempt < 8; attempt++) {
          const response = await computer.exec("python3 -c 'import json,urllib.request; value=json.load(urllib.request.urlopen(\"http://127.0.0.1:8000/healthz\",timeout=3)); print(json.dumps({\"sourceHash\":value[\"sourceHash\"]}))'", { timeoutSec: 5 });
          if (response.exitCode === 0) {
            if (JSON.parse(response.output).sourceHash !== expected) throw new SandboxAccessError("The running application source differs from this run’s saved version. Its preview was not opened.");
            healthy = true; break;
          }
          if (!resumed) break;
          await new Promise(resolve => setTimeout(resolve, 250));
        }
        if (!healthy) throw new SandboxAccessError("The sandbox is running, but its application server is not responding. Retry the sandbox connection.");
      }
      const expiresIn = 3600, preview = await sandbox.getSignedPreviewUrl(reference.kind === "desktop" ? 6080 : 8000, expiresIn);
      const url = new URL(preview.url);
      if (reference.kind === "desktop") { url.pathname = "/vnc.html"; url.searchParams.set("autoconnect", "true"); url.searchParams.set("resize", "scale"); url.searchParams.set("view_only", "true"); }
      return { url: url.toString(), expiresAt: Date.now() + expiresIn * 1000, sandboxId: sandbox.id, kind: reference.kind, ...(note ? { note } : {}) };
    } catch (error) {
      if (error instanceof SandboxAccessError) throw error;
      if (statusCode(error) === 404) throw new SandboxAccessError("Daytona no longer retains this sandbox. Open the saved recording or start a new run.", 404);
      throw new SandboxAccessError("Daytona could not open this sandbox. Check capacity and provider availability, then retry.", 502);
    }
  }
}
