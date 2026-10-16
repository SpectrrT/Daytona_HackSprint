import { config } from "../config.js";
import { writeBlueLesson } from "../agents/lessons.js";
import { LessonMemory, MemoryError } from "./graph.js";
import { SurrealGraphBackend } from "./surreal.js";

/** Core engine tests inject memory explicitly and never use ambient provider keys. */
export function configuredMemory(forceGraph = false): LessonMemory | undefined {
  if (!forceGraph && config.MEMORY_MODE !== "graph") return undefined;
  const values = [config.SURREAL_CONTEXT_URL, config.SURREAL_CONTEXT_ID, config.SURREAL_API_KEY];
  if (values.every((value) => !value)) return undefined;
  if (values.some((value) => !value)) throw new MemoryError("Set all three Surreal Context credentials to enable graph memory.");
  return new LessonMemory(new SurrealGraphBackend({ url: config.SURREAL_CONTEXT_URL!, context: config.SURREAL_CONTEXT_ID!, apiKey: config.SURREAL_API_KEY! }), writeBlueLesson);
}
