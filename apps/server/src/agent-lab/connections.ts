import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { LabConnection, LabConnections } from "@antibody/shared/agent-lab";
import { config } from "../config.js";
import { daytona } from "../daytona/client.js";
import { checkAnchorKey } from "../browser/anchor.js";
import { codexChildEnv } from "../agents/codex.js";

export class LabConnectionChecks {
  private cached?: LabConnections;
  private pending?: Promise<LabConnections>;
  async get(): Promise<LabConnections> {
    if (this.cached && Date.now() - this.cached.checkedAt < 60_000) return this.cached;
    if (this.pending) return this.pending;
    this.pending = this.check();
    try { return this.cached = await this.pending; } finally { this.pending = undefined; }
  }
  private async check(): Promise<LabConnections> {
    const probe = async (id: LabConnection["id"], name: string, configured: boolean, check: () => Promise<unknown>, detail: string): Promise<LabConnection> => {
      if (!configured) return { id, name, state: "missing", detail: `${name} is not configured.` };
      try { await check(); return { id, name, state: "connected", detail }; }
      catch { return { id, name, state: "error", detail: `${name} did not respond successfully. Check credentials, account limits, and provider availability.` }; }
    };
    const [daytonaStatus, anchor] = await Promise.all([
      probe("daytona", "Daytona", !!config.DAYTONA_API_KEY, async () => {
        const snapshot = await daytona().snapshot.get(config.PROD_SNAPSHOT);
        if (snapshot.state !== "active") throw new Error("Snapshot unavailable");
      }, "API authentication verified. Capacity is checked when a sandbox starts."),
      probe("anchor", "Anchor", !!config.ANCHOR_API_KEY, checkAnchorKey, "Browser API authentication verified. A browser session opens during a run."),
    ]);
    let agents: LabConnection;
    if (config.AGENT_PROVIDER === "codex-cli") {
      try {
        await promisify(execFile)(config.CODEX_BIN, ["login", "status"], { timeout: 5000, maxBuffer: 32_768, env: codexChildEnv() });
        agents = { id: "agents", name: "Agents", state: "authenticated", detail: "Codex CLI is signed in. Blue, Red, and the target run as separate model invocations; inference is verified during each run." };
      } catch { agents = { id: "agents", name: "Agents", state: "error", detail: "Codex CLI is unavailable or signed out." }; }
    } else {
      const configured = config.AGENT_PROVIDER === "anthropic" ? !!config.ANTHROPIC_API_KEY : !!config.BEDROCK_CREDENTIALS_FILE;
      agents = { id: "agents", name: "Agents", state: configured && config.BLUE_MODEL && config.RED_MODEL ? "configured" : "missing", detail: configured ? `${config.AGENT_PROVIDER} is configured. Model calls are verified during each run; this check does not perform inference.` : "The selected model provider is not configured." };
    }
    const connections = [daytonaStatus, anchor, agents];
    return { checkedAt: Date.now(), ready: connections.every(item => ["connected", "authenticated", "configured"].includes(item.state)), connections };
  }
}
