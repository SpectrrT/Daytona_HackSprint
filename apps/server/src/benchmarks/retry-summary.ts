import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.js";
export async function retrySummary() {
  const { id } = JSON.parse(await readFile(join(config.DATA_DIR, "retry-benchmarks/latest.json"), "utf8"));
  if (typeof id !== "string" || !/^retry-[a-zA-Z0-9_-]{1,95}$/.test(id)) throw new Error("Invalid retry evidence identifier.");
  const result = JSON.parse(await readFile(join(config.DATA_DIR, "retry-benchmarks", id, "results.json"), "utf8"));
  return { id, status: result.status, model: result.model, expectedCases: 3 * result.repeats, summary: result.summary, generations: result.generations.length, arize: result.arize, scope: result.scope };
}
