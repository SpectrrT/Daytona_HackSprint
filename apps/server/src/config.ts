import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const SCENARIOS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../scenarios");

const envFile = resolve(REPO_ROOT, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const bool = z.enum(["true", "false", "1", "0"]).transform((v) => v === "true" || v === "1");
const effort = z.enum(["low", "medium", "high", "xhigh", "max"]);
const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== "" ? v.trim() : undefined));

const schema = z.object({
  PORT: z.coerce.number().int().default(8787),
  DATA_DIR: z.string().default(resolve(REPO_ROOT, "data")),
  PUBLIC_DASHBOARD_URL: optionalString,
  MAX_CONCURRENT_RUNS: z.coerce.number().int().min(1).max(4).default(2),

  // ---- Daytona: production and its forks ----
  DAYTONA_API_KEY: optionalString,
  DAYTONA_API_URL: optionalString,
  DAYTONA_TARGET: optionalString,
  /** Snapshot for the production sandbox; forks inherit it. */
  PROD_SNAPSHOT: z.string().default("daytona-small"),
  SANDBOX_AUTO_STOP_MINUTES: z.coerce.number().int().min(0).default(30),
  /** Keep each round's fork after grading, for inspection. Off deletes them. */
  KEEP_FORKS: bool.default(false),
  /** Forks that run at the same time. */
  ROUND_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(4),

  // ---- Run-scoped SurrealDB Agent Memory (optional) ----
  SURREAL_CONTEXT_URL: optionalString,
  SURREAL_CONTEXT_ID: optionalString,
  SURREAL_API_KEY: optionalString,

  ARIZE_ENABLED: bool.default(false),
  ARIZE_API_KEY: optionalString,
  ARIZE_SPACE_ID: optionalString,
  ARIZE_PYTHON: optionalString,

  // ---- Claude ----
  ANTHROPIC_API_KEY: optionalString,
  /** Not read from ANTHROPIC_BASE_URL so a shell's value does not leak in. */
  CLAUDE_API_URL: z.string().default("https://api.anthropic.com"),
  /** Red (Chaos Agent), Blue (MAH0RAGA) and the grader. */
  RED_MODEL: optionalString,
  BLUE_MODEL: optionalString,
  AGENT_PROVIDER: z.enum(["codex-cli", "anthropic", "bedrock"]).default("codex-cli"),
  MEMORY_MODE: z.enum(["none", "flat", "graph"]).default("graph"),
  BEDROCK_REGION: z.string().default("us-west-2"),
  BEDROCK_CREDENTIALS_FILE: optionalString,
  AGENT_MAX_TOKENS: z.coerce.number().int().min(1024).max(16384).default(16384),
  CODEX_BIN: z.string().default("codex"),
  AGENT_TIMEOUT_SECONDS: z.coerce.number().int().min(30).max(1200).default(240),
  GRADER_MODEL: z.string().default("claude-opus-5-5"),
  AGENT_EFFORT: effort.default("high"),
  /** Default model of the agent under test; each arena can override it. */
  TARGET_MODEL: z.string().default("claude-opus-5-5"),
  TARGET_EFFORT: effort.default("medium"),
  TARGET_MAX_TURNS: z.coerce.number().int().min(3).default(25),

  // ---- Arena shape ----
  DEFAULT_GENERATIONS: z.coerce.number().int().min(1).default(3),
  DEFAULT_POPULATION: z.coerce.number().int().min(1).default(3),
  MAX_GENERATIONS: z.coerce.number().int().min(1).default(10),
  MAX_POPULATION: z.coerce.number().int().min(1).default(8),
  /** Strongest past attacks replayed against the final defense. */
  EXAM_SIZE: z.coerce.number().int().min(1).default(4),

  // ---- Anchor Browser (optional): lets the agent under test browse, and Red poison the web ----
  ANCHOR_API_KEY: optionalString,
  ANCHOR_API_URL: z.string().default("https://api.anchorbrowser.io"),
  ANCHOR_SESSION_MAX_MINUTES: z.coerce.number().int().min(1).default(30),
  ANCHOR_SESSION_IDLE_MINUTES: z.coerce.number().int().min(1).default(5),
  ANCHOR_PROXY: bool.default(false),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid Hollow Purple configuration:");
  for (const issue of parsed.error.issues) console.error(`  ${issue.path.join(".")}: ${issue.message}`);
  process.exit(1);
}

export const config = parsed.data;
export type Config = typeof config;

export class ConfigError extends Error {}

export function requireConfig<K extends keyof Config>(key: K, hint: string): NonNullable<Config[K]> {
  const value = config[key];
  if (value === undefined || value === "") {
    throw new ConfigError(`${String(key)} is not set. ${hint}`);
  }
  return value as NonNullable<Config[K]>;
}

/** Non-secret view of the configuration for the dashboard's System page. */
export function publicConfig(): Record<string, string | number | boolean> {
  return {
    redModel: config.RED_MODEL ?? "Codex configured default",
    blueModel: config.BLUE_MODEL ?? "Codex configured default",
    graderModel: config.GRADER_MODEL,
    defaultTargetModel: config.TARGET_MODEL,
    targetMaxTurns: config.TARGET_MAX_TURNS,
    prodSnapshot: config.PROD_SNAPSHOT,
    daytonaTarget: config.DAYTONA_TARGET ?? "org default",
    roundConcurrency: config.ROUND_CONCURRENCY,
    keepForks: config.KEEP_FORKS,
    anchorBrowser: config.ANCHOR_API_KEY ? "on" : "off",
  };
}
