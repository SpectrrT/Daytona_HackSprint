import { createHash } from "node:crypto";
import { z } from "zod";
import type { Candidate, EvaluationResult, EvolutionRun, FailureEvidence } from "@antibody/shared/evolution";
import { passesAcceptance } from "../arena/tools.js";
import { assertFrozenContract } from "../engine/contract.js";

export const FAMILIES = {
  fifo_contract: null,
  occupancy: "fifo_contract",
  ordering: "fifo_contract",
  reset_integrity: "fifo_contract",
  output_register: "fifo_contract",
  simultaneous: "occupancy",
  full_boundary: "occupancy",
  empty_boundary: "occupancy",
  pointer_wrap: "ordering",
} as const;
export type Family = keyof typeof FAMILIES;
const safe = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const nodeSchema = z.object({
  id: z.string().max(250), kind: z.enum(["run", "family", "candidate", "failure", "lesson"]),
  runId: safe, contractHash: hash, label: z.string().max(2400),
  candidateId: safe.optional(), parentId: safe.optional(), sourceHash: hash.optional(),
  family: z.enum(Object.keys(FAMILIES) as [Family, ...Family[]]).optional(),
  failureId: z.string().max(200).optional(), failureDigest: hash.optional(),
  regressionId: z.string().max(200).optional(), regressionDigest: hash.optional(),
  supportingFailureIds: z.array(z.string().max(200)).max(1).optional(),
  text: z.string().min(20).max(2000).optional(), status: z.enum(["proposed", "validated"]).optional(),
  transferText: z.string().min(20).max(800).optional(),
  validatedBy: safe.optional(), validationSourceHash: hash.optional(),
  validationMethod: z.enum(["source-grounded-repair"]).optional(),
  writer: z.object({ role: z.literal("blue"), provider: z.enum(["codex-cli", "anthropic", "bedrock"]), model: z.string().max(120), durationMs: z.number().nonnegative() }).strict().optional(),
}).strict().superRefine((value, context) => {
  const require = (condition: unknown, message: string) => { if (!condition) context.addIssue({ code: "custom", message }); };
  require(value.id.startsWith(`hp:${value.runId}:${value.kind}:`), "Graph identity does not match its run and kind.");
  if (value.kind === "candidate") require(value.candidateId && value.sourceHash, "Candidate provenance is incomplete.");
  if (value.kind === "failure") require(value.candidateId && value.sourceHash && value.failureId && value.failureDigest && value.regressionId && value.regressionDigest && value.family, "Failure provenance is incomplete.");
  if (value.kind === "family") require(value.family, "Family identity is missing.");
  if (value.kind === "lesson") {
    require(value.candidateId && value.sourceHash && value.family && value.text && value.status && value.writer && value.supportingFailureIds?.length === 1, "Lesson provenance is incomplete.");
    if (value.status === "validated") require(value.validatedBy && value.validationSourceHash, "Lesson validation provenance is incomplete.");
  }
});
export type GraphNode = z.infer<typeof nodeSchema>;
export interface GraphEdge { source: string; relation: string; target: string }
export interface Entity { node: GraphNode; edges: GraphEdge[] }
export interface GraphBackend {
  check(signal?: AbortSignal): Promise<void>;
  write(runId: string, nodes: GraphNode[], edges: GraphEdge[], signal?: AbortSignal): Promise<void>;
  entity(name: string, signal?: AbortSignal): Promise<Entity | undefined>;
}
export interface LessonAnswer { text: string; transferText?: string; agent: NonNullable<GraphNode["writer"]> }
export type LessonWriter = (input: { run: EvolutionRun; candidate: Candidate; failure: FailureEvidence; family: Family; repair?: Candidate; signal?: AbortSignal }) => Promise<LessonAnswer>;
export class MemoryError extends Error { constructor(message: string) { super(message); this.name = "MemoryError"; } }
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function name(runId: string, kind: GraphNode["kind"], key: string): string {
  safe.parse(runId); safe.parse(key);
  return `hp:${runId}:${kind}:${key}`;
}
function node(run: EvolutionRun, kind: GraphNode["kind"], key: string, data: Partial<GraphNode>): GraphNode {
  return nodeSchema.parse({ id: name(run.id, kind, key), kind, runId: run.id, contractHash: run.contract.hash, label: key, ...data });
}
export function failureFamily(failure: FailureEvidence): Family {
  const edge = failure.sequence.at(-1);
  if (edge?.reset || /reset/.test(failure.testId)) return "reset_integrity";
  if (/empty/.test(failure.testId) || (edge?.read && edge.write && failure.expected === null && failure.actual !== null)) return "empty_boundary";
  if (/full|capacity/.test(failure.testId)) return "full_boundary";
  if (/simultaneous|concurrent/.test(failure.testId) || (edge?.read && edge.write)) return "simultaneous";
  if (/wrap/.test(failure.testId)) return "pointer_wrap";
  if (/order/.test(failure.testId)) return "ordering";
  if (/output|valid/.test(failure.testId)) return "output_register";
  return "fifo_contract";
}
/** Red's attacks (controller-prefixed agent-red-) are public by construction; "held-out" must be a whole word, not "held-output". */
const privateTest = (testId: string) => !testId.startsWith("agent-red-") && /(^|[^a-z])(held[-_ ]?out|hidden)([^a-z]|$)/i.test(testId);
function publicFailure(failure: FailureEvidence): void {
  if (!failure.reproduced || privateTest(failure.testId) || !failure.sequence.length) {
    throw new MemoryError("Only independently reproduced public failures may enter graph memory.");
  }
}
function sourceBound(candidate: Candidate): void {
  if (candidate.sourceHash !== createHash("sha256").update(candidate.source).digest("hex")) throw new MemoryError("Graph provenance must match the executed candidate source.");
}

/** Graph traversal is run and frozen-contract scoped. Proposed lessons never enter retrieval. */
export class LessonMemory {
  constructor(readonly backend: GraphBackend, private readonly writer: LessonWriter) {}

  async recordCandidate(run: EvolutionRun, candidate: Candidate, signal?: AbortSignal): Promise<void> {
    assertFrozenContract(run.contract); sourceBound(candidate);
    const root = node(run, "run", "root", { label: run.contract.title });
    const nodes = [root, ...Object.keys(FAMILIES).map((family) => node(run, "family", family, { family: family as Family, label: family.replaceAll("_", " ") }))];
    const item = node(run, "candidate", candidate.id, { candidateId: candidate.id, parentId: candidate.parentId, sourceHash: candidate.sourceHash, label: candidate.label });
    nodes.push(item);
    const edges: GraphEdge[] = nodes.slice(1).map((n) => ({ source: root.id, relation: "contains", target: n.id }));
    for (const [child, parent] of Object.entries(FAMILIES)) if (parent) edges.push({ source: name(run.id, "family", child), relation: "child_of", target: name(run.id, "family", parent) });
    if (candidate.parentId) edges.push({ source: item.id, relation: "child_of", target: name(run.id, "candidate", candidate.parentId) });
    await this.backend.write(run.id, nodes, edges, signal);
  }

  async recordBreach(run: EvolutionRun, candidate: Candidate, failure: FailureEvidence, signal?: AbortSignal): Promise<GraphNode> {
    assertFrozenContract(run.contract); sourceBound(candidate); publicFailure(failure);
    const regression = run.regressions.find((f) => JSON.stringify(f.sequence) === JSON.stringify(failure.sequence));
    const witnessed = run.events.some((e) => e.type === "failure.reproduced" && e.candidateId === candidate.id && digest(e.payload) === digest(failure));
    if (!regression || (digest(regression) !== digest(failure) && !witnessed)) throw new MemoryError("A breach must first be committed to the controller regression journal.");
    const leaf = failureFamily(failure);
    const family = FAMILIES[leaf] ?? leaf;
    const key = digest({ candidate: candidate.id, failure: failure.id }).slice(0, 32);
    const lessonId = name(run.id, "lesson", key);
    const existing = await this.readNode(run, lessonId, signal);
    if (existing) return existing.node;
    const answer = await this.writer({ run, candidate, failure, family, signal });
    signal?.throwIfAborted();
    if (/\u2014|[\u{1F300}-\u{1FAFF}]/u.test(answer.text + (answer.transferText ?? ""))) throw new MemoryError("Lesson text must use plain punctuation and no emojis.");
    const failed = node(run, "failure", key, { candidateId: candidate.id, sourceHash: candidate.sourceHash, family: leaf, label: failure.summary, failureId: failure.id, failureDigest: digest(failure), regressionId: regression.id, regressionDigest: digest(regression) });
    const lesson = node(run, "lesson", key, { candidateId: candidate.id, sourceHash: candidate.sourceHash, family, label: "Blue lesson", text: answer.text, transferText: answer.transferText, status: "proposed", supportingFailureIds: [failure.id], writer: answer.agent });
    await this.backend.write(run.id, [failed, lesson], [
      { source: name(run.id, "run", "root"), relation: "contains", target: failed.id },
      { source: name(run.id, "run", "root"), relation: "contains", target: lesson.id },
      { source: name(run.id, "candidate", candidate.id), relation: "failed_on", target: failed.id },
      { source: failed.id, relation: "belongs_to", target: name(run.id, "family", leaf) },
      { source: lesson.id, relation: "supported_by", target: failed.id },
      { source: lesson.id, relation: "applies_to", target: name(run.id, "family", family) },
    ], signal);
    return lesson;
  }

  private async readNode(run: EvolutionRun, id: string, signal?: AbortSignal): Promise<Entity | undefined> {
    const value = await this.backend.entity(id, signal);
    if (!value) return undefined;
    if (value.node.id !== id || value.node.runId !== run.id || value.node.contractHash !== run.contract.hash) throw new MemoryError("Graph read crossed its run or frozen-contract boundary.");
    const parsed = nodeSchema.safeParse(value.node);
    if (!parsed.success) throw new MemoryError("Graph read contains invalid provenance.");
    return { node: parsed.data, edges: value.edges };
  }

  async snapshot(run: EvolutionRun, signal?: AbortSignal): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
    assertFrozenContract(run.contract);
    const root = await this.readNode(run, name(run.id, "run", "root"), signal);
    if (!root) return { nodes: [], edges: [] };
    const ids = [...new Set([root.node.id, ...root.edges.filter((e) => e.source === root.node.id && e.relation === "contains").map((e) => e.target)])];
    if (ids.length > 200) throw new MemoryError("Graph exceeds the bounded run-memory read budget.");
    const nodes: GraphNode[] = []; const edges = new Map<string, GraphEdge>();
    for (const id of ids) {
      const item = await this.readNode(run, id, signal);
      if (!item) throw new MemoryError("Graph contains a dangling evidence reference.");
      nodes.push(item.node);
      for (const edge of item.edges) edges.set(JSON.stringify(edge), edge);
    }
    const known = new Set(nodes.map((n) => n.id));
    return { nodes, edges: [...edges.values()].filter((e) => known.has(e.source) && known.has(e.target)) };
  }

  async retrieve(run: EvolutionRun, families: Family[] = Object.keys(FAMILIES) as Family[], signal?: AbortSignal): Promise<GraphNode[]> {
    const graph = await this.snapshot(run, signal);
    const relevant = new Set(families.map((f) => name(run.id, "family", f)));
    for (let pass = 0; pass < Object.keys(FAMILIES).length; pass++) {
      for (const edge of graph.edges) if (edge.relation === "child_of" && relevant.has(edge.source) && graph.nodes.some((n) => n.id === edge.target && n.kind === "family")) relevant.add(edge.target);
    }
    const ids = new Set(graph.edges.filter((e) => e.relation === "applies_to" && relevant.has(e.target)).map((e) => e.source));
    const lessons = graph.nodes.filter((n) => n.kind === "lesson" && n.status === "validated" && n.text && ids.has(n.id));
    for (const lesson of lessons) {
      const validator = graph.nodes.find((n) => n.kind === "candidate" && n.candidateId === lesson.validatedBy && n.sourceHash === lesson.validationSourceHash);
      if (!validator || !graph.edges.some((e) => e.source === lesson.id && e.relation === "validated_by" && e.target === validator.id)) throw new MemoryError("Validated lesson lacks its source-bound validation edge.");
    }
    return lessons.map(lesson => {
      const origin = graph.nodes.find(n => n.kind === "failure" && lesson.supportingFailureIds?.includes(n.failureId!))?.family;
      // Implementation recipes stay with their originating bug family. Parent
      // edges transfer the invariant, not a code snippet from another design.
      const exactFamily = families.length === 1 && families[0] === origin;
      return !exactFamily && lesson.transferText ? { ...lesson, text: lesson.transferText } : lesson;
    });
  }

  async validate(run: EvolutionRun, candidate: Candidate, result: EvaluationResult, attackIds: string[], signal?: AbortSignal): Promise<GraphNode[]> {
    assertFrozenContract(run.contract); sourceBound(candidate);
    if (result.backend !== "verilator" || result.sourceHash !== candidate.sourceHash || result.source !== candidate.source || !passesAcceptance(result, run.regressions.length, attackIds)) return [];
    const graph = await this.snapshot(run, signal);
    const recorded = graph.nodes.find((n) => n.kind === "candidate" && n.candidateId === candidate.id);
    if (!recorded || recorded.sourceHash !== candidate.sourceHash || recorded.parentId !== candidate.parentId) throw new MemoryError("Validation candidate differs from recorded graph provenance.");
    const ancestors = new Set<string>(); let current = candidate.parentId;
    while (current) {
      if (ancestors.has(current)) throw new MemoryError("Candidate ancestry is cyclic.");
      ancestors.add(current);
      const parent = graph.nodes.find((n) => n.kind === "candidate" && n.candidateId === current);
      if (!parent) throw new MemoryError("Candidate ancestry has no recorded parent.");
      current = parent.parentId;
    }
    const validated: GraphNode[] = [];
    for (const lesson of graph.nodes.filter((n) => n.kind === "lesson" && n.status === "proposed" && ancestors.has(n.candidateId!))) {
      const support = lesson.supportingFailureIds ?? [];
      if (support.length !== 1) throw new MemoryError("Lesson has incomplete supporting evidence.");
      const failure = graph.nodes.find((n) => n.kind === "failure" && n.failureId === support[0] && n.candidateId === lesson.candidateId);
      const index = run.regressions.findIndex((f) => f.id === failure?.regressionId);
      if (index < 0 || !failure || failure.sourceHash !== lesson.sourceHash || failure.regressionDigest !== digest(run.regressions[index]) || !result.checks.some((c) => c.id === `regression-${index}` && c.passed && !c.hidden)) continue;
      // A passing child validates the repair, not the original explanation. Rewrite
      // the proposal against both actual sources before making it retrievable.
      const original = run.candidates.find(c => c.id === lesson.candidateId);
      if (!original || original.sourceHash !== lesson.sourceHash) throw new MemoryError("Lesson review lacks the original executed source.");
      sourceBound(original);
      const answer = await this.writer({ run, candidate: original, failure: run.regressions[index]!, family: lesson.family!, repair: candidate, signal });
      signal?.throwIfAborted();
      if (/\u2014|[\u{1F300}-\u{1FAFF}]/u.test(answer.text + (answer.transferText ?? ""))) throw new MemoryError("Lesson text must use plain punctuation and no emojis.");
      validated.push(nodeSchema.parse({ ...lesson, text: answer.text, transferText: answer.transferText, writer: answer.agent, status: "validated", validatedBy: candidate.id, validationSourceHash: candidate.sourceHash, validationMethod: "source-grounded-repair" }));
    }
    if (validated.length) await this.backend.write(run.id, validated, validated.map((n) => ({ source: n.id, relation: "validated_by", target: name(run.id, "candidate", candidate.id) })), signal);
    return validated;
  }
}
