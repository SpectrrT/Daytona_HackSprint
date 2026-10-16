import type { AgentInvocation, ApprovalState, BrowserAudit, Candidate, EvolutionEvent, EvolutionRun, FailureEvidence, ReleaseRecord } from "./evolution";

/**
 * The agents' conversation, rebuilt from a run's append-only event log: what Blue said about each design,
 * what Red hypothesised and attacked with, what ran in Daytona, what the verifier decided, what was learned,
 * and what the human approved. Pure, so the dashboard console and the MCP server render the same story.
 * Model chain-of-thought is never stored by the controller; these are the agents' recorded outputs.
 */

export type Speaker = "blue" | "red" | "daytona" | "verifier" | "memory" | "human" | "anchor" | "system";

export interface TranscriptLine {
  id: string;
  seq: number;
  ts: number;
  speaker: Speaker;
  candidateId?: string;
  /** What was said or done, in the agent's own words where it gave any. */
  text: string;
  /** Short context: model, duration, tokens, counts. */
  meta?: string;
  /** Supporting lines: attack hypotheses, failed checks. */
  details?: string[];
  tone?: "ok" | "fail";
}

export interface ActiveWork {
  speaker: Speaker;
  candidateId: string;
  since: number;
  text: string;
}

const FINAL = new Set<Candidate["status"]>(["verified", "failed", "rejected"]);

export function agentMeta(call: AgentInvocation, extra?: string): string {
  const parts = [call.model, `${(call.durationMs / 1000).toFixed(1)}s`];
  if (call.inputTokens || call.outputTokens) parts.push(`${(call.inputTokens ?? 0).toLocaleString()} in / ${(call.outputTokens ?? 0).toLocaleString()} out tokens`);
  if (call.attempts && call.attempts > 1) parts.push(`${call.attempts} attempts`);
  if (extra) parts.push(extra);
  return parts.join(" · ");
}

export function buildTranscript(run: Pick<EvolutionRun, "events">): TranscriptLine[] {
  const lines: TranscriptLine[] = [];
  const seen = new Map<string, Candidate>();
  let n = 0;
  const say = (e: EvolutionEvent, speaker: Speaker, text: string, extra: Partial<TranscriptLine> = {}) =>
    lines.push({ id: `${e.seq}:${n++}`, seq: e.seq, ts: e.ts, speaker, candidateId: e.candidateId, text, ...extra });

  for (const e of run.events) {
    switch (e.type) {
      case "run.created":
      case "contract.frozen":
      case "run.started":
      case "log":
        say(e, "system", e.message);
        break;
      case "candidate.created": {
        const c = e.payload as Candidate;
        seen.set(c.id, c);
        // Blue's designs start empty; source with no model call is an imported starter, never Blue's work.
        if (c.source && !c.agent) say(e, "system", e.message, { candidateId: c.id, meta: c.label });
        else say(e, "blue", c.parentId ? `Writing repaired design ${c.id}, branching from ${c.parentId}.` : `Writing design ${c.id} from the frozen contract.`, { candidateId: c.id, meta: c.label });
        break;
      }
      case "candidate.updated": {
        const c = e.payload as Candidate;
        const prev = seen.get(c.id);
        seen.set(c.id, c);
        if (c.agent && c.agent.startedAt !== prev?.agent?.startedAt) {
          say(e, "blue", c.rationale ?? `Returned new RTL for ${c.id}.`, { candidateId: c.id, meta: agentMeta(c.agent, `${c.source.length.toLocaleString()} chars of RTL`) });
        }
        if (c.attacks?.length && JSON.stringify(c.attacks.map((a) => a.id)) !== JSON.stringify(prev?.attacks?.map((a) => a.id))) {
          say(e, "red", c.redRationale ?? `Authored ${c.attacks.length} attacks against ${c.id}.`, {
            candidateId: c.id,
            meta: c.redAgent ? agentMeta(c.redAgent, `${c.attacks.length} attacks`) : `${c.attacks.length} attacks`,
            details: c.attacks.map((a) => `${a.name}: ${a.hypothesis} (${a.sequence.length}-cycle input)`),
          });
        }
        if (c.status === "testing" && prev?.status !== "testing") {
          say(e, "daytona", `Compiling ${c.id} with Verilator and replaying every attack${c.sandboxId ? ` in sandbox ${c.sandboxId.slice(0, 8)}` : ""}.`, { candidateId: c.id });
        }
        if (FINAL.has(c.status) && !(prev && FINAL.has(prev.status))) {
          const failed = c.checks.filter((check) => !check.passed);
          const hidden = c.checks.filter((check) => check.hidden).length;
          say(e, "verifier", c.buildError
            ? `${c.id} did not build: ${c.buildError}`
            : c.status === "verified"
              ? `${c.id} passed all ${c.checks.length} checks: directed, Red's attacks, ${hidden} hidden, and ${c.regressionCount ?? 0} inherited regressions.`
              : `${c.id} failed ${failed.length} of ${c.checks.length} checks.`,
          { candidateId: c.id, tone: c.status === "verified" ? "ok" : "fail", details: failed.slice(0, 8).map((check) => `${check.name}: ${check.summary}`) });
        }
        break;
      }
      case "failure.reproduced": {
        const f = e.payload as FailureEvidence;
        say(e, "verifier", f.summary, { tone: "fail", meta: `${f.testName} · cycle ${f.cycle} · expected ${f.expected}, got ${f.actual} · ${f.reproduced ? "independently replayed" : "not reproduced"}` });
        break;
      }
      case "regression.added":
      case "lesson.learned":
        say(e, "memory", e.message);
        break;
      case "champion.selected":
        say(e, "verifier", e.message, { tone: "ok" });
        break;
      case "approval.requested":
      case "approval.decided": {
        const a = e.payload as ApprovalState;
        say(e, "human", e.message, { tone: a.status === "approved" ? "ok" : a.status === "requested" ? undefined : "fail", meta: `${a.channel}${a.conversationId ? ` · conversation ${a.conversationId}` : ""}` });
        break;
      }
      case "design.released": {
        const r = e.payload as ReleaseRecord;
        say(e, "human", e.message, { tone: "ok", meta: `${r.bundlePath} · approved by ${r.approvedVia}` });
        break;
      }
      case "browser.audited": {
        const b = e.payload as BrowserAudit;
        say(e, "anchor", e.message, { tone: b.passed ? "ok" : "fail", details: b.checks.map((check) => `${check.passed ? "passed" : "failed"}: ${check.name}`) });
        break;
      }
      case "run.completed":
        say(e, "system", e.message, { tone: "ok" });
        break;
      case "run.stopped":
      case "run.failed":
        say(e, "system", e.message, { tone: "fail" });
        break;
      default:
        say(e, "system", e.message);
    }
  }
  return lines;
}

/** Who is working right now, and since when: for a live "thinking" line. */
export function activeWork(run: Pick<EvolutionRun, "events" | "status">): ActiveWork | undefined {
  if (run.status !== "running" && run.status !== "queued") return undefined;
  const state = new Map<string, { candidate: Candidate; createdAt: number; blueAt?: number; redAt?: number }>();
  let latest: string | undefined;
  for (const e of run.events) {
    if (e.type !== "candidate.created" && e.type !== "candidate.updated") continue;
    const c = e.payload as Candidate;
    const entry = state.get(c.id) ?? { candidate: c, createdAt: e.ts };
    if (c.agent && !entry.candidate.agent) entry.blueAt = e.ts;
    if (c.attacks?.length && !entry.candidate.attacks?.length) entry.redAt = e.ts;
    entry.candidate = c;
    state.set(c.id, entry);
    latest = c.id;
  }
  const current = latest ? state.get(latest) : undefined;
  if (!current || FINAL.has(current.candidate.status)) return undefined;
  const c = current.candidate;
  if (!c.agent && c.generation >= 0 && !c.source) return { speaker: "blue", candidateId: c.id, since: current.createdAt, text: `Blue is writing ${c.id}` };
  if (!c.attacks?.length) return { speaker: "red", candidateId: c.id, since: current.blueAt ?? current.createdAt, text: `Red is reading ${c.id}'s RTL and hunting for a failure` };
  return { speaker: "daytona", candidateId: c.id, since: current.redAt ?? current.createdAt, text: `Daytona is compiling ${c.id} and replaying ${c.attacks.length} attacks` };
}

const LABEL: Record<Speaker, string> = { blue: "BLUE", red: "RED", daytona: "DAYTONA", verifier: "VERIFIER", memory: "MEMORY", human: "HUMAN", anchor: "ANCHOR", system: "LAB" };

/** Plain-text rendering for terminals and MCP clients. */
export function formatTranscript(lines: TranscriptLine[]): string {
  return lines.map((line) => {
    const time = new Date(line.ts).toISOString().slice(11, 19);
    const head = `[${time}] ${LABEL[line.speaker].padEnd(8)}${line.candidateId ? ` ${line.candidateId}` : ""}${line.tone === "ok" ? " ✓" : line.tone === "fail" ? " ✗" : ""}`;
    const body = [`${head}  ${line.text}`];
    if (line.meta) body.push(`           (${line.meta})`);
    for (const detail of line.details ?? []) body.push(`           - ${detail}`);
    return body.join("\n");
  }).join("\n");
}
