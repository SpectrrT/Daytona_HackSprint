import { benchmarkFixtures, hash } from "../benchmarks/fixtures.js";

/** Fixed before inference. All arms get the same repair source and full contract. */
export function repairChallenge(seed: number) {
  const source = benchmarkFixtures()[0]!.source;
  const cases: [string, string][][] = [
    [["(occupancy < 32 || pop)", "(occupancy < 32)"], ["default: occupancy <= occupancy;", "default: occupancy <= occupancy + (push ? 6'd1 : 6'd0);"], ["read_valid <= pop;", "read_valid <= pop;\n      if (!pop) data_out <= 0;"]],
    [["if (reset) begin", "if (reset && !write_en) begin"], ["tail <= tail + 5'd1;", "tail <= tail + 5'd2;"], ["read_valid <= pop;", "read_valid <= pop || read_valid;"]],
    [["read_en && occupancy != 0", "read_en && (occupancy != 0 || write_en)"], ["assign full = occupancy == 32;", "assign full = occupancy == 31;"], ["occupancy <= 0;", "occupancy <= 1;"]],
  ];
  const index = seed % cases.length;
  let result = source;
  for (const [before, after] of cases[index]!) {
    if (result.split(before).length !== 2) throw new Error("Frozen repair challenge mutation is not unique.");
    result = result.replace(before, after);
  }
  return { id: `repair-${index + 1}`, source: result, sourceHash: hash(result), manualFixture: true as const };
}
