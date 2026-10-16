/** Public contract between the controller, independent lab, and dashboard. */
export type ExecutionProvider = "local" | "daytona";
export type CandidateVariant = "baseline" | "reset-leak" | "full-drop" | "repair-count" | "repair-atomic" | "generated";
export type RunStatus = "queued" | "running" | "completed" | "stopped" | "failed";
export type CandidateStatus = "queued" | "building" | "testing" | "failed" | "verified" | "rejected";

/** Shared requirements for an engineering task; execution interfaces belong to each example. */
export interface EngineeringContract {
  id: string;
  version: number;
  title: string;
  prompt: string;
  hash: string;
  rules: { id: string; title: string; description: string }[];
  acceptance: string[];
  frozenAt: number;
}
/** First working example: the FIFO hardware contract. */
export interface FrozenContract extends EngineeringContract {
  version: 1;
  depth: 32;
  width: 16;
  interface: { name: string; direction: "input" | "output"; width: number; description: string }[];
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
  role: "blue" | "red" | "target";
  provider: "codex-cli" | "anthropic" | "bedrock";
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
export type EvolutionEventType = "run.created" | "contract.frozen" | "run.started" | "candidate.created" | "candidate.updated" | "failure.reproduced" | "regression.added" | "lesson.learned" | "champion.selected" | "run.completed" | "run.stopped" | "run.failed" | "browser.audited" | "approval.requested" | "approval.decided" | "design.released" | "log";
/** Release gate: a verified champion ships only after a human says yes: by voice or phone (ElevenLabs), or in the dashboard. */
export type ApprovalChannel = "voice" | "phone" | "dashboard";
export interface ApprovalState {
  status: "requested" | "approved" | "declined" | "failed";
  channel: ApprovalChannel;
  candidateId: string;
  requestedAt: number;
  decidedAt?: number;
  conversationId?: string;
  detail?: string;
}
export interface ReleaseRecord {
  candidateId: string;
  label: string;
  sourceHash: string;
  contractHash: string;
  regressions: number;
  checks: number;
  approvedVia: ApprovalChannel;
  releasedAt: number;
  /** Relative to the data directory. */
  bundlePath: string;
}
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
  /** Opt-in bounded repair chain with fresh Red audits after a passing design. */
  recursive?: { maxEvaluations: number; challengePasses: number };
  approval?: ApprovalState;
  release?: ReleaseRecord;
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
  agentProvider?: "codex-cli" | "anthropic" | "bedrock";
  agentsReady?: boolean;
  agentModel?: string;
  defaultProvider?: ExecutionProvider;
  readOnly?: boolean;
  approvalChannel?: ApprovalChannel;
  approvalChannels?: ApprovalChannel[];
}
export interface CreateRunRequest { prompt: string; provider: ExecutionProvider; maxCandidates?: number; seed?: number }
export const BUFFER_PROMPT = "Design a hardware buffer for 32 sensor readings. Preserve their order, signal when full, support simultaneous reading and writing, and empty correctly on reset.";
