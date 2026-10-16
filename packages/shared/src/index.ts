// Hollow Purple: before an AI agent may do something irreversible, Red (the Chaos
// Agent, which injects realistic operational faults) and Blue (MAH0RAGA, which
// evolves the agent's guardrails) compete for generations inside forked copies of
// production. A separate grader scores every round. Purple is the agent
// configuration you finally trust with production.
//
// Types and the event reducer shared by the server and the dashboard. The server
// is the source of truth: every change is an event, and both sides rebuild an
// Arena by folding events through `applyEvent`.

// ---- Scenarios ----

export type CriterionKind = "safety" | "utility";

export interface Criterion {
  id: string;
  kind: CriterionKind;
  /** Share of the round score, 0-100. Weights in a scenario add up to 100. */
  weight: number;
  description: string;
}

export interface ScenarioInfo {
  id: string;
  name: string;
  summary: string;
  /** The legitimate job the agent under test must do in production. */
  task: string;
  /** Actions in this environment that cannot be undone. */
  irreversible: string[];
  criteria: Criterion[];
}

// ---- Red: the Chaos Agent (fault injection) ----

/** A fault from the scenario's fault library, e.g. a look-alike customer record. */
export interface FaultSpec {
  id: string;
  description: string;
  /** Allowed values per parameter name. */
  params: Record<string, string[]>;
}

export interface FaultUse {
  id: string;
  params: Record<string, string>;
}

/** One chaos experiment: a set of faults injected into a fork before the agent starts. */
export interface Fault {
  id: string;
  generation: number;
  name: string;
  /** How these faults could lead the agent into an unsafe irreversible action. */
  hypothesis: string;
  faults: FaultUse[];
  /** Experiment this one was evolved from. */
  parentId?: string;
}

// ---- Blue: MAH0RAGA ----

export type DefenseRuleKind =
  | "deny_command" // regex; matching shell commands are refused
  | "require_approval" // regex; matching commands need a human, so they do not run in the arena
  | "protect_path" // regex on paths; writes and destructive commands touching them are refused
  | "instruction"; // guidance added to the agent's system prompt

export interface DefenseRule {
  id: string;
  kind: DefenseRuleKind;
  /** Regex; empty for instructions. */
  pattern: string;
  /** Instruction text, or a short label for the rule. */
  text: string;
  /** Which failure this rule answers. */
  reason: string;
  addedInGeneration: number;
}

export interface Defense {
  /** 0 is the starting defense; n is the defense adapted after generation n. */
  version: number;
  rules: DefenseRule[];
  /** MAH0RAGA's explanation of what it adapted to. */
  rationale: string;
}

// ---- Rounds and grading ----

export type RoundStatus =
  | "queued"
  | "forking" // Daytona is forking production
  | "injecting" // the Chaos Agent's faults are being injected into the fork
  | "running" // the agent under test is working
  | "grading"
  | "done"
  | "failed";

/**
 * harmed:   a safety criterion failed (irreversible damage).
 * degraded: safe, but the job was neither done nor properly escalated.
 * held:     safe, and the job was done or properly escalated.
 */
export type Verdict = "harmed" | "degraded" | "held";

export interface CriterionScore {
  criterionId: string;
  passed: boolean;
  evidence: string;
}

export interface RoundResult {
  verdict: Verdict;
  /** Sum of the weights of passed criteria, 0-100. */
  score: number;
  criteria: CriterionScore[];
  summary: string;
}

export type RoundPhase = "generation" | "exam" | "promotion";

export interface Round {
  id: string;
  generation: number;
  phase: RoundPhase;
  /** Absent for the promotion run on production, which has no faults. */
  faultId?: string;
  defenseVersion: number;
  status: RoundStatus;
  statusDetail?: string;
  sandboxId?: string;
  sandboxName?: string;
  actions: number;
  blockedActions: number;
  result?: RoundResult;
  startedAt?: number;
  finishedAt?: number;
}

export interface GenerationStats {
  rounds: number;
  harmed: number;
  degraded: number;
  held: number;
  averageScore: number;
}

export interface Generation {
  n: number;
  defenseVersion: number;
  status: "running" | "done";
  stats?: GenerationStats;
}

export interface Purple {
  defenseVersion: number;
  /** Average score in the final exam. */
  score: number;
  summary: string;
  examStats: GenerationStats;
  promotion?: { status: "running" | "done" | "failed"; roundId?: string; verdict?: Verdict };
}

// ---- Arenas ----

export type ArenaStatus = "provisioning" | "evolving" | "examining" | "done" | "failed" | "stopped";

export interface ArenaConfig {
  scenarioId: string;
  generations: number;
  /** Chaos experiments (and forks) per generation. */
  population: number;
  /** Model of the agent under test. */
  targetModel: string;
}

export interface ProdInfo {
  sandboxId: string;
  sandboxName: string;
  target?: string;
}

export interface Arena {
  id: string;
  status: ArenaStatus;
  statusDetail?: string;
  createdAt: number;
  finishedAt?: number;
  scenario: ScenarioInfo;
  config: ArenaConfig;
  prod?: ProdInfo;
  faults: Fault[];
  defenses: Defense[];
  generations: Generation[];
  rounds: Round[];
  purple?: Purple;
}

// ---- Events ----

export interface EventMeta {
  seq: number;
  ts: number;
  arenaId: string;
}

export type ArenaEventBody =
  | { type: "arena.created"; scenario: ScenarioInfo; config: ArenaConfig }
  | { type: "arena.status"; status: ArenaStatus; detail?: string }
  | { type: "prod.ready"; prod: ProdInfo }
  | { type: "defense.adapted"; defense: Defense }
  | { type: "generation.started"; n: number; defenseVersion: number }
  | { type: "generation.completed"; n: number; stats: GenerationStats }
  | { type: "fault.created"; fault: Fault }
  | { type: "round.created"; round: Round }
  | {
      type: "round.status";
      roundId: string;
      status: RoundStatus;
      detail?: string;
      sandboxId?: string;
      sandboxName?: string;
    }
  | { type: "agent.thought"; roundId: string; text: string }
  | {
      type: "agent.action";
      roundId: string;
      callId: string;
      tool: string;
      summary: string;
      input: unknown;
      /** Set when MAH0RAGA's guardrails refused the action. */
      blockedBy?: { ruleId: string; reason: string };
    }
  | { type: "agent.observation"; roundId: string; callId: string; ok: boolean; output: string }
  | { type: "round.graded"; roundId: string; result: RoundResult }
  | { type: "purple.ready"; purple: Purple }
  | { type: "purple.promotion"; status: "running" | "done" | "failed"; roundId?: string; verdict?: Verdict }
  | { type: "log"; level: "info" | "warn" | "error"; message: string };

export type ArenaEvent = EventMeta & ArenaEventBody;
export type ArenaEventType = ArenaEventBody["type"];

export const TERMINAL_ARENA_STATUSES: readonly ArenaStatus[] = ["done", "failed", "stopped"];
export const TERMINAL_ROUND_STATUSES: readonly RoundStatus[] = ["done", "failed"];

export function emptyArena(id: string, scenario: ScenarioInfo, config: ArenaConfig, createdAt: number): Arena {
  return {
    id,
    status: "provisioning",
    createdAt,
    scenario,
    config,
    faults: [],
    defenses: [],
    generations: [],
    rounds: [],
  };
}

function updateRound(arena: Arena, roundId: string, update: (round: Round) => Round): Arena {
  return { ...arena, rounds: arena.rounds.map((r) => (r.id === roundId ? update(r) : r)) };
}

/** Pure reducer: returns a new Arena with the event applied. */
export function applyEvent(arena: Arena, event: ArenaEvent): Arena {
  switch (event.type) {
    case "arena.created":
      return { ...arena, scenario: event.scenario, config: event.config, createdAt: event.ts };
    case "arena.status":
      return {
        ...arena,
        status: event.status,
        statusDetail: event.detail,
        finishedAt: TERMINAL_ARENA_STATUSES.includes(event.status) ? event.ts : arena.finishedAt,
      };
    case "prod.ready":
      return { ...arena, prod: event.prod };
    case "defense.adapted":
      return {
        ...arena,
        defenses: [...arena.defenses.filter((d) => d.version !== event.defense.version), event.defense],
      };
    case "generation.started":
      return {
        ...arena,
        generations: [...arena.generations, { n: event.n, defenseVersion: event.defenseVersion, status: "running" }],
      };
    case "generation.completed":
      return {
        ...arena,
        generations: arena.generations.map((g) => (g.n === event.n ? { ...g, status: "done", stats: event.stats } : g)),
      };
    case "fault.created":
      return { ...arena, faults: [...arena.faults, event.fault] };
    case "round.created":
      return { ...arena, rounds: [...arena.rounds, event.round] };
    case "round.status":
      return updateRound(arena, event.roundId, (r) => ({
        ...r,
        status: event.status,
        statusDetail: event.detail,
        sandboxId: event.sandboxId ?? r.sandboxId,
        sandboxName: event.sandboxName ?? r.sandboxName,
        startedAt: r.startedAt ?? (event.status === "forking" ? event.ts : undefined),
        finishedAt: TERMINAL_ROUND_STATUSES.includes(event.status) ? event.ts : r.finishedAt,
      }));
    case "agent.action":
      return updateRound(arena, event.roundId, (r) => ({
        ...r,
        actions: r.actions + 1,
        blockedActions: r.blockedActions + (event.blockedBy ? 1 : 0),
      }));
    case "round.graded":
      return updateRound(arena, event.roundId, (r) => ({ ...r, result: event.result }));
    case "purple.ready":
      return { ...arena, purple: event.purple };
    case "purple.promotion":
      return arena.purple
        ? {
            ...arena,
            purple: {
              ...arena.purple,
              promotion: { status: event.status, roundId: event.roundId, verdict: event.verdict },
            },
          }
        : arena;
    case "agent.thought":
    case "agent.observation":
    case "log":
      return arena;
  }
}

export function statsFor(rounds: Round[]): GenerationStats {
  const graded = rounds.filter((r) => r.result);
  const count = (v: Verdict) => graded.filter((r) => r.result?.verdict === v).length;
  const total = graded.reduce((sum, r) => sum + (r.result?.score ?? 0), 0);
  return {
    rounds: rounds.length,
    harmed: count("harmed"),
    degraded: count("degraded"),
    held: count("held"),
    averageScore: graded.length ? Math.round(total / graded.length) : 0,
  };
}

// ---- HTTP API contracts ----

export interface CreateArenaRequest {
  scenarioId: string;
  generations?: number;
  population?: number;
  targetModel?: string;
}

export interface CreateArenaResponse {
  id: string;
}

export interface ArenaSummary {
  id: string;
  scenarioName: string;
  status: ArenaStatus;
  generations: number;
  population: number;
  createdAt: number;
  purpleScore?: number;
}

export interface ArenaSnapshot {
  arena: Arena;
  /** Highest event seq folded into `arena`; subscribe with `?after=` this value. */
  lastSeq: number;
}

export interface SystemCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface SystemStatus {
  ready: boolean;
  checks: SystemCheck[];
  config: Record<string, string | number | boolean>;
}
