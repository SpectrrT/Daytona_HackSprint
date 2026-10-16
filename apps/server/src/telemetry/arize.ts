import { context, SpanStatusCode, trace, type Attributes, type Span, type SpanContext, type Tracer } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BasicTracerProvider, BatchSpanProcessor, SimpleSpanProcessor, type SpanExporter } from "@opentelemetry/sdk-trace-base";
import { z } from "zod";
import type { AgentInvocation, ApprovalState, Candidate, EvolutionEvent, EvolutionRun, ReleaseRecord } from "@hollow-purple/shared/evolution";
import "../config.js"; // loads .env before the variables below are read
import type { RunStore } from "../store.js";

/**
 * Arize AX tracing, built from the run's event log (no engine changes):
 *   run (CHAIN) ─ candidate (CHAIN) ─ blue / red model call (LLM)
 *               └ release gate (approval and release, after the run completes)
 * Verifier verdicts land on candidate spans as attributes and status, so Arize shows every model call next to
 * what the independent verifier decided about its output. Disabled unless ARIZE_SPACE_ID and ARIZE_API_KEY are set.
 */

const optional = z.string().optional().transform((v) => (v && v.trim() ? v.trim() : undefined));
const env = z
  .object({
    ARIZE_SPACE_ID: optional,
    ARIZE_API_KEY: optional,
    ARIZE_PROJECT_NAME: z.string().default("antibody"),
    ARIZE_OTLP_URL: z.string().default("https://otlp.arize.com/v1/traces"),
  })
  .parse(process.env);

export const arizeConfigured = (): boolean => Boolean(env.ARIZE_SPACE_ID && env.ARIZE_API_KEY);

const FINAL = new Set<Candidate["status"]>(["verified", "failed", "rejected"]);

/** Drop undefined values: OpenTelemetry attributes must be primitives. */
function attrs(values: Record<string, string | number | boolean | undefined>): Attributes {
  return Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined)) as Attributes;
}

export class RunTracer {
  private readonly runs = new Map<string, Span>();
  private readonly runContexts = new Map<string, SpanContext>();
  private readonly candidates = new Map<string, Span>();
  private readonly agentCalls = new Set<string>();

  constructor(private readonly tracer: Tracer) {}

  handle(event: EvolutionEvent): void {
    switch (event.type) {
      case "run.created": {
        const run = event.payload as Omit<EvolutionRun, "events">;
        const span = this.tracer.startSpan(`run ${run.id}`, {
          startTime: event.ts,
          attributes: attrs({
            "openinference.span.kind": "CHAIN",
            "input.value": run.prompt,
            "run.id": run.id,
            "run.provider": run.provider,
            "run.strategy": run.strategy ?? "curriculum",
            "run.contract_hash": run.contract.hash,
            "run.budget.max_candidates": run.budget.maxCandidates,
          }),
        });
        this.runs.set(event.runId, span);
        this.runContexts.set(event.runId, span.spanContext());
        break;
      }
      case "candidate.created": {
        const c = event.payload as Candidate;
        const span = this.tracer.startSpan(`candidate ${c.label}`, {
          startTime: event.ts,
          attributes: attrs({ "openinference.span.kind": "CHAIN", "candidate.id": c.id, "candidate.generation": c.generation, "candidate.parent_id": c.parentId, "candidate.variant": c.variant }),
        }, this.under(this.runs.get(event.runId)?.spanContext()));
        this.candidates.set(`${event.runId}:${c.id}`, span);
        break;
      }
      case "candidate.updated": {
        const c = event.payload as Candidate;
        const key = `${event.runId}:${c.id}`;
        const span = this.candidates.get(key);
        if (!span) break;
        this.agentCall(event.runId, c, "blue", c.agent, c.rationale);
        this.agentCall(event.runId, c, "red", c.redAgent, [c.redRationale, ...(c.attacks ?? []).map((a) => `${a.name}: ${a.hypothesis}`)].filter(Boolean).join("\n"));
        if (!FINAL.has(c.status)) break;
        const passed = c.checks.filter((check) => check.passed).length;
        span.setAttributes(attrs({
          "candidate.status": c.status,
          "candidate.score": c.score,
          "verifier.checks_passed": passed,
          "verifier.checks_total": c.checks.length,
          "verifier.hidden_checks_passed": c.checks.filter((check) => check.hidden && check.passed).length,
          "verifier.regressions_inherited": c.regressionCount,
          "candidate.source_hash": c.sourceHash,
          "candidate.backend": c.backend,
          "candidate.cycles": c.cycles,
          "candidate.build_error": c.buildError,
          "output.value": c.failure?.summary ?? `${passed}/${c.checks.length} checks passed`,
        }));
        span.setStatus(c.status === "verified" ? { code: SpanStatusCode.OK } : { code: SpanStatusCode.ERROR, message: c.buildError ?? c.failure?.summary ?? c.status });
        span.end(event.ts);
        this.candidates.delete(key);
        break;
      }
      case "failure.reproduced":
      case "regression.added":
      case "lesson.learned":
      case "champion.selected":
        this.runs.get(event.runId)?.addEvent(event.type, attrs({ message: event.message, "candidate.id": event.candidateId }), event.ts);
        break;
      case "run.completed":
      case "run.stopped":
      case "run.failed": {
        for (const [key, open] of this.candidates) if (key.startsWith(`${event.runId}:`)) { open.end(event.ts); this.candidates.delete(key); }
        const span = this.runs.get(event.runId);
        if (!span) break;
        span.setAttributes(attrs({ "run.status": event.type.slice(4), "output.value": event.message }));
        span.setStatus(event.type === "run.completed" ? { code: SpanStatusCode.OK } : { code: SpanStatusCode.ERROR, message: event.message });
        span.end(event.ts);
        this.runs.delete(event.runId);
        break;
      }
      case "approval.requested":
      case "approval.decided":
      case "design.released": {
        // The run span has ended; the release gate gets its own short spans under the same trace.
        const payload = event.payload as ApprovalState | ReleaseRecord;
        const span = this.tracer.startSpan(`release gate: ${event.type}`, {
          startTime: event.ts,
          attributes: attrs({
            "openinference.span.kind": "CHAIN",
            "output.value": event.message,
            "approval.status": "status" in payload ? payload.status : undefined,
            "approval.channel": "channel" in payload ? payload.channel : "approvedVia" in payload ? payload.approvedVia : undefined,
            "release.source_hash": "sourceHash" in payload ? payload.sourceHash : undefined,
          }),
        }, this.under(this.runContexts.get(event.runId)));
        span.end(event.ts);
        break;
      }
      default:
        break;
    }
  }

  private under(parent: SpanContext | undefined) {
    return parent ? trace.setSpanContext(context.active(), parent) : context.active();
  }

  private agentCall(runId: string, c: Candidate, role: "blue" | "red", call: AgentInvocation | undefined, output: string | undefined): void {
    if (!call) return;
    const id = `${runId}:${c.id}:${role}:${call.startedAt}`;
    if (this.agentCalls.has(id)) return;
    this.agentCalls.add(id);
    const span = this.tracer.startSpan(`${role} ${call.model}`, {
      startTime: call.startedAt,
      attributes: attrs({
        "openinference.span.kind": "LLM",
        "llm.model_name": call.model,
        "llm.provider": call.provider,
        "llm.token_count.prompt": call.inputTokens,
        "llm.token_count.completion": call.outputTokens,
        "agent.role": role,
        "agent.attempts": call.attempts,
        "candidate.id": c.id,
        "output.value": output,
      }),
    }, this.under(this.candidates.get(`${runId}:${c.id}`)?.spanContext()));
    span.end(call.startedAt + call.durationMs);
  }
}

export interface Telemetry {
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

/** Starts tracing every run's events. Pass an exporter in tests; otherwise needs the Arize variables. */
export function startArizeTracing(store: RunStore, exporter?: SpanExporter): Telemetry | undefined {
  if (!exporter && !arizeConfigured()) return undefined;
  const processor = exporter
    ? new SimpleSpanProcessor(exporter)
    : new BatchSpanProcessor(new OTLPTraceExporter({ url: env.ARIZE_OTLP_URL, headers: { space_id: env.ARIZE_SPACE_ID!, api_key: env.ARIZE_API_KEY! } }));
  const provider = new BasicTracerProvider({
    resource: resourceFromAttributes({ "service.name": "antibody-lab", "openinference.project.name": env.ARIZE_PROJECT_NAME, model_id: env.ARIZE_PROJECT_NAME }),
    spanProcessors: [processor],
  });
  const tracer = new RunTracer(provider.getTracer("antibody-lab"));
  const stop = store.observe((event) => {
    try { tracer.handle(event); } catch (error) { console.warn("[arize]", error instanceof Error ? error.message : error); }
  });
  return {
    flush: () => provider.forceFlush(),
    shutdown: async () => { stop(); await provider.shutdown(); },
  };
}
