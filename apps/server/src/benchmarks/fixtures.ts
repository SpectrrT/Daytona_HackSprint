import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RedAttack, Stimulus } from "@hollow-purple/shared/evolution";
import { REPO_ROOT } from "../config.js";

export interface BenchmarkFixture {
  id: string;
  defect: string | null;
  source: string;
  sourceHash: string;
  witnesses: RedAttack[];
}
export const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const edge = (write = false, read = false, data = 0, reset = false): Stimulus => ({ reset, write, read, data });
const reset = () => edge(false, false, 0, true);
const fill = (n: number) => Array.from({ length: n }, (_, i) => edge(true, false, i + 7));
const drain = (n: number) => Array.from({ length: n }, () => edge(false, true));

/** Controller-owned calibration witnesses. Never pass these or defect names to Red. */
export function benchmarkFixtures(): BenchmarkFixture[] {
  const base = readFileSync(join(REPO_ROOT, "lab/probe_fifo.sv"), "utf8").replace(/^\/\/[^\n]*\n/, "");
  const definitions: [string, string, string, Stimulus[]][] = [
    ["Full flag one entry early", "assign full = occupancy == 32;", "assign full = occupancy == 31;", [reset(), ...fill(31)]],
    ["Empty flag at one entry", "assign empty = occupancy == 0;", "assign empty = occupancy == 1;", [reset(), ...fill(1)]],
    ["Full replacement drops write", "(occupancy < 32 || pop)", "(occupancy < 32)", [reset(), ...fill(32), edge(true, true, 999), ...drain(32)]],
    ["Empty concurrent read bypass", "read_en && occupancy != 0", "read_en && (occupancy != 0 || write_en)", [reset(), edge(true, true, 17)]],
    ["Write suppresses reset priority", "if (reset) begin", "if (reset && !write_en) begin", [reset(), ...fill(3), edge(true, true, 99, true)]],
    ["Reset leaves nonzero occupancy", "occupancy <= 0;", "occupancy <= 1;", [reset()]],
    ["Invalid read clears held output", "read_valid <= pop;", "read_valid <= pop;\n      if (!pop) data_out <= 0;", [reset(), ...fill(1), ...drain(2)]],
    ["Read-valid sticks high", "read_valid <= pop;", "read_valid <= pop || read_valid;", [reset(), ...fill(1), ...drain(1), edge()]],
    ["Write pointer skips slots", "tail <= tail + 5'd1;", "tail <= tail + 5'd2;", [reset(), ...fill(3), ...drain(3)]],
    ["Concurrent operations increase count", "default: occupancy <= occupancy;", "default: occupancy <= occupancy + (push ? 6'd1 : 6'd0);", [reset(), ...fill(2), edge(true, true, 99)]],
  ];
  const mutants = definitions.map(([defect, before, after, sequence], index) => {
    if (base.split(before).length !== 2) throw new Error("Calibration mutation must replace exactly one source location.");
    const id = `case-${String(index + 1).padStart(2, "0")}`;
    const source = base.replace(before, after);
    return { id, defect, source, sourceHash: hash(source), witnesses: [{ id: `witness-${id}`, name: "Controller calibration witness", hypothesis: "Hand-authored witness, not a Red discovery.", sequence }] };
  });
  return [{ id: "case-00", defect: null, source: base, sourceHash: hash(base), witnesses: mutants.flatMap((fixture) => fixture.witnesses) }, ...mutants];
}
