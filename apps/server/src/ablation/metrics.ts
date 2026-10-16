import type { Trial } from "./trial.js";
import { MODES, type MemoryMode } from "./memory.js";
const median = (values: number[]) => { if (!values.length) return null; const sorted = [...values].sort((a, b) => a - b); const i = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[i]! : (sorted[i - 1]! + sorted[i]!) / 2; };
export function summarizeTrials(trials: Trial[]) {
  return MODES.map(mode => {
    const group = trials.filter(t => t.mode === mode); const evaluated = group.flatMap(t => t.evaluations);
    const completed = group.filter(t => t.status === "completed");
    const accepted = completed.filter(t => t.generationsUntilAllGates !== null);
    const first = group.flatMap(t => t.evaluations.length ? [t.evaluations[0]!] : []);
    const calls = evaluated.flatMap(e => [e.blue, e.red]);
    const tokensComplete = calls.length > 0 && calls.every(c => c.inputTokens !== undefined && c.outputTokens !== undefined);
    const tokens = tokensComplete ? calls.reduce((s, c) => s + c.inputTokens! + c.outputTokens!, 0) : null;
    return { mode, trials: group.length, completedTrials: completed.length, missingTrials: group.filter(t => t.status === "missing").length,
      heldOut: { passed: evaluated.filter(e => e.result.checks.some(c => c.id === "held-out" && c.hidden && c.passed)).length, evaluated: evaluated.filter(e => e.result.checks.some(c => c.id === "held-out" && c.hidden)).length },
      transfer: { passed: first.filter(e => e.result.checks.some(c => c.id === "transfer-empty-boundary" && c.hidden && c.passed)).length, evaluated: first.filter(e => e.result.checks.some(c => c.id === "transfer-empty-boundary" && c.hidden)).length },
      acceptedDesigns: accepted.length, medianGenerationsUntilAllGates: median(accepted.map(t => t.generationsUntilAllGates!)), censoredTrials: completed.length - accepted.length,
      regressionsReintroduced: group.reduce((n, t) => n + t.regressionsReintroduced, 0), totalModelTokens: tokens,
      modelTokensPerAcceptedDesign: accepted.length && tokens !== null ? tokens / accepted.length : null,
      wallMsPerAcceptedDesign: accepted.length ? group.reduce((n, t) => n + t.wallMs, 0) / accepted.length : null,
    };
  });
}
export type ArmSummary = ReturnType<typeof summarizeTrials>[number];
export function formatMetrics(summary: ArmSummary[]): string {
  const count = (v: {passed: number; evaluated: number}) => v.evaluated ? `${v.passed}/${v.evaluated}` : "missing";
  const labels: Record<MemoryMode, string> = { none: "A Claude alone", flat: "B Raw retrieval", graph: "C Lesson graph" };
  const rows = summary.map(s => `| ${labels[s.mode]} | ${count(s.heldOut)} | ${count(s.transfer)} | ${s.medianGenerationsUntilAllGates ?? "missing"} (${s.censoredTrials} censored) | ${s.regressionsReintroduced} | ${s.modelTokensPerAcceptedDesign === null ? "missing" : Math.round(s.modelTokensPerAcceptedDesign)} | ${s.wallMsPerAcceptedDesign === null ? "missing" : (s.wallMsPerAcceptedDesign / 1000).toFixed(1)} | ${s.missingTrials} |`);
  return ["| Arm | Held-out pass | First-try unseen sibling | Median generations | Regressions | Tokens / accepted | Seconds / accepted | Missing trials |", "|---|---|---|---|---|---|---|---|", ...rows,
    `Held-out pass: ${summary.map((s, i) => `${"ABC"[i]} ${count(s.heldOut)}`).join(", ")}. Never-seen family: ${summary.map((s, i) => `${"ABC"[i]} ${count(s.transfer)}`).join(", ")}.`,
  ].join("\n");
}
