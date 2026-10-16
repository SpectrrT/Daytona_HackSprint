import { createHash } from "node:crypto";
import type { EvolutionRun, FailureEvidence } from "@hollow-purple/shared/evolution";
import { FAMILIES, LessonMemory, failureFamily, type Family, type GraphNode, type GraphEdge } from "../memory/graph.js";

export type MemoryMode = "none" | "flat" | "graph";
export const MODES: MemoryMode[] = ["none", "flat", "graph"];
export const RETRIEVAL_K = 3;
// One UTF-8 byte per possible token is a conservative cap shared by both arms.
export const RETRIEVAL_TOKEN_BUDGET = 2048;
export const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export interface Corpus {
  schemaVersion: 1; model: string; contractHash: string; trainingFamily: Family; targetFamily: Family;
  frozenAt: string; developmentRun: EvolutionRun; graph: { nodes: GraphNode[]; edges: GraphEdge[] };
  failures: FailureEvidence[]; corpusHash: string;
}
export function assertCorpus(corpus: Corpus): void {
  const { corpusHash, ...body } = corpus;
  if (digest(body) !== corpusHash || corpus.contractHash !== corpus.developmentRun.contract.hash) throw new Error("Frozen corpus hash mismatch.");
  if (!corpus.failures.length || corpus.failures.some(f => !f.reproduced || /held.out|hidden/i.test(f.testId) || failureFamily(f) !== corpus.trainingFamily)) throw new Error("Corpus contains an unverified or out-of-family failure.");
  if (!FAMILIES[corpus.trainingFamily] || FAMILIES[corpus.trainingFamily] !== FAMILIES[corpus.targetFamily] || corpus.trainingFamily === corpus.targetFamily) throw new Error("Transfer must target an unseen sibling family.");
  if (corpus.graph.nodes.filter(n => n.kind === "failure").some(n => n.family !== corpus.trainingFamily)) throw new Error("Development graph includes the held-out sibling.");
}
const words = (text: string): string[] => text.toLowerCase().replaceAll("_", " ").match(/[a-z0-9]+/g) ?? [];
/** TF-IDF cosine similarity over raw public evidence. No lessons enter the flat arm. */
export function retrieveRaw(failures: FailureEvidence[], query: string, k = RETRIEVAL_K): FailureEvidence[] {
  const documents = failures.map(f => words(`${f.testId} ${f.testName} ${f.summary} ${JSON.stringify(f.trace)}`));
  const queryWords = words(query);
  const vocabulary = new Set([...documents.flat(), ...queryWords]);
  const vector = (tokens: string[]) => [...vocabulary].map(word => {
    const tf = tokens.filter(t => t === word).length / Math.max(1, tokens.length);
    const df = documents.filter(doc => doc.includes(word)).length;
    return tf * (1 + Math.log((documents.length + 1) / (df + 1)));
  });
  const q = vector(queryWords); const norm = (v: number[]) => Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return failures.map((failure, index) => { const v = vector(documents[index]!); return { failure, score: v.reduce((s, x, i) => s + x * q[i]!, 0) / (norm(v) * norm(q) || 1) }; })
    .sort((a, b) => b.score - a.score || a.failure.id.localeCompare(b.failure.id)).slice(0, k).map(item => item.failure);
}
function bounded(items: string[]): string[] {
  let remaining = RETRIEVAL_TOKEN_BUDGET;
  return items.flatMap(item => {
    if (remaining < 32) return [];
    const buffer = Buffer.from(item); const value = buffer.subarray(0, remaining).toString("utf8").replace(/\uFFFD$/u, "");
    remaining -= Buffer.byteLength(value); return [value];
  });
}
export async function retrieveContext(corpus: Corpus, mode: MemoryMode, currentFailures: FailureEvidence[] = []) {
  assertCorpus(corpus);
  if (mode === "none") return { items: [] as string[], ids: [] as string[], bytes: 0, path: [] as string[] };
  if (mode === "flat") {
    const selected = retrieveRaw(corpus.failures, `${corpus.targetFamily} ${corpus.developmentRun.contract.rules.map(r => r.description).join(" ")} ${currentFailures.map(f => f.summary).join(" ")}`);
    const items = bounded(selected.map(f => JSON.stringify({ testId: f.testId, testName: f.testName, summary: f.summary, cycle: f.cycle, expected: f.expected, actual: f.actual, sequence: f.sequence, trace: f.trace, reproduced: f.reproduced })));
    return { items, ids: selected.slice(0, items.length).map(f => f.id), bytes: items.reduce((n, s) => n + Buffer.byteLength(s), 0), path: [] as string[] };
  }
  const backend = { check: async () => {}, write: async () => { throw new Error("Frozen corpus is read-only."); }, entity: async (id: string) => {
    const node = corpus.graph.nodes.find(n => n.id === id); return node ? { node, edges: corpus.graph.edges.filter(e => e.source === id || e.target === id) } : undefined;
  } };
  const memory = new LessonMemory(backend, async () => { throw new Error("Frozen corpus cannot write lessons."); });
  const lessons = (await memory.retrieve(corpus.developmentRun, [corpus.targetFamily])).slice(0, RETRIEVAL_K);
  const items = bounded(lessons.map(n => n.text!));
  const path: string[] = []; let family: Family | null = corpus.targetFamily;
  while (family) { path.push(family); family = FAMILIES[family]; }
  return { items, ids: lessons.slice(0, items.length).map(n => n.id), bytes: items.reduce((n, s) => n + Buffer.byteLength(s), 0), path };
}
/** Fisher-Yates order is fixed by the trial seed, before any model output exists. */
export function armOrder(seed: number): MemoryMode[] {
  let state = seed >>> 0 || 1; const order = [...MODES];
  for (let i = order.length - 1; i > 0; i--) { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; const j = (state >>> 0) % (i + 1); [order[i], order[j]] = [order[j]!, order[i]!]; }
  return order;
}
