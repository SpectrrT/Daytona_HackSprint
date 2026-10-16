import { createHash } from "node:crypto";
import type { CheckoutContract } from "@antibody/shared/software";

export const SOFTWARE_PROMPT = "Build a small checkout web app with five items in stock at 1999 cents each. A request ID identifies one purchase: retries must return the same order without charging or consuming inventory twice. Concurrent requests must not oversell.";
export const sourceHash = (source: string) => createHash("sha256").update(source).digest("hex");
export function contractHash(contract: CheckoutContract): string {
  const { hash: _hash, frozenAt: _at, ...requirements } = contract;
  return sourceHash(JSON.stringify(requirements));
}
export function freezeSoftwareContract(now = Date.now()): CheckoutContract {
  const contract: CheckoutContract = {
    id: "checkout-v1", version: 1, domain: "software", example: "checkout", title: "Checkout with safe retries and bounded stock",
    prompt: SOFTWARE_PROMPT, initialStock: 5, unitPriceCents: 1999, hash: "", frozenAt: now,
    rules: [
      { id: "inputs", title: "Validate requests", description: "POST /api/checkout accepts {requestId, quantity}. requestId is a string matching ^[a-zA-Z0-9_-]{1,64}$; quantity is a JSON integer from 1 through 5 (booleans and numeric strings are invalid). Invalid input returns HTTP 400 without changing state." },
      { id: "purchase", title: "Create a purchase", description: "A fresh request with sufficient stock returns HTTP 201 and {orderId,requestId,quantity,totalCents}. orderId is a positive unique integer. Price is exactly quantity * 1999 cents. Persist one order and reduce stock by quantity atomically." },
      { id: "retry", title: "Retries have one effect", description: "The same requestId and quantity returns HTTP 200 with the ORIGINAL order and no state change. This also applies to concurrent duplicate submissions and retries after inventory is exhausted." },
      { id: "conflict", title: "Reject changed retries", description: "A valid reused requestId with a different quantity returns HTTP 409 without changing the original order or inventory." },
      { id: "stock", title: "Never oversell", description: "If a new request exceeds remaining stock, return HTTP 409 and change no state. All simultaneous requests must admit a serial ordering consistent with their responses. Stock equals 5 minus all persisted order quantities and remains nonnegative." },
      { id: "evidence", title: "Independent evidence", description: "The controller reads SQLite directly and compares it with actual HTTP observations. A browser failure is retained only after a fresh process and database reproduce the same action sequence. Neither agent supplies a verdict." },
    ],
    acceptance: ["Every reproduced browser regression passes.", "All directed API and concurrency checks pass.", "Separate controller-owned held-out inputs pass.", "Executed source hash and trusted runtime hash match the uploaded artifacts."],
  };
  contract.hash = contractHash(contract);
  return contract;
}
export function assertSoftwareContract(contract: CheckoutContract): void {
  if (contract.hash !== contractHash(contract)) throw new Error("Software contract changed after freezing.");
}
