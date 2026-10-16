import { createHash } from "node:crypto";
import type { FrozenContract } from "@antibody/shared/evolution";

/** Recognize the first hardware example's contract; new examples require their own verifier. */
export function supportsPrompt(prompt: string): boolean {
  if (!/\b(buffer|fifo|queue)\b/i.test(prompt) || !/\b32\b/.test(prompt)) return false;
  const capacities = [...prompt.matchAll(/\b(\d+)\s*[- ]?(?:(?:sensor|data)\s+)?(?:readings?|entries|entry|slots?|words?|samples?|elements?|deep)\b/gi)];
  if (capacities.some((match) => Number(match[1]) !== 32)) return false;
  const depths = [...prompt.matchAll(/\b(?:depth|capacity)(?:\s+of)?\s*[:=]?\s*(\d+)/gi)];
  if (depths.some((match) => Number(match[1]) !== 32)) return false;
  const widths = [...prompt.matchAll(/\b(\d+)\s*[- ]?bits?\b/gi), ...prompt.matchAll(/\bwidth(?:\s+of)?\s*[:=]?\s*(\d+)/gi)];
  if (widths.some((match) => Number(match[1]) !== 16)) return false;
  return !/\b(asynchronous|multi[- ]?clock|dual[- ]?clock|overwrite|LIFO|priority queue|payment|checkout|website|UART|network|image)\b/i.test(prompt);
}

export function contractHash(contract: Omit<FrozenContract, "hash"> | FrozenContract): string {
  const { hash: _hash, id: _id, frozenAt: _time, ...requirements } = contract as FrozenContract;
  return createHash("sha256").update(JSON.stringify(requirements)).digest("hex");
}

export function freezeContract(prompt: string, now = Date.now()): FrozenContract {
  if (!supportsPrompt(prompt)) throw new Error("The current hardware example supports a 32-reading FIFO buffer. Other engineering tasks need their own contract and verifier.");
  const contract: FrozenContract = {
    id: "fifo32-v1", version: 1, title: "32 × 16-bit synchronous FIFO", prompt, hash: "", depth: 32, width: 16,
    interface: [
      { name: "clk", direction: "input", width: 1, description: "All behavior is sampled on the rising edge." },
      { name: "reset", direction: "input", width: 1, description: "Synchronous active-high reset; takes priority over read and write." },
      { name: "write_en", direction: "input", width: 1, description: "Request to enqueue data_in." },
      { name: "read_en", direction: "input", width: 1, description: "Request to dequeue the oldest reading." },
      { name: "data_in", direction: "input", width: 16, description: "Unsigned sensor reading." },
      { name: "data_out", direction: "output", width: 16, description: "Last accepted read, held between reads and zeroed on reset." },
      { name: "read_valid", direction: "output", width: 1, description: "High exactly when this edge accepted a read." },
      { name: "occupancy", direction: "output", width: 6, description: "Post-edge reading count, exposed as verification telemetry." },
      { name: "full", direction: "output", width: 1, description: "Post-edge occupancy equals 32." },
      { name: "empty", direction: "output", width: 1, description: "Post-edge occupancy equals zero." },
    ],
    rules: [
      { id: "order", title: "Preserve FIFO order", description: "An accepted read returns the oldest previously accepted write exactly once." },
      { id: "capacity", title: "Bounded capacity", description: "Occupancy stays in [0,32]. A write into a full queue is ignored unless a read is accepted on the same edge." },
      { id: "concurrent", title: "Atomic simultaneous operations", description: "Read acceptance uses pre-edge occupancy. A write is accepted if pre-edge occupancy <32 or an accepted read frees one slot. Simultaneous read/write on an empty queue enqueues only; it does not bypass data." },
      { id: "reset", title: "Reset has priority", description: "Reset empties the buffer, clears data_out and read_valid, and ignores simultaneous requests. No pre-reset reading may reappear." },
      { id: "flags", title: "Accurate status", description: "full and empty describe occupancy after the edge. Invalid reads leave data_out unchanged and deassert read_valid." },
    ],
    acceptance: ["All directed checks pass: order, simultaneous, full-replace, empty-concurrent, reset-active, red-seeded.", "Every inherited regression passes.", "Independent held-out seeded checks pass.", "A discovered failure is evidence only after independent replay reproduces it.", "Verification is simulation evidence for this contract; no formal proof is claimed."],
    frozenAt: now,
  };
  contract.hash = contractHash(contract);
  return contract;
}

export function assertFrozenContract(contract: FrozenContract): void {
  if (contract.hash !== contractHash(contract)) throw new Error("Frozen contract hash mismatch; refusing to evaluate changed requirements.");
}
