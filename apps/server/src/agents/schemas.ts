import { z } from "zod";

export const BLUE_SOURCE_LIMIT = 40_000;
export const RED_ATTACK_COUNT = 4;
export const RED_SEQUENCE_LIMIT = 256;
export const RED_TOTAL_LIMIT = RED_ATTACK_COUNT * RED_SEQUENCE_LIMIT;

export const blueAnswerSchema = z.object({
  label: z.string().min(3).max(120),
  source: z.string().min(40).max(BLUE_SOURCE_LIMIT).regex(/^[\x09\x0a\x0d\x20-\x7e]*$/, "RTL must contain plain ASCII text."),
  rationale: z.string().min(10).max(4000),
}).strict();

export const stimulusSchema = z.object({
  reset: z.boolean(), write: z.boolean(), read: z.boolean(), data: z.number().int().min(0).max(65535),
}).strict();
export const redAnswerSchema = z.object({
  attacks: z.array(z.object({
    id: z.string().regex(/^[a-z][a-z0-9-]{0,49}$/),
    name: z.string().min(3).max(120),
    hypothesis: z.string().min(10).max(2000),
    sequence: z.array(stimulusSchema).min(1).max(RED_SEQUENCE_LIMIT),
  }).strict()).length(RED_ATTACK_COUNT),
  rationale: z.string().min(10).max(4000),
}).strict();

export function parseBlueAnswer(value: unknown): z.infer<typeof blueAnswerSchema> {
  return blueAnswerSchema.parse(value);
}
export function parseRedAnswer(value: unknown): z.infer<typeof redAnswerSchema> {
  const answer = redAnswerSchema.parse(value);
  if (answer.attacks.some((attack) => attack.id.startsWith("agent-red-"))) throw new Error("Red IDs must omit the controller-owned prefix.");
  if (new Set(answer.attacks.map((attack) => attack.id)).size !== answer.attacks.length) throw new Error("Red attack IDs must be unique.");
  if (answer.attacks.some((attack) => attack.sequence[0]?.reset !== true)) throw new Error("Every Red sequence must begin with a reset edge.");
  if (answer.attacks.reduce((total, attack) => total + attack.sequence.length, 0) > RED_TOTAL_LIMIT) throw new Error("Red attack cycle budget exceeded.");
  if (new Set(answer.attacks.map((attack) => JSON.stringify(attack.sequence))).size !== answer.attacks.length) throw new Error("Red must produce four distinct input sequences.");
  return answer;
}
export function outputSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _dialect, ...jsonSchema } = z.toJSONSchema(schema);
  return jsonSchema;
}
