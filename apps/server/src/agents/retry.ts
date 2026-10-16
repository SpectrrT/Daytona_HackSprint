import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AgentCallError, runCodexStructured, type AgentAnswer, type AgentFailureCategory, type CodexCall } from "./codex.js";

const retryable = new Set<AgentFailureCategory>(["network", "service", "rate_limit", "unknown"]);

/** At most two processes share one time budget. No model, prompt, or schema is substituted. */
export async function runCodexWithRetry(input: CodexCall, call = runCodexStructured): Promise<AgentAnswer> {
  const deadline = Date.now() + input.timeoutMs;
  if (!Number.isFinite(input.timeoutMs) || input.timeoutMs < 1) throw new Error("Agent timeout must be positive.");
  const attempts: { attempt: number; durationMs: number; status: string; failureCategory?: AgentFailureCategory }[] = [];
  await mkdir(input.artifactPath, { recursive: true, mode: 0o700 });
  const persist = () => writeFile(join(input.artifactPath, "attempts.json"), JSON.stringify(attempts, null, 2), { mode: 0o600 });
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (input.signal?.aborted) throw new AgentCallError("aborted", `${input.role} model call was stopped.`);
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new AgentCallError("timeout", `${input.role} model call exceeded its time budget.`);
    const started = Date.now();
    try {
      const result = await call({ ...input, timeoutMs: remaining, artifactPath: join(input.artifactPath, `attempt-${attempt}`) });
      attempts.push({ attempt, durationMs: Date.now() - started, status: "responded" });
      await persist();
      return { ...result, agent: { ...result.agent, attempts: attempt } };
    } catch (error) {
      attempts.push({ attempt, durationMs: Date.now() - started, status: error instanceof AgentCallError ? error.reason : "process_error",
        failureCategory: error instanceof AgentCallError ? error.failureCategory : undefined });
      await persist();
      if (!(error instanceof AgentCallError) || error.reason !== "process_error" ||
          !retryable.has(error.failureCategory ?? "unknown") || attempt === 2) throw error;
    }
  }
  throw new Error("Agent attempts exhausted.");
}
