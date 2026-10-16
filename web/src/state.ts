// The one place ArenaEvents become UI state.
//
// `reduce` is a pure function: (state, event) -> new state. Live mode and replay both feed events
// through it, so a recorded run renders exactly like the live one. Views must render from
// ArenaState (plus the selectors at the bottom of this file) and nothing else.

import type {
  ArenaEvent,
  AttackSpec,
  BluePlan,
  CallStatus,
  ExamDone,
  GenDone,
  Lesson,
  ProdCommitted,
  WorldResult,
} from "./contracts";

export type Backend = "fake" | "daytona";

/** red = breached, green = defended, gray = clean control, amber = false alarm. */
export type WorldStatus = "pending" | "breached" | "defended" | "clean" | "false_alarm";

export interface WorldState {
  id: string;
  /** Key of the generation this world belongs to (see genKey). */
  genKey: string;
  generation: number;
  attackId: string | null; // null = clean control world
  sandboxId: string;
  forkedAt: number | null;
  gradedAt: number | null;
  result: WorldResult | null;
  status: WorldStatus;
}

export interface GenerationState {
  key: string; // "gen-2" or "exam-4"
  generation: number;
  exam: boolean;
  runId: string;
  backend: Backend | null;
  planId: string | null;
  attackIds: string[]; // the attacks announced in gen.started, in order
  cleanWorlds: number; // expected clean control worlds
  worldIds: string[];
  lessonIds: string[];
  startedAt: number | null;
  done: GenDone | null; // the parallel summary (the real one)
  sequential: GenDone | null; // an A8 timing re-run, for the speedup chart only
}

export interface CallStep extends CallStatus {
  ts: number;
}

export interface ArenaState {
  runId: string | null;
  /** Backend of the latest gen.started; "fake" means dev data. */
  backend: Backend | null;
  generations: Record<string, GenerationState>;
  genOrder: string[]; // in order of first appearance; use orderedGenerations() for display order
  /** generation number -> key of the most recently started generation with that number. */
  genKeyByNumber: Record<number, string>;
  worlds: Record<string, WorldState>;
  worldOrder: string[];
  attacks: Record<string, AttackSpec>;
  attackOrder: string[];
  plans: Record<string, BluePlan>;
  planOrder: string[];
  lessons: Record<string, Lesson>;
  lessonOrder: string[];
  exam: ExamDone | null;
  calls: CallStep[];
  prod: ProdCommitted | null;
  prodAt: number | null;
  eventCount: number;
  firstTs: number | null;
  lastTs: number | null;
}

export const initialArenaState: ArenaState = {
  runId: null,
  backend: null,
  generations: {},
  genOrder: [],
  genKeyByNumber: {},
  worlds: {},
  worldOrder: [],
  attacks: {},
  attackOrder: [],
  plans: {},
  planOrder: [],
  lessons: {},
  lessonOrder: [],
  exam: null,
  calls: [],
  prod: null,
  prodAt: null,
  eventCount: 0,
  firstTs: null,
  lastTs: null,
};

export function genKey(generation: number, exam: boolean): string {
  return `${exam ? "exam" : "gen"}-${generation}`;
}

export function worldStatus(attackId: string | null, result: WorldResult | null): WorldStatus {
  if (!result) return "pending";
  if (result.breached) return "breached";
  if (attackId === null) return result.false_alarm ? "false_alarm" : "clean";
  return "defended";
}

// ------------------------------------------------------------------------------------------------
// Reducer
// ------------------------------------------------------------------------------------------------

export function reduce(prev: ArenaState, event: ArenaEvent): ArenaState {
  // A gen.started from a different run means a new run began on the live stream: start over.
  const base =
    event.type === "gen.started" && prev.runId !== null && event.payload.run_id !== prev.runId
      ? initialArenaState
      : prev;
  const s: ArenaState = {
    ...base,
    eventCount: base.eventCount + 1,
    firstTs: base.firstTs ?? event.ts,
    lastTs: event.ts,
  };

  switch (event.type) {
    case "gen.started": {
      const p = event.payload;
      const key = genKey(p.generation, p.exam);
      let next = upsertPlan(s, p.plan);
      for (const a of p.attacks) next = upsertAttack(next, a);
      const existing = next.generations[key];
      const gen: GenerationState = {
        ...(existing ?? emptyGeneration(key, p.generation, p.exam, p.run_id)),
        runId: p.run_id,
        backend: p.backend,
        planId: p.plan.id,
        attackIds: union(existing?.attackIds ?? [], p.attacks.map((a) => a.id)),
        cleanWorlds: p.clean_worlds,
        startedAt: existing?.startedAt ?? event.ts,
      };
      next = putGeneration(next, gen);
      return {
        ...next,
        runId: p.run_id,
        backend: p.backend,
        genKeyByNumber: { ...next.genKeyByNumber, [p.generation]: key },
      };
    }

    case "world.forked": {
      const p = event.payload;
      const [next, gen] = ensureGeneration(s, p.generation);
      const world: WorldState = {
        id: p.world_id,
        genKey: gen.key,
        generation: p.generation,
        attackId: p.attack_id,
        sandboxId: p.sandbox_id,
        forkedAt: event.ts,
        gradedAt: null,
        result: null,
        status: "pending",
      };
      return putWorld(next, gen, world);
    }

    case "world.graded": {
      const r = event.payload;
      const [next, gen] = ensureGeneration(s, r.generation);
      const existing = next.worlds[r.world_id];
      const world: WorldState = {
        id: r.world_id,
        genKey: existing?.genKey ?? gen.key,
        generation: r.generation,
        attackId: r.attack_id,
        sandboxId: r.sandbox_id,
        forkedAt: existing?.forkedAt ?? null,
        gradedAt: event.ts,
        result: r,
        status: worldStatus(r.attack_id, r),
      };
      return putWorld(next, next.generations[world.genKey] ?? gen, world);
    }

    case "lesson.filed": {
      const l = event.payload;
      const [next, gen] = ensureGeneration(s, l.generation);
      const lessons = { ...next.lessons, [l.id]: l };
      const lessonOrder = next.lessons[l.id] ? next.lessonOrder : [...next.lessonOrder, l.id];
      return putGeneration({ ...next, lessons, lessonOrder }, { ...gen, lessonIds: union(gen.lessonIds, [l.id]) });
    }

    case "gen.done": {
      const p = event.payload;
      const key = genKey(p.generation, p.exam);
      const gen = s.generations[key] ?? emptyGeneration(key, p.generation, p.exam, s.runId ?? "");
      return putGeneration(s, p.mode === "sequential" ? { ...gen, sequential: p } : { ...gen, done: p });
    }

    case "exam.done":
      return { ...s, exam: event.payload };

    case "call.status":
      return { ...s, calls: [...s.calls, { ...event.payload, ts: event.ts }] };

    case "prod.committed":
      return { ...s, prod: event.payload, prodAt: event.ts };

    default:
      // Unknown event types (a newer backend) are counted and otherwise ignored.
      return s;
  }
}

export function foldEvents(events: readonly ArenaEvent[], start: ArenaState = initialArenaState): ArenaState {
  return events.reduce(reduce, start);
}

// ------------------------------------------------------------------------------------------------
// Reducer helpers (all return new objects; never mutate)
// ------------------------------------------------------------------------------------------------

function emptyGeneration(key: string, generation: number, exam: boolean, runId: string): GenerationState {
  return {
    key,
    generation,
    exam,
    runId,
    backend: null,
    planId: null,
    attackIds: [],
    cleanWorlds: 0,
    worldIds: [],
    lessonIds: [],
    startedAt: null,
    done: null,
    sequential: null,
  };
}

function union(a: string[], b: string[]): string[] {
  const out = [...a];
  for (const x of b) if (!out.includes(x)) out.push(x);
  return out;
}

function putGeneration(s: ArenaState, gen: GenerationState): ArenaState {
  const genOrder = s.generations[gen.key] ? s.genOrder : [...s.genOrder, gen.key];
  return { ...s, generations: { ...s.generations, [gen.key]: gen }, genOrder };
}

/** World/lesson events carry only a generation number; attach them to the latest generation with it. */
function ensureGeneration(s: ArenaState, generation: number): [ArenaState, GenerationState] {
  const key = s.genKeyByNumber[generation] ?? genKey(generation, false);
  const existing = s.generations[key];
  if (existing) return [s, existing];
  const gen = emptyGeneration(key, generation, false, s.runId ?? "");
  const next = putGeneration(s, gen);
  return [{ ...next, genKeyByNumber: { ...next.genKeyByNumber, [generation]: key } }, gen];
}

function putWorld(s: ArenaState, gen: GenerationState, world: WorldState): ArenaState {
  const worldOrder = s.worlds[world.id] ? s.worldOrder : [...s.worldOrder, world.id];
  const next = { ...s, worlds: { ...s.worlds, [world.id]: world }, worldOrder };
  return gen.worldIds.includes(world.id) ? next : putGeneration(next, { ...gen, worldIds: [...gen.worldIds, world.id] });
}

function upsertAttack(s: ArenaState, a: AttackSpec): ArenaState {
  const attackOrder = s.attacks[a.id] ? s.attackOrder : [...s.attackOrder, a.id];
  return { ...s, attacks: { ...s.attacks, [a.id]: a }, attackOrder };
}

function upsertPlan(s: ArenaState, p: BluePlan): ArenaState {
  const planOrder = s.plans[p.id] ? s.planOrder : [...s.planOrder, p.id];
  return { ...s, plans: { ...s.plans, [p.id]: p }, planOrder };
}

// ------------------------------------------------------------------------------------------------
// Selectors (derived data shared by the views)
// ------------------------------------------------------------------------------------------------

/** Training generations by number, then exam generations. This is the chain order. */
export function orderedGenerations(s: ArenaState): GenerationState[] {
  return s.genOrder
    .map((k) => s.generations[k])
    .sort((a, b) => Number(a.exam) - Number(b.exam) || a.generation - b.generation);
}

export function genLabel(g: Pick<GenerationState, "generation" | "exam">): string {
  return g.exam ? "Exam" : `Gen ${g.generation}`;
}

export function worldsOf(s: ArenaState, g: GenerationState): WorldState[] {
  return g.worldIds.map((id) => s.worlds[id]).filter((w): w is WorldState => Boolean(w));
}

export interface GenStats {
  attackWorlds: number;
  survived: number;
  breaches: number;
  cleanWorlds: number;
  falseAlarms: number;
  dollarsLost: number;
  seconds: number | null;
  graded: number; // worlds graded so far
  total: number; // worlds expected
  /** True until the parallel gen.done arrives; numbers are then counted from graded worlds. */
  provisional: boolean;
}

export function genStats(s: ArenaState, g: GenerationState): GenStats {
  const worlds = worldsOf(s, g);
  const graded = worlds.filter((w) => w.result !== null);
  const expected = Math.max(g.attackIds.length + g.cleanWorlds, worlds.length);
  if (g.done) {
    return {
      attackWorlds: g.done.attack_worlds,
      survived: g.done.survived,
      breaches: g.done.attack_worlds - g.done.survived,
      cleanWorlds: g.done.clean_worlds,
      falseAlarms: g.done.false_alarms,
      dollarsLost: g.done.dollars_lost,
      seconds: g.done.seconds,
      graded: graded.length,
      total: expected,
      provisional: false,
    };
  }
  const attackGraded = graded.filter((w) => w.attackId !== null);
  const cleanGraded = graded.filter((w) => w.attackId === null);
  return {
    attackWorlds: attackGraded.length,
    survived: attackGraded.filter((w) => !w.result!.breached).length,
    breaches: attackGraded.filter((w) => w.result!.breached).length,
    cleanWorlds: cleanGraded.length,
    falseAlarms: cleanGraded.filter((w) => w.result!.false_alarm).length,
    dollarsLost: attackGraded.reduce((sum, w) => sum + w.result!.dollars_over, 0),
    seconds: null,
    graded: graded.length,
    total: expected,
    provisional: true,
  };
}

export function survivalRate(st: GenStats): number | null {
  return st.attackWorlds > 0 ? st.survived / st.attackWorlds : null;
}

/** The latest generation that has a sequential timing run, paired with its parallel summary. */
export function speedupPair(s: ArenaState): { gen: GenerationState; parallel: GenDone; sequential: GenDone } | null {
  const gens = orderedGenerations(s).filter((g) => g.done && g.sequential);
  const g = gens.at(-1);
  return g ? { gen: g, parallel: g.done!, sequential: g.sequential! } : null;
}

export function currentGeneration(s: ArenaState): GenerationState | null {
  let latest: GenerationState | null = null;
  for (const k of s.genOrder) {
    const g = s.generations[k];
    if (g.startedAt !== null && (latest === null || g.startedAt >= (latest.startedAt ?? 0))) latest = g;
  }
  return latest ?? (s.genOrder.length ? s.generations[s.genOrder[s.genOrder.length - 1]] : null);
}

export function examGeneration(s: ArenaState): GenerationState | null {
  const exams = orderedGenerations(s).filter((g) => g.exam);
  return exams.at(-1) ?? null;
}

export function planForWorld(s: ArenaState, w: WorldState): BluePlan | null {
  const id = w.result?.plan_id ?? s.generations[w.genKey]?.planId ?? null;
  return id ? (s.plans[id] ?? null) : null;
}

export function lessonsForAttack(s: ArenaState, attackId: string): Lesson[] {
  return s.lessonOrder.map((id) => s.lessons[id]).filter((l) => l.attack_id === attackId);
}

export function latestCall(s: ArenaState): CallStep | null {
  return s.calls.at(-1) ?? null;
}
