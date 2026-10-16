import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config, REPO_ROOT } from "../config.js";
import type { AgentInvocation } from "@antibody/shared/evolution";

export type Attributes = Record<string, string | number | boolean | undefined>;
export interface SpanRecord { traceId: string; spanId: string; parentSpanId?: string; name: string; startedAt: number; endedAt: number; status: "ok" | "error"; attributes: Record<string, string | number | boolean> }
const allowed = /^(?:hollow\.(?:run_id|candidate_id|generation|role|provider|backend|score|checks_passed|checks_total|regressions|cycles|reproduced|attempts|source_hash|recorded_evidence|run_status)|llm\.(?:provider|system|model_name|token_count\.(?:prompt|completion))|openinference\.span\.kind)$/;
export function safeAttributes(values: Attributes): SpanRecord["attributes"] {
  return Object.fromEntries(Object.entries(values).filter(([key, value]) => allowed.test(key) && value !== undefined && (typeof value !== "number" || Number.isFinite(value))).map(([key, value]) => [key, typeof value === "string" ? value.slice(0, 200) : value!])) as SpanRecord["attributes"];
}
const hash = (text: string, length: number) => createHash("sha256").update(text).digest("hex").slice(0, length);
let queued = Promise.resolve();
const counts = { pending: 0, submitted: 0, failed: 0 };
export const telemetryStatus = () => ({ enabled: config.ARIZE_ENABLED && !!config.ARIZE_API_KEY && !!config.ARIZE_SPACE_ID, project: "hollow-purple", ...counts });

async function exportRecord(record: SpanRecord): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(config.ARIZE_PYTHON ?? join(REPO_ROOT, "data/telemetry-venv/bin/python"), [join(REPO_ROOT, "telemetry/arize_worker.py")], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ARIZE_API_KEY: config.ARIZE_API_KEY!, ARIZE_SPACE_ID: config.ARIZE_SPACE_ID!, OTEL_EXPORTER_OTLP_TIMEOUT: "15" }, stdio: ["pipe", "pipe", "ignore"],
    });
    let output = "", settled = false;
    const finish = (ok: boolean) => { if (settled) return; settled = true; clearTimeout(timer); resolve(ok); };
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish(false); }, 25000);
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); if (output.length > 65536) { child.kill("SIGKILL"); finish(false); } });
    child.on("error", () => finish(false));
    child.on("close", (code) => { try { finish(code === 0 && JSON.parse(output).status === "submitted"); } catch { finish(false); } });
    child.stdin.on("error", () => {}); child.stdin.end(JSON.stringify(record));
  });
}
export async function submitSpan(record: SpanRecord): Promise<void> {
  if (!telemetryStatus().enabled || process.env.NODE_TEST_CONTEXT) return;
  const path = join(config.DATA_DIR, "telemetry", `${record.spanId}.json`);
  await mkdir(join(config.DATA_DIR, "telemetry"), { recursive: true, mode: 0o700 });
  const safe = { ...record, attributes: safeAttributes(record.attributes) };
  await writeFile(path, JSON.stringify({ status: "pending", record: safe }), { mode: 0o600 });
  counts.pending++;
  queued = queued.then(async () => {
    const ok = await exportRecord(safe); counts.pending--; counts[ok ? "submitted" : "failed"]++;
    await writeFile(path, JSON.stringify({ status: ok ? "submitted" : "failed", record: safe }), { mode: 0o600 });
  }).catch(() => { counts.failed++; });
}
export async function flushTelemetry(): Promise<void> { await queued; }
export function agentAttributes(agent: Partial<AgentInvocation>): Attributes {
  return { "llm.provider": agent.provider === "bedrock" ? "aws" : agent.provider, "llm.system": agent.provider === "bedrock" || agent.provider === "anthropic" ? "anthropic" : "openai", "hollow.provider": agent.provider, "llm.model_name": agent.model, "llm.token_count.prompt": agent.inputTokens, "llm.token_count.completion": agent.outputTokens, "hollow.attempts": agent.attempts };
}

/** Application errors remain errors; telemetry cannot change a model or checker verdict. */
export async function traced<T>(role: "blue" | "red" | "target" | "lesson_writer" | "verifier" | "run", runId: string, attrs: Attributes, task: () => Promise<T>, resultAttrs: (value: T) => Attributes = () => ({})): Promise<T> {
  if (!telemetryStatus().enabled || process.env.NODE_TEST_CONTEXT) return task();
  const startedAt = Date.now();
  const root = hash(`${runId}:root`, 16);
  const record: SpanRecord = { traceId: hash(runId, 32), spanId: role === "run" ? root : randomBytes(8).toString("hex"), parentSpanId: role === "run" ? undefined : root,
    name: `antibody.${role}`, startedAt, endedAt: startedAt, status: "ok", attributes: safeAttributes({ "hollow.run_id": runId, "hollow.role": role, "openinference.span.kind": ["blue", "red", "target", "lesson_writer"].includes(role) ? "LLM" : "CHAIN", ...attrs }) };
  try {
    const result = await task(); record.attributes = safeAttributes({ ...record.attributes, ...resultAttrs(result) }); return result;
  } catch (error) { record.status = "error"; throw error; }
  finally { record.endedAt = Date.now(); await submitSpan(record).catch(() => { counts.failed++; }); }
}
