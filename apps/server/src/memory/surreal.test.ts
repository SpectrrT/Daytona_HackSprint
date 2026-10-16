import assert from "node:assert/strict";
import { test } from "node:test";
import { SurrealGraphBackend } from "./surreal.js";
import { name, type GraphNode } from "./graph.js";
const credentials = { url: "https://context.example", context: "test", apiKey: "SECRET_TEST_SENTINEL" };
const item: GraphNode = { id: name("run", "family", "occupancy"), kind: "family", family: "occupancy", runId: "run", contractHash: "a".repeat(64), label: "occupancy" };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const fake = (fn: (url: string, init: RequestInit) => Response | Promise<Response>) => ((url: unknown, init?: RequestInit) => fn(String(url), init!)) as typeof fetch;

test("adapter registers scope once and writes structured nodes/edges with snake-case wire fields", async () => {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const backend = new SurrealGraphBackend(credentials, fake((url, init) => {
    assert.equal((init.headers as Record<string, string>).Authorization, "Bearer SECRET_TEST_SENTINEL"); assert.equal(init.redirect, "error");
    calls.push({ url, body: JSON.parse(String(init.body)) });
    return response(url.endsWith("/scopes") ? {} : { mode: "triples", extraction: {} });
  }));
  for (let n = 0; n < 2; n++) await backend.write("run", [item], [{ source: item.id, relation: "child_of", target: name("run", "family", "fifo_contract") }]);
  assert.equal(calls.filter((c) => c.url.endsWith("/scopes")).length, 1);
  const body = calls.find((c) => c.url.endsWith("/facts"))!.body;
  assert.equal(body.infer, "triples"); assert.deepEqual(body.scopes, [["hollow-hardware/run"]]);
  const triples = body.triples as { entity: { type: string }; key: string; target?: unknown }[];
  assert.equal(triples[0]!.entity.type, "concept"); assert.ok(triples.some((t) => t.key === "child_of" && t.target));
});

test("entity read preserves actual graph edges and refuses truncated or mismatched evidence", async () => {
  const body = { attributes: [{ key: "payload", value: JSON.stringify(item) }], relations: [{ subject: `entity:concept/${item.id}`, label: "child_of", object: `entity:concept/${name("run", "family", "fifo_contract")}` }], truncated: { attributes: false, relations: false } };
  const backend = (payload: unknown) => new SurrealGraphBackend(credentials, fake(() => response(payload)));
  const entity = await backend(body).entity(item.id); assert.equal(entity!.edges[0]!.source, item.id);
  await assert.rejects(backend({ ...body, truncated: { relations: true } }).entity(item.id), /truncated/);
  await assert.rejects(backend({ ...body, attributes: [{ key: "payload", value: JSON.stringify({ ...item, id: "wrong" }) }] }).entity(item.id), /mismatched|malformed/);
  assert.equal(await new SurrealGraphBackend(credentials, fake(() => response({}, 404))).entity(item.id), undefined);
});

test("errors never retain response bodies, credentials, private URLs or network diagnostics", async () => {
  for (const status of [401, 403, 429, 500]) {
    const backend = new SurrealGraphBackend(credentials, fake(() => response({ error: credentials.apiKey }, status)));
    await assert.rejects(backend.check(), (e: Error) => { assert.doesNotMatch(e.message, /SECRET_TEST_SENTINEL|context.example/); return true; });
  }
  const broken = new SurrealGraphBackend(credentials, fake(() => { throw new Error("SECRET_TEST_SENTINEL https://private-url.example"); }));
  await assert.rejects(broken.check(), (e: Error) => { assert.doesNotMatch(e.message, /SECRET_TEST_SENTINEL|private-url/); return true; });
});

test("cross-run writes, redirect-capable origins and excessive responses are refused", async () => {
  for (const url of ["http://context.example", "https://user:password@context.example", "https://context.example/private", "https://context.example?secret=1"]) assert.throws(() => new SurrealGraphBackend({ ...credentials, url }));
  const backend = new SurrealGraphBackend(credentials, fake(() => { throw new Error("Must not call provider"); }));
  await assert.rejects(backend.write("other", [item], []), /Cross-run/);
  const oversized = new SurrealGraphBackend(credentials, fake(() => new Response(" ".repeat(2 * 1024 * 1024 + 1))));
  await assert.rejects(oversized.check(), /size budget/);
});


test("malformed provider payloads cannot expose raw values through parse errors", async () => {
  const malformed = new SurrealGraphBackend(credentials, fake(() => response({ attributes: [{ key: "payload", value: "SECRET_TEST_SENTINEL is not JSON" }], relations: [] })));
  await assert.rejects(malformed.entity(item.id), (e: Error) => { assert.doesNotMatch(e.message, /SECRET_TEST_SENTINEL/); assert.match(e.message, /malformed/); return true; });
});
