import type { CheckoutContract, CheckoutInput, LedgerSnapshot, RequestBatch, SoftwareCheck } from "@antibody/shared/software";
import { assertSoftwareContract } from "./contract.js";

type Order = { requestId: string; quantity: number; totalCents: number };
interface Model { stock: number; orders: Order[] }
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
function transition(state: Model, input: CheckoutInput, price: number): { state: Model; status: number; order?: Order } {
  const { requestId, quantity } = input;
  if (typeof requestId !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(requestId) || typeof quantity !== "number" || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 5) return { state, status: 400 };
  const original = state.orders.find(order => order.requestId === requestId);
  if (original) return quantity === original.quantity ? { state, status: 200, order: original } : { state, status: 409 };
  if (quantity > state.stock) return { state, status: 409 };
  const order = { requestId, quantity, totalCents: quantity * price };
  return { state: { stock: state.stock - quantity, orders: [...state.orders, order] }, status: 201, order };
}
const stateKey = (model: Model) => JSON.stringify({ stock: model.stock, orders: [...model.orders].sort((a, b) => a.requestId.localeCompare(b.requestId)) });

/** Controller-owned reference model. Candidate code and model opinions never supply a verdict. */
export function verifyCheckout(input: { id: string; contract: CheckoutContract; sourceHash: string; runtimeHash: string; batches: RequestBatch[]; ledger: LedgerSnapshot; hidden?: boolean }): SoftwareCheck {
  assertSoftwareContract(input.contract);
  const count = input.batches.reduce((n, batch) => n + batch.requests.length, 0);
  const result = (passed: boolean, summary: string): SoftwareCheck => ({ id: input.id, passed, summary, requests: count, hidden: !!input.hidden });
  const { ledger, contract } = input;
  if (count > 100 || input.batches.some(batch => batch.requests.length < 1 || batch.requests.length > 6)) return result(false, "Observation budget or concurrent request bound exceeded.");
  if (ledger.sourceHash !== input.sourceHash || ledger.runtimeHash !== input.runtimeHash || input.batches.some(batch => batch.requests.some(item => item.response.sourceHash !== input.sourceHash))) return result(false, "Executed source or trusted runtime hash does not match the submitted artifacts.");
  if (!Number.isSafeInteger(ledger.stock) || ledger.stock < 0 || ledger.stock > contract.initialStock || !Array.isArray(ledger.orders)) return result(false, "SQLite contains invalid stock or orders.");
  if (new Set(ledger.orders.map(order => order.requestId)).size !== ledger.orders.length) return result(false, `SQLite contains ${ledger.orders.length} orders for ${new Set(ledger.orders.map(order => order.requestId)).size} purchase references: a retry created an extra order.`);
  if (new Set(ledger.orders.map(order => order.id)).size !== ledger.orders.length || ledger.orders.some(order => !Number.isSafeInteger(order.id) || order.id < 1 || typeof order.requestId !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(order.requestId) || !Number.isSafeInteger(order.quantity) || order.quantity < 1 || order.quantity > 5 || order.totalCents !== order.quantity * contract.unitPriceCents)) return result(false, "SQLite order identities, quantities or prices violate the contract.");
  if (ledger.stock !== contract.initialStock - ledger.orders.reduce((sum, order) => sum + order.quantity, 0)) return result(false, "Stock does not equal initial inventory minus persisted purchases.");
  let states: Model[] = [{ stock: contract.initialStock, orders: [] }];
  for (const [batchIndex, batch] of input.batches.entries()) {
    const next = new Map<string, Model>();
    // Concurrent groups are accepted only if some legal serial ordering explains every response.
    const visit = (state: Model, remaining: number[]) => {
      if (!remaining.length) { next.set(stateKey(state), state); return; }
      for (const index of remaining) {
        const observed = batch.requests[index]!;
        const expected = transition(state, observed.input, contract.unitPriceCents);
        const body = object(observed.response.body);
        if (expected.status !== observed.response.status || !body) continue;
        if (expected.order) {
          const persisted = ledger.orders.find(order => order.requestId === expected.order!.requestId);
          if (!persisted || body.orderId !== persisted.id || body.requestId !== expected.order.requestId || body.quantity !== expected.order.quantity || body.totalCents !== expected.order.totalCents) continue;
        } else if (typeof body.error !== "string" || !body.error.length) continue;
        visit(expected.state, remaining.filter(value => value !== index));
      }
    };
    for (const state of states) visit(state, batch.requests.map((_, index) => index));
    states = [...next.values()];
    if (!states.length) return result(false, `Request group ${batchIndex + 1}: actual HTTP responses cannot be explained by the frozen purchase/retry/stock rules.`);
  }
  const actual: Model = { stock: ledger.stock, orders: ledger.orders.map(({ requestId, quantity, totalCents }) => ({ requestId, quantity, totalCents })) };
  if (!states.some(state => stateKey(state) === stateKey(actual))) return result(false, "SQLite state differs from every legal execution of the observed requests.");
  return result(true, `Verified ${count} actual requests against HTTP responses, source hashes, and the independent SQLite snapshot.`);
}
