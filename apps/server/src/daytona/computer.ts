import type { Sandbox } from "@daytona/sdk";
import { config } from "../config.js";
import { daytona } from "./client.js";

export const SANDBOX_HOME = "/home/daytona";
export const CANDIDATE_DIR = `${SANDBOX_HOME}/candidate`;

function providerFailure(operation: string, error: unknown): Error {
  const value = error && typeof error === "object" ? error as { status?: unknown; statusCode?: unknown; response?: { status?: unknown }; message?: unknown } : undefined;
  const status = value?.status ?? value?.statusCode ?? value?.response?.status;
  const code = typeof status === "number" && Number.isInteger(status) ? ` (HTTP ${status})` : "";
  const timedOut = typeof value?.message === "string" && /timed?\s*out|timeout/i.test(value.message);
  return new Error(`Daytona ${operation} ${timedOut ? "timed out" : "failed"}${code}. Check the Daytona dashboard and configured snapshot.`);
}

/** Quote one shell argument. Never interpolate candidate-controlled text as code. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export class Computer {
  constructor(readonly sandbox: Sandbox) {}
  get id(): string { return this.sandbox.id; }
  async exec(command: string, opts: { cwd?: string; timeoutSec?: number } = {}) {
    try {
      const response = await this.sandbox.process.executeCommand(command, opts.cwd, undefined, opts.timeoutSec ?? 120);
      return { exitCode: response.exitCode, output: response.result ?? "" };
    } catch (error) { throw providerFailure("sandbox command execution", error); }
  }
  async writeFile(path: string, content: string | Buffer): Promise<void> {
    try { await this.sandbox.fs.uploadFile(typeof content === "string" ? Buffer.from(content) : content, path); }
    catch (error) { throw providerFailure("source/artifact upload", error); }
  }
  async readText(path: string, maxBytes = 1_000_000): Promise<string> {
    let details;
    try { details = await this.sandbox.fs.getFileDetails(path); }
    catch (error) { throw providerFailure("artifact metadata request", error); }
    if (details.isDir || details.size > maxBytes) throw new Error(`Sandbox artifact exceeds its ${maxBytes}-byte output budget.`);
    let bytes;
    try { bytes = await this.sandbox.fs.downloadFile(path); }
    catch (error) { throw providerFailure("artifact download", error); }
    if (bytes.length > maxBytes) throw new Error(`Sandbox artifact exceeds its ${maxBytes}-byte output budget.`);
    return bytes.toString("utf8");
  }
}

/** One private sandbox per candidate. Provider credentials stay in the controller. */
export async function provisionCandidate(runId: string, candidateId: string): Promise<Computer> {
  const name = `hollow-${runId.slice(0, 12)}-${candidateId.slice(0, 18)}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  try {
    const sandbox = await daytona().create({
    name,
    snapshot: config.PROD_SNAPSHOT,
    labels: { app: "hollow-purple", run: runId, candidate: candidateId },
    autoStopInterval: config.SANDBOX_AUTO_STOP_MINUTES,
    autoDeleteInterval: config.KEEP_FORKS ? -1 : 0,
    public: false,
    }, { timeout: 180 });
    return new Computer(sandbox);
  } catch (error) { throw providerFailure("candidate provisioning", error); }
}

export async function deleteComputer(sandboxId: string): Promise<void> {
  try { await (await daytona().get(sandboxId)).delete(60, true); }
  catch (error) { throw providerFailure("sandbox deletion", error); }
}
