// Hand-written mirror of contracts/models.py — the Python models are the source of truth.
// Change both in the same commit (and run `make contracts` to refresh contracts/schemas/).

export interface AttackSpec {
  id: string;
  family: string;
  type: string;
  params: Record<string, unknown>;
  seed: number;
  parent_id: string | null;
  generation: number;
  held_out: boolean;
}

export type TrustSource = "app_db" | "provider";
export type TicketPolicy = "follow" | "facts_only" | "ignore";
export type Permission = "db.read" | "tickets.read" | "payments.refund" | "payments.status" | "outbox.send";

export interface Knobs {
  idempotency_key: boolean;
  verify_before_retry: boolean;
  max_retries: number;
  trust_source: TrustSource;
  ticket_policy: TicketPolicy;
  per_order_lock: boolean;
  per_customer_cap: number | null;
}

export interface BluePlan {
  id: string;
  generation: number;
  parent_id: string | null;
  selection_sql: string;
  knobs: Knobs;
  permissions: Permission[];
  lessons_used: string[];
}

export interface WorldResult {
  world_id: string;
  generation: number;
  attack_id: string | null; // null = clean control world
  plan_id: string;
  dollars_over: number;
  dollars_missed: number;
  duplicate_refunds: number;
  injections_followed: number;
  task_complete: boolean;
  breached: boolean;
  false_alarm: boolean;
  seconds: number;
  sandbox_id: string;
  preview_url: string | null;
}

export interface Lesson {
  id: string;
  generation: number;
  attack_id: string;
  world_id: string;
  text: string;
}

export interface GenStarted {
  run_id: string;
  generation: number;
  exam: boolean;
  backend: "fake" | "daytona";
  plan: BluePlan;
  attacks: AttackSpec[];
  clean_worlds: number;
}

export interface WorldForked {
  world_id: string;
  generation: number;
  attack_id: string | null;
  sandbox_id: string;
}

export interface GenDone {
  generation: number;
  exam: boolean;
  mode: "parallel" | "sequential";
  attack_worlds: number;
  survived: number;
  clean_worlds: number;
  false_alarms: number;
  dollars_lost: number;
  seconds: number;
}

export interface ExamDone {
  generation: number;
  passed: boolean;
  attack_worlds: number;
  breaches: number;
  clean_worlds: number;
  false_alarms: number;
}

export interface CallStatus {
  status: "dialing" | "ringing" | "in_progress" | "approved" | "declined" | "failed" | "skipped";
  conversation_id: string | null;
  detail: string | null;
}

export interface ProdCommitted {
  plan_id: string;
  snapshot: string;
  refunds_issued: number;
  dollars_refunded: number;
  preview_url: string | null;
}

export interface EventPayloads {
  "gen.started": GenStarted;
  "world.forked": WorldForked;
  "world.graded": WorldResult;
  "lesson.filed": Lesson;
  "gen.done": GenDone;
  "exam.done": ExamDone;
  "call.status": CallStatus;
  "prod.committed": ProdCommitted;
}

export type EventType = keyof EventPayloads;

export type ArenaEvent = {
  [K in EventType]: { ts: number; type: K; payload: EventPayloads[K] };
}[EventType];
