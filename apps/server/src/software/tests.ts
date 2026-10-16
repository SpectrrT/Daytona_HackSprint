import type { CheckoutInput } from "@antibody/shared/software";

export interface SoftwareTest { id: string; hidden: boolean; batches: CheckoutInput[][] }
const purchase = (requestId: unknown, quantity: unknown): CheckoutInput => ({ requestId, quantity });
const sequential = (...requests: CheckoutInput[]) => requests.map(input => [input]);

/** Inputs stay on the controller and are never included in either model's prompt. */
export function softwareTests(seed: number): SoftwareTest[] {
  let state = seed >>> 0 || 1;
  const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; };
  const hidden = (id: string) => ({ id, hidden: true, batches: Array.from({ length: 24 }, () => [purchase(`case-${random() % 9}`, (random() % 7) - 1)]) });
  return [
    { id: "purchase-and-price", hidden: false, batches: sequential(purchase("first", 2)) },
    { id: "sequential-retries", hidden: false, batches: sequential(purchase("retry", 2), purchase("retry", 2), purchase("retry", 2)) },
    { id: "changed-retry", hidden: false, batches: sequential(purchase("same", 1), purchase("same", 2), purchase("same", 1)) },
    { id: "stock-exhaustion-and-retry", hidden: false, batches: sequential(purchase("last", 5), purchase("extra", 1), purchase("last", 5)) },
    { id: "invalid-inputs-have-no-effects", hidden: false, batches: sequential(...[-1, 0, 1.5, "1", true, null, 6].map((quantity, index) => purchase(`bad-${index}`, quantity)), purchase("invalid key", 1), purchase("", 1)) },
    { id: "six-concurrent-duplicates", hidden: false, batches: [Array.from({ length: 6 }, () => purchase("parallel", 1))] },
    { id: "concurrent-last-stock", hidden: false, batches: [Array.from({ length: 6 }, (_, index) => purchase(`competing-${index}`, 1))] },
    hidden("held-out-a"), hidden("held-out-b"),
  ];
}
