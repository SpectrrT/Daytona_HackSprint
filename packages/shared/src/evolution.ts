/** Public contract between the controller, independent lab, and dashboard. */
export type ExecutionProvider = "local" | "daytona";
export type CandidateVariant = "baseline" | "reset-leak" | "full-drop" | "repair-count" | "repair-atomic" | "generated";
export type RunStatus = "queued" | "running" | "completed" | "stopped" | "failed";
export type CandidateStatus = "queued" | "building" | "testing" | "failed" | "verified" | "rejected";

export interface FrozenContract {
  id: string;
  version: 1;
  title: string;
  prompt: string;
  hash: string;
  depth: 32;
  width: 16;
  interface: { name: string; direction: "input" | "output"; width: number; description: string }[];
  rules: { id: string; title: string; description: string }[];
  acceptance: string[];
  frozenAt: number;
}
export interface Stimulus { reset: boolean; write: boolean; read: boolean; data: number }
export interface TraceSample extends Stimulus {
  cycle: number;
  expected: number | null;
  actual: number | null;
  occupancy: number;
  /** Observed count; occupancy above is the oracle's expected count. */
  actualOccupancy?: number;
  full: boolean;
  empty: boolean;
  mismatch: boolean;
}
export interface FailureEvidence {
  id: string;
  testId: string;
  testName: string;
  seed: number;
  cycle: number;
  expected: number | null;
  actual: number | null;
  summary: string;
  sequence: Stimulus[];
  trace: TraceSample[];
  reproduced: boolean;
}
export interface CheckResult {
  id: string;
  name: string;
  passed: boolean;
  cycles: number;
  hidden: boolean;
  summary: string;
}
export interface EvaluationResult {
  checks: CheckResult[];
  failure?: FailureEvidence;
  cycles: number;
  sandboxId?: string;
  artifactPath?: string;
  source: string;
  backend: "model" | "verilator";
  reproduced: boolean;
  buildError?: string;
  sourceHash?: string;
}
export interface AgentInvocation {
  role: "blue" | "red";
  provider: "codex-cli" | "anthropic";
  model: string;
  startedAt: number;
  durationMs: number;
  inputTokens?: number;
  outputTokens?: number;
  attempts?: number;
  artifactPath?: string;
  sessionId?: string;
}
export interface RedAttack { id: string; name: string; hypothesis: string; sequence: Stimulus[] }
export interface BlueProposal { label: string; source: string; rationale: string; agent: AgentInvocation }
export interface RedProposal { attacks: RedAttack[]; rationale: string; agent: AgentInvocation }
export interface Candidate {
  id: string;
  parentId?: string;
  generation: number;
  label: string;
  variant: CandidateVariant;
  status: CandidateStatus;
  source: string;
  checks: CheckResult[];
  failure?: FailureEvidence;
  score: number;
  lessons: string[];
  sandboxId?: string;
  artifactPath?: string;
  backend?: "model" | "verilator";
  cycles: number;
  createdAt: number;
  agent?: AgentInvocation;
  redAgent?: AgentInvocation;
  rationale?: string;
  redRationale?: string;
  attacks?: RedAttack[];
  buildError?: string;
  sourceHash?: string;
  regressionCount?: number;
}
export type EvolutionEventType = "run.created" | "contract.frozen" | "run.started" | "candidate.created" | "candidate.updated" | "failure.reproduced" | "regression.added" | "lesson.learned" | "champion.selected" | "run.completed" | "run.stopped" | "run.failed" | "browser.audited" | "log";
export interface EvolutionEvent {
  seq: number;
  ts: number;
  runId: string;
  type: EvolutionEventType;
  message: string;
  candidateId?: string;
  payload?: unknown;
}
export interface BrowserAudit {
  sessionId: string;
  passed: boolean;
  summary: string;
  liveViewUrl?: string;
  checks: { name: string; passed: boolean }[];
  screenshotPath?: string;
  verifiedAt?: number;
}
export interface EvolutionRun {
  id: string;
  prompt: string;
  provider: ExecutionProvider;
  status: RunStatus;
  contract: FrozenContract;
  candidates: Candidate[];
  regressions: FailureEvidence[];
  events: EvolutionEvent[];
  championId?: string;
  createdAt: number;
  finishedAt?: number;
  budget: { maxCandidates: number; maxCycles: number; usedCandidates: number; usedCycles: number };
  summary?: string;
  error?: string;
  browserAudit?: BrowserAudit;
  strategy?: "agents" | "curriculum";
  /** Explicitly imported faulty integration fixture; never attributed to Blue. */
  verificationFixture?: boolean;
}
export interface RunSummary {
  id: string;
  prompt: string;
  provider: ExecutionProvider;
  status: RunStatus;
  createdAt: number;
  candidates: number;
  championId?: string;
}
export interface EvolutionSystem {
  providers: { daytona: boolean; anchor: boolean; model: boolean };
  publicDashboardUrl?: string;
  checks?: { name: string; ok: boolean; detail: string }[];
  agentProvider?: "codex-cli" | "anthropic";
  agentsReady?: boolean;
  agentModel?: string;
  defaultProvider?: ExecutionProvider;
  readOnly?: boolean;
}
export interface CreateRunRequest { prompt: string; provider: ExecutionProvider; maxCandidates?: number; seed?: number }
export const BUFFER_PROMPT = "Design a hardware buffer for 32 sensor readings. Preserve their order, signal when full, support simultaneous reading and writing, and empty correctly on reset.";
