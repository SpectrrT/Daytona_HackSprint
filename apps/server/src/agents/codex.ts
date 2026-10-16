import { spawn } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentInvocation } from "@hollow-purple/shared/evolution";

const MAX_PROCESS_BYTES = 2 * 1024 * 1024;
const MAX_FINAL_BYTES = 256 * 1024;
const safeModel = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,119}$/;
const safeSession = /^[a-zA-Z0-9_-]{1,100}$/;
const ENV_KEYS = ["PATH", "HOME", "CODEX_HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "TERM", "USER", "LOGNAME", "SYSTEMROOT", "WINDIR", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS"] as const;

/** Intentionally excludes all application credentials and parent agent session settings. */
export function codexChildEnv(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const allowed: NodeJS.ProcessEnv = {};
  for (const key of ENV_KEYS) if (environment[key] !== undefined) allowed[key] = environment[key];
  return allowed;
}

export type AgentFailureCategory = "usage_limit" | "authentication" | "rate_limit" | "network" | "service" | "invalid_schema" | "content_policy" | "unknown";

/** Diagnostic input stays in memory. The only output is a fixed allowlisted category. */
export function classifyCodexFailure(diagnostic: string): AgentFailureCategory {
  const value = diagnostic.slice(0, 16_384).toLowerCase();
  if (/content (?:was |has been )?flagged|flagged for (?:possible )?cybersecurity|content[_ -]?policy|cyber permissive safeguards/.test(value)) return "content_policy";
  if (/usage[_ -]?limit|insufficient[_ -]?quota|quota (?:exceeded|exhausted)|out of credits|credit balance|billing[_ -]?hard[_ -]?limit/.test(value)) return "usage_limit";
  if (/unauthori[sz]ed|authentication|invalid[_ -]?(?:api[_ -]?key|token)|token[_ -](?:has[_ -])?expired|expired[_ -](?:access[_ -])?token|login required|sign[ -]?in required|http[^\n]{0,12}401\b|status[^\n]{0,12}401\b/.test(value)) return "authentication";
  if (/rate[_ -]?limit|too many requests|http[^\n]{0,12}429\b|status[^\n]{0,12}429\b/.test(value)) return "rate_limit";
  if (/invalid[_ -]?(?:json[_ -]?)?schema|schema (?:validation|is invalid)|unsupported schema|output.schema[^\n]{0,40}(?:invalid|unsupported|rejected)/.test(value)) return "invalid_schema";
  if (/network|connection[_ -](?:error|failed|reset|refused|closed)|stream[_ -]disconnected|transport[_ -]error|timed[_ -]out|econnreset|econnrefused|etimedout|enotfound|eai_again|getaddrinfo|fetch[_ -]failed|dns[_ -](?:error|failure)/.test(value)) return "network";
  if (/service[_ -]?unavailable|internal[_ -]?server[_ -]?error|server[_ -]error|server[_ -]overloaded|overloaded_error|http[^\n]{0,12}5\d\d\b|status[^\n]{0,12}5\d\d\b/.test(value)) return "service";
  return "unknown";
}
const FAILURE_MESSAGES: Record<AgentFailureCategory, string> = {
  content_policy: "The model service declined this request under its content policy.",
  usage_limit: "Codex account usage limit reached.",
  authentication: "Codex authentication failed.",
  rate_limit: "Codex request rate limit reached.",
  network: "Codex connection failed.",
  service: "Codex service reported an error.",
  invalid_schema: "Codex rejected the structured output schema.",
  unknown: "Codex subprocess failed; no supported diagnostic category was identified.",
};

export class AgentCallError extends Error {
  constructor(readonly reason: "timeout" | "aborted" | "output_limit" | "process_error" | "invalid_response", message: string, readonly failureCategory?: AgentFailureCategory) { super(message); this.name = "AgentCallError"; }
}
export interface CodexCall {
  binary: string; role: AgentInvocation["role"]; prompt: string; schema: Record<string, unknown>; artifactPath: string;
  timeoutMs: number; model?: string; signal?: AbortSignal;
}
export interface AgentAnswer { answer: unknown; agent: AgentInvocation }

/** Uses the installed CLI's saved auth without opening or copying credential files. */
export async function runCodexStructured(input: CodexCall): Promise<AgentAnswer> {
  input.signal?.throwIfAborted();
  if (!Number.isFinite(input.timeoutMs) || input.timeoutMs < 1) throw new Error("Agent timeout must be positive.");
  await mkdir(input.artifactPath, { recursive: true, mode: 0o700 });
  const schemaPath = join(input.artifactPath, "schema.json");
  const resultPath = join(input.artifactPath, "response.raw.json");
  await writeFile(schemaPath, JSON.stringify(input.schema), { mode: 0o600 });
  await writeFile(join(input.artifactPath, "prompt.txt"), input.prompt, { mode: 0o600 });
  const startedAt = Date.now();
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let reportedModel: string | undefined;
  let sessionId: string | undefined;
  let diagnosticCategory: AgentFailureCategory = "unknown";
  let diagnosticPriority = 0;
  const diagnose = (diagnostic: string, priority: number) => {
    const category = classifyCodexFailure(diagnostic);
    if (category !== "unknown" && priority >= diagnosticPriority) { diagnosticCategory = category; diagnosticPriority = priority; }
  };
  const processFailure = () => new AgentCallError("process_error", `${input.role} agent: ${FAILURE_MESSAGES[diagnosticCategory]}`, diagnosticCategory);
  const invocation = (): AgentInvocation => ({ role: input.role, provider: "codex-cli", model: reportedModel ?? input.model ?? "codex-default", startedAt, durationMs: Date.now() - startedAt, inputTokens, outputTokens, sessionId, artifactPath: input.artifactPath });
  const args = ["exec", "-s", "read-only", "--ephemeral", "--skip-git-repo-check", "--ignore-user-config", "-C", input.artifactPath,
    "-c", "features.shell_tool=false", "-c", "features.hooks=false", "-c", "features.apps=false", "-c", "features.remote_plugin=false", "-c", "features.multi_agent=false", "-c", "features.shell_snapshot=false", "-c", 'web_search="disabled"',
    "--output-schema", schemaPath, "--output-last-message", resultPath, "--json"];
  if (input.model) args.push("--model", input.model);
  args.push("-");
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(input.binary, args, { cwd: input.artifactPath, env: codexChildEnv(), shell: false, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
      let outputBytes = 0;
      let stdoutBuffer = "";
      let stderrBuffer = "";
      let failure: AgentCallError | undefined;
      let finished = false;
      let forceKill: NodeJS.Timeout | undefined;
      let hardStop: NodeJS.Timeout | undefined;
      const kill = (signal: NodeJS.Signals) => {
        try { if (child.pid && process.platform !== "win32") process.kill(-child.pid, signal); else child.kill(signal); }
        catch { try { child.kill(signal); } catch { /* Process has already exited. */ } }
      };
      const cleanup = () => { clearTimeout(timeout); if (forceKill) clearTimeout(forceKill); if (hardStop) clearTimeout(hardStop); input.signal?.removeEventListener("abort", onAbort); };
      const finish = (error?: Error) => { if (finished) return; finished = true; cleanup(); error ? reject(error) : resolve(); };
      const terminate = (error: AgentCallError) => {
        if (failure || finished) return;
        failure = error; kill("SIGTERM");
        forceKill = setTimeout(() => kill("SIGKILL"), 1000);
        hardStop = setTimeout(() => { kill("SIGKILL"); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); finish(error); }, 2000);
      };
      const onAbort = () => terminate(new AgentCallError("aborted", `${input.role} model call was stopped.`));
      const timeout = setTimeout(() => terminate(new AgentCallError("timeout", `${input.role} model call exceeded its time budget.`)), input.timeoutMs);
      input.signal?.addEventListener("abort", onAbort, { once: true });
      if (input.signal?.aborted) onAbort();
      const count = (chunk: Buffer): boolean => {
        outputBytes += chunk.byteLength;
        if (outputBytes > MAX_PROCESS_BYTES) { terminate(new AgentCallError("output_limit", `${input.role} model call exceeded its output budget.`)); return false; }
        return !failure;
      };
      const metadata = (line: string) => {
        let value: Record<string, unknown>;
        try { value = JSON.parse(line) as Record<string, unknown>; } catch { return; }
        if (!value || typeof value !== "object" || Array.isArray(value)) return;
        if (value.type === "thread.started" && typeof value.thread_id === "string" && safeSession.test(value.thread_id)) sessionId = value.thread_id;
        if (value.type === "turn.started" && typeof value.model === "string" && safeModel.test(value.model)) reportedModel = value.model;
        if (value.type === "error" || value.type === "turn.failed") {
          for (const field of [value.message, value.code, value.error]) {
            if (typeof field === "string") diagnose(field, 2);
            else if (field && typeof field === "object" && !Array.isArray(field)) {
              const detail = field as Record<string, unknown>;
              for (const part of [detail.message, detail.code, detail.type]) if (typeof part === "string") diagnose(part, 2);
            }
          }
        }
        if (value.type === "turn.completed" && value.usage && typeof value.usage === "object") {
          const usage = value.usage as Record<string, unknown>;
          if (Number.isSafeInteger(usage.input_tokens) && Number(usage.input_tokens) >= 0) inputTokens = (inputTokens ?? 0) + Number(usage.input_tokens);
          if (Number.isSafeInteger(usage.output_tokens) && Number(usage.output_tokens) >= 0) outputTokens = (outputTokens ?? 0) + Number(usage.output_tokens);
        }
        // All item/tool/reasoning events are discarded; raw stdout never reaches logs or disk.
      };
      child.stdout.on("data", (chunk: Buffer) => {
        if (!count(chunk)) return;
        stdoutBuffer += chunk.toString("utf8");
        let newline: number;
        while ((newline = stdoutBuffer.indexOf("\n")) >= 0) { metadata(stdoutBuffer.slice(0, newline)); stdoutBuffer = stdoutBuffer.slice(newline + 1); }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (!count(chunk)) return;
        stderrBuffer += chunk.toString("utf8");
        let newline: number;
        while ((newline = stderrBuffer.indexOf("\n")) >= 0) {
          const line = stderrBuffer.slice(0, newline); stderrBuffer = stderrBuffer.slice(newline + 1);
          diagnose(line, 1);
        }
        if (stderrBuffer.length > 4096) { diagnose(stderrBuffer, 1); stderrBuffer = ""; }
      });
      child.on("error", () => finish(new AgentCallError("process_error", `Could not launch ${input.role} Codex agent. Check CODEX_BIN and 'codex login status'.`)));
      child.on("close", (code) => {
        if (failure) { kill("SIGKILL"); return finish(failure); }
        if (stdoutBuffer) metadata(stdoutBuffer);
        if (stderrBuffer) diagnose(stderrBuffer, 1);
        finish(code === 0 ? undefined : processFailure());
      });
      child.stdin.on("error", () => {});
      child.stdin.end(input.prompt);
    });
    if ((await stat(resultPath)).size > MAX_FINAL_BYTES) throw new AgentCallError("output_limit", `${input.role} final answer exceeded its size budget.`);
    let answer: unknown;
    try { answer = JSON.parse(await readFile(resultPath, "utf8")); }
    catch { throw new AgentCallError("invalid_response", `${input.role} model did not return valid structured JSON.`); }
    const agent = invocation();
    await writeFile(join(input.artifactPath, "invocation.json"), JSON.stringify({ ...agent, status: "responded" }, null, 2), { mode: 0o600 });
    return { answer, agent };
  } catch (error) {
    const reason = error instanceof AgentCallError ? error.reason : "process_error";
    const failureCategory = error instanceof AgentCallError ? error.failureCategory ?? diagnosticCategory : diagnosticCategory;
    await writeFile(join(input.artifactPath, "invocation.json"), JSON.stringify({ ...invocation(), status: reason, failureCategory }, null, 2), { mode: 0o600 });
    throw error instanceof AgentCallError
      ? new AgentCallError(error.reason, error.message, failureCategory)
      : new AgentCallError("process_error", `${input.role} agent: ${FAILURE_MESSAGES[failureCategory]}`, failureCategory);
  } finally {
    await rm(resultPath, { force: true });
  }
}
