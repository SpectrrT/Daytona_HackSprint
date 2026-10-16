import type { CandidateVariant } from "@hollow-purple/shared/evolution";
import type { LabTest } from "./tests.js";

export interface Observation { valid: boolean; data: number; full: boolean; empty: boolean; occupancy: number }

/**
 * Explicit demo model of each RTL variant. This does not compile or prove RTL.
 * Register/pointer semantics intentionally differ from the Python deque oracle.
 */
export function observeModel(variant: CandidateVariant, tests: LabTest[]): Observation[][] {
  if (variant === "generated") throw new Error("Generated RTL has no behavioral-model substitute; compile it with Verilator.");
  return tests.map((test) => {
    const memory = Array<number>(32).fill(0);
    let count = 0, readPtr = 0, writePtr = 0, output = 0;
    return test.sequence.map((stimulus) => {
      let valid = false;
      if (stimulus.reset) {
        readPtr = writePtr = output = 0;
        if (variant !== "reset-leak") count = 0;
      } else {
        const takeRead = stimulus.read && (count !== 0 || (variant === "repair-count" && stimulus.write));
        const fullDrop = variant === "full-drop";
        const takeWrite = stimulus.write && (count !== 32 || (!fullDrop && takeRead));
        if (takeRead) {
          output = memory[readPtr]!;
          readPtr = (readPtr + 1) & 31;
          valid = true;
        }
        if (takeWrite) {
          memory[writePtr] = stimulus.data & 65535;
          writePtr = (writePtr + 1) & 31;
        }
        if (variant === "baseline") {
          // Two nonblocking writes to count: the later read assignment wins.
          if (takeRead) count = (count - 1) & 63;
          else if (takeWrite) count = (count + 1) & 63;
        } else {
          count = (count + Number(takeWrite) - Number(takeRead)) & 63;
        }
      }
      return { valid, data: output, full: count === 32, empty: count === 0, occupancy: count };
    });
  });
}
