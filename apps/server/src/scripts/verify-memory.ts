import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.js";
import { freezeContract } from "../engine/contract.js";
import { BUFFER_PROMPT } from "@hollow-purple/shared/evolution";
import { name, type GraphNode } from "../memory/graph.js";
import { SurrealGraphBackend } from "../memory/surreal.js";

/** Live adapter check only. No model output or hardware success is fabricated. */
async function main() {
  if (!config.SURREAL_CONTEXT_URL || !config.SURREAL_CONTEXT_ID || !config.SURREAL_API_KEY) throw new Error("Configure all three Surreal Context credentials before running this check.");
  const backend = new SurrealGraphBackend({ url: config.SURREAL_CONTEXT_URL, context: config.SURREAL_CONTEXT_ID, apiKey: config.SURREAL_API_KEY });
  const runId = `memory-qa-${randomUUID()}`, contract = freezeContract(BUFFER_PROMPT);
  const root: GraphNode = { id: name(runId, "run", "root"), kind: "run", runId, contractHash: contract.hash, label: "Live graph adapter QA. No model or hardware run." };
  const nodes: GraphNode[] = [root, ...["occupancy", "empty_boundary", "full_boundary"].map((family) => ({ id: name(runId, "family", family), kind: "family" as const, runId, contractHash: contract.hash, label: family, family: family as "occupancy" | "empty_boundary" | "full_boundary" }))];
  const edges = [...nodes.slice(1).map((n) => ({ source: root.id, relation: "contains", target: n.id })),
    ...nodes.slice(2).map((n) => ({ source: n.id, relation: "child_of", target: nodes[1]!.id }))];
  await backend.check();
  assert.equal(await backend.entity(root.id), undefined, "A new QA run must not inherit another run's entities.");
  await backend.write(runId, nodes, edges);
  for (const node of nodes) {
    const read = await backend.entity(node.id);
    assert.deepEqual(read?.node, node, "Persisted graph payload did not survive readback.");
    for (const edge of edges.filter((e) => e.source === node.id || e.target === node.id)) assert.ok(read.edges.some((e) => JSON.stringify(e) === JSON.stringify(edge)), "Persisted graph relation was absent on readback.");
  }
  const report = { runId, verifiedAt: new Date().toISOString(), authenticated: true, persistedNodes: nodes.length, persistedEdges: edges.length,
    readback: true, modelCalls: 0, hardwareRuns: 0, scope: "SurrealDB structured graph adapter only" };
  await mkdir(join(config.DATA_DIR, "verification"), { recursive: true });
  await writeFile(join(config.DATA_DIR, "verification", "memory-live.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
}
void main().catch(() => { console.error("Live graph verification failed. Check the private provider configuration; no successful hardware or model run is claimed."); process.exitCode = 1; });
