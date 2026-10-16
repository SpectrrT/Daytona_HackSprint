import { test } from "node:test";
import assert from "node:assert/strict";
import { freezeSoftwareContract } from "./contract.js";
import { verifyCheckout } from "./verifier.js";
import type { LedgerSnapshot, ObservedRequest } from "@hollow-purple/shared/software";

const sourceHash = "a".repeat(64), runtimeHash = "b".repeat(64), contract = freezeSoftwareContract(123);
const order = { id: 7, requestId: "one", quantity: 1, totalCents: 1999 };
const observed = (status: number): ObservedRequest => ({ input: { requestId: "one", quantity: 1 }, response: { status, sourceHash, body: { orderId: 7, requestId: "one", quantity: 1, totalCents: 1999 } } });
const ledger = (stock = 4): LedgerSnapshot => ({ stock, orders: [order], sourceHash, runtimeHash });
const verify = (requests: ObservedRequest[], snapshot = ledger()) => verifyCheckout({ id: "probe", contract, sourceHash, runtimeHash, batches: [{ requests }], ledger: snapshot });

test("accepts a concurrently replayed response that finishes before its creator", () => {
  assert.ok(verify([observed(200), observed(201)]).passed);
});
test("rejects duplicate persisted orders even if the page claims one receipt", () => {
  assert.match(verify([observed(201), observed(200)], { ...ledger(3), orders: [order, { ...order, id: 8 }] }).summary, /extra order/);
});
test("rejects fabricated stock, mismatched source, and a response with the wrong receipt ID", () => {
  assert.equal(verify([observed(201)], ledger(5)).passed, false);
  assert.equal(verify([observed(201)], { ...ledger(), sourceHash: "other" }).passed, false);
  const response = observed(201); response.response.body = { ...order, orderId: 999 };
  assert.equal(verify([response]).passed, false);
});
test("does not accept repeated HTTP 201 statuses for one purchase", () => {
  assert.equal(verify([observed(201), observed(201)]).passed, false);
});
test("a reused key with changed quantity must conflict without extra inventory effects", () => {
  const conflict: ObservedRequest = { input: { requestId: "one", quantity: 2 }, response: { sourceHash, status: 409, body: { error: "Changed payload" } } };
  assert.ok(verifyCheckout({ id: "conflict", contract, sourceHash, runtimeHash, batches: [{ requests: [observed(201)] }, { requests: [conflict] }], ledger: ledger() }).passed);
});
test("requires all six competing responses to agree with five units of stock", () => {
  const orders = Array.from({ length: 5 }, (_, index) => ({ id: index + 1, requestId: `r${index}`, quantity: 1, totalCents: 1999 }));
  const requests = Array.from({ length: 6 }, (_, index) => ({ input: { requestId: `r${index}`, quantity: 1 }, response: { sourceHash, status: index < 5 ? 201 : 409, body: index < 5 ? { orderId: index + 1, requestId: `r${index}`, quantity: 1, totalCents: 1999 } : { error: "Sold out" } } }));
  assert.ok(verify(requests, { ...ledger(0), orders }).passed);
  requests[5]!.response.status = 201;
  assert.equal(verify(requests, { ...ledger(0), orders }).passed, false);
});
