import { z } from "zod";
import { MemoryError, nodeSchema, type Entity, type GraphBackend, type GraphEdge, type GraphNode } from "./graph.js";

export interface SurrealCredentials { url: string; context: string; apiKey: string }
const edgeSchema = z.object({ subject: z.string(), label: z.string(), object: z.string() });

/** Uses sponsor Context keys, not the unrelated SQL/RPC database login API. */
export class SurrealGraphBackend implements GraphBackend {
  private readonly scopes = new Map<string, Promise<void>>();
  private readonly base: string;
  constructor(private readonly credentials: SurrealCredentials, private readonly request: typeof fetch = fetch) {
    const url = new URL(credentials.url);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new MemoryError("Surreal Context URL must be an HTTPS origin.");
    this.base = url.origin + "/api/v1/" + encodeURIComponent(credentials.context);
  }
  private async call(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    try {
      const timeout = AbortSignal.timeout(30_000);
      const response = await this.request(this.base + path, { method, redirect: "error", signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: { Authorization: `Bearer ${this.credentials.apiKey}`, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (response.status === 404 && method === "GET" && path.startsWith("/entities/")) { await response.body?.cancel(); return undefined; }
      if (!response.ok) { await response.body?.cancel(); throw new MemoryError(`Surreal graph request failed (HTTP ${response.status}).`); }
      const reader = response.body?.getReader();
      if (!reader) throw new MemoryError("Surreal graph returned an empty response.");
      const chunks: Uint8Array[] = []; let size = 0;
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new MemoryError("Surreal graph response exceeds its size budget."); }
        chunks.push(value);
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof MemoryError) throw error;
      throw new MemoryError("Surreal graph request failed. Check credentials and provider availability privately.");
    }
  }
  async check(signal?: AbortSignal): Promise<void> { await this.call("GET", "/scopes?limit=1", undefined, signal); }
  private async scope(runId: string, signal?: AbortSignal): Promise<void> {
    let promise = this.scopes.get(runId);
    if (!promise) {
      promise = this.call("POST", "/scopes", { path: "hollow-hardware/" + runId }, signal).then(() => {});
      this.scopes.set(runId, promise);
      void promise.catch(() => this.scopes.delete(runId));
    }
    await promise;
  }
  async write(runId: string, nodes: GraphNode[], edges: GraphEdge[], signal?: AbortSignal): Promise<void> {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(runId)) throw new MemoryError("Invalid graph run identifier.");
    const prefix = `hp:${runId}:`;
    for (const n of nodes) { nodeSchema.parse(n); if (n.runId !== runId || !n.id.startsWith(prefix)) throw new MemoryError("Cross-run graph write refused."); }
    if (edges.some((e) => !e.source.startsWith(prefix) || !e.target.startsWith(prefix))) throw new MemoryError("Cross-run relation refused.");
    await this.scope(runId, signal);
    const entity = (name: string) => ({ type: "concept", name });
    const triples = [
      ...nodes.map((n) => ({ entity: entity(n.id), key: "payload", value: JSON.stringify(n) })),
      ...edges.map((e) => ({ entity: entity(e.source), key: e.relation, target: entity(e.target) })),
    ];
    const result = await this.call("POST", "/facts", { infer: "triples", scopes: [["hollow-hardware/" + runId]], triples }, signal);
    if (!result || typeof result !== "object" || !("mode" in result) || result.mode !== "triples" || !("extraction" in result)) throw new MemoryError("Surreal did not confirm structured graph persistence.");
  }
  async entity(name: string, signal?: AbortSignal): Promise<Entity | undefined> {
    const value = await this.call("GET", "/entities/concept/" + encodeURIComponent(name), undefined, signal);
    if (value === undefined) return undefined;
    try {
      const body = z.object({ attributes: z.array(z.object({ key: z.string(), value: z.unknown() })), relations: z.array(edgeSchema), truncated: z.record(z.string(), z.boolean()).optional() }).parse(value);
      if (Object.values(body.truncated ?? {}).some(Boolean)) throw new MemoryError("Surreal entity read was truncated; refusing incomplete graph evidence.");
      const payloads = body.attributes.filter((a) => a.key === "payload");
      if (payloads.length !== 1 || typeof payloads[0]!.value !== "string") throw new MemoryError("Surreal entity has missing or ambiguous provenance.");
      const node = nodeSchema.parse(JSON.parse(payloads[0]!.value));
      if (node.id !== name) throw new MemoryError("Surreal returned a mismatched entity.");
      const canonical = (id: string) => id.replace(/^entity:concept\//, "");
      return { node, edges: body.relations.map((e) => ({ source: canonical(e.subject), relation: e.label, target: canonical(e.object) })) };
    } catch (error) {
      if (error instanceof MemoryError) throw error;
      throw new MemoryError("Surreal returned malformed graph evidence.");
    }
  }
}
