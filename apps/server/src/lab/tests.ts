import type { FailureEvidence, RedAttack, Stimulus } from "@hollow-purple/shared/evolution";
import { validateRedAttacks, validateSequence } from "./validation.js";

export interface LabTest { id: string; name: string; hidden: boolean; sequence: Stimulus[] }
const step = (write = false, read = false, data = 0, reset = false): Stimulus => ({ reset, write, read, data: data & 65535 });
const reset = () => step(false, false, 0, true);
const fill = (n: number, offset = 1) => Array.from({ length: n }, (_, i) => step(true, false, i + offset));
const drain = (n: number) => Array.from({ length: n }, () => step(false, true));

function randomSequence(seed: number, length: number): Stimulus[] {
  let state = seed >>> 0 || 1;
  const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; };
  return [reset(), ...Array.from({ length }, () => {
    const bits = random();
    return step((bits & 3) !== 0, (bits & 12) !== 0, random() & 65535, bits % 53 === 0);
  }), ...drain(34)];
}

/** Red's fixed directed curriculum and a separate held-out seeded stream. */
export function buildTests(seed: number, regressions: FailureEvidence[], attacks: RedAttack[] = []): LabTest[] {
  return [
    ...validateRedAttacks(attacks).map((attack) => ({ id: attack.id, name: `Red: ${attack.name}`, hidden: false, sequence: attack.sequence })),
    ...regressions.map((failure, index) => {
      return { id: `regression-${index}`, name: `Regression: ${failure.testName}`, hidden: false, sequence: validateSequence(failure.sequence, "Regression", 4096) };
    }),
    { id: "order", name: "Order, empty reads, and pointer wrap", hidden: false,
      sequence: [reset(), ...drain(2), ...fill(32), step(true, false, 999), ...drain(34), ...fill(12, 100), ...drain(14)] },
    { id: "simultaneous", name: "Concurrent read/write preserves occupancy", hidden: false,
      sequence: [reset(), ...fill(8), ...Array.from({ length: 20 }, (_, i) => step(true, true, 1000 + i)), ...drain(32)] },
    { id: "full-replace", name: "Full buffer accepts a same-cycle replacement", hidden: false,
      sequence: [reset(), ...fill(32), ...Array.from({ length: 8 }, (_, i) => step(true, true, 2000 + i)), ...drain(34)] },
    { id: "empty-concurrent", name: "Empty simultaneous operations enqueue without bypass", hidden: false,
      sequence: [reset(), ...fill(32), ...drain(32), step(true, true, 71), ...drain(2)] },
    { id: "reset-active", name: "Reset wins over active reads and writes", hidden: false,
      sequence: [reset(), ...fill(19), step(true, true, 99, true), ...drain(3), step(true, true, 71), ...drain(2), ...fill(32), reset(), ...drain(3)] },
    { id: "red-seeded", name: "Red seeded long-run search", hidden: false, sequence: randomSequence(seed ^ 0x51a7b3c9, 512) },
    { id: "held-out", name: "Independent held-out sequence", hidden: true, sequence: randomSequence(seed ^ 0x9e3779b9, 1024) },
  ];
}
