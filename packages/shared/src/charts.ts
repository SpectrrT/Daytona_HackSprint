/** Verifier-derived observations only. One current row per run/pack/arm/seed/generation. */
export interface TimeseriesRow {
  run: string; pack: string; arm: string; seed: number; generation: number; t_elapsed_s: number;
  breaches_new: number; breaches_cumulative: number; fixed_cumulative: number; open_bugs: number;
  heldout_pass: number; heldout_total: number; fix_generations: number[];
}
export const MEMORY_ARM_LABELS: Record<string, string> = { none: "Claude alone", flat: "Raw retrieval", graph: "Lesson graph" };
