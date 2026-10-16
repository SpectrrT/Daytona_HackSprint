/** Publish only compiled UI assets and a sanitized run to a private Daytona preview. */
import { chmod, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentInvocation, Candidate, EvolutionRun, EvolutionSystem } from "@hollow-purple/shared/evolution";
import { config, REPO_ROOT } from "../config.js";
import { daytona } from "../daytona/client.js";
import { shellQuote } from "../daytona/computer.js";

const REMOTE_ROOT = "/home/daytona/evidence";
const PORT = 8080;
const EXPIRY_SECONDS = 6 * 60 * 60;
const safeRunId = (value: string) => /^[a-zA-Z0-9_-]{1,100}$/.test(value);

function publicInvocation(agent: AgentInvocation | undefined): AgentInvocation | undefined {
  if (!agent) return undefined;
  const { role, provider, model, startedAt, durationMs, inputTokens, outputTokens } = agent;
  return { role, provider, model, startedAt, durationMs, inputTokens, outputTokens };
}
function publicCandidate(candidate: Candidate): Candidate {
  const { id, parentId, generation, label, variant, status, source, checks, failure, score, lessons,
    sandboxId, backend, cycles, createdAt, rationale, redRationale, attacks, buildError, sourceHash, regressionCount } = candidate;
  return { id, parentId, generation, label, variant, status, source, checks, failure, score, lessons,
    sandboxId, backend, cycles, createdAt, rationale, redRationale, attacks, buildError, sourceHash, regressionCount,
    agent: publicInvocation(candidate.agent), redAgent: publicInvocation(candidate.redAgent) };
}
/** Explicit allowlist excludes transcripts, local paths, private prompts, and browser capabilities. */
export function sanitizeRun(run: EvolutionRun): EvolutionRun {
  const { id, prompt, provider, status, contract, regressions, championId, createdAt, finishedAt, budget, summary, error, strategy, verificationFixture } = run;
  return { id, prompt, provider, status, contract, regressions, championId, createdAt, finishedAt, budget, summary, error, strategy, verificationFixture,
    candidates: run.candidates.map(publicCandidate),
    events: run.events.map(({ seq, ts, runId, type, message, candidateId }) => ({ seq, ts, runId, type, message, candidateId })) };
}
export function sanitizeSystem(system: EvolutionSystem): EvolutionSystem {
  return { providers: system.providers, agentProvider: system.agentProvider, agentsReady: system.agentsReady,
    agentModel: system.agentModel, defaultProvider: system.defaultProvider, readOnly: true,
    checks: system.checks?.map(({ name, ok }) => ({ name, ok, detail: ok ? "Available at snapshot time" : "Unavailable at snapshot time" })) };
}

async function collectAssets(directory: string): Promise<{ source: string; destination: string }[]> {
  const root = resolve(directory);
  const files: { source: string; destination: string }[] = [];
  async function visit(current: string) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".")) throw new Error("Compiled asset directory must not contain hidden files.");
      const source = resolve(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Compiled asset directory must not contain symlinks.");
      if (entry.isDirectory()) await visit(source);
      else if (entry.isFile()) {
        const path = relative(root, source).split(sep).join("/");
        if (path.startsWith("../") || path === "run.json" || path === "system.json" || path === "preview_server.py") throw new Error("Unexpected compiled asset path.");
        if ((await stat(source)).size > 20_000_000) throw new Error("Compiled asset exceeds the 20 MB upload limit.");
        files.push({ source, destination: `${REMOTE_ROOT}/${path}` });
      }
    }
  }
  await visit(root);
  if (!files.some(file => file.destination === `${REMOTE_ROOT}/index.html`)) throw new Error("Build the dashboard first: pnpm --filter @hollow-purple/web build");
  return files;
}
async function localJson<T>(path: string): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${config.PORT}${path}`, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`Local controller request failed (${response.status}).`);
  return response.json() as Promise<T>;
}

export async function publishEvidence(runId: string) {
  if (!safeRunId(runId)) throw new Error("Run id must contain 1–100 letters, digits, underscores, or hyphens.");
  const [run, system, assets, serverSource] = await Promise.all([
    localJson<EvolutionRun>(`/api/runs/${encodeURIComponent(runId)}`), localJson<EvolutionSystem>("/api/system"),
    collectAssets(resolve(REPO_ROOT, "apps/web/dist")), readFile(resolve(REPO_ROOT, "lab/preview_server.py")),
  ]);
  if (run.id !== runId) throw new Error("Controller returned a different run.");
  if (!["completed", "failed", "stopped"].includes(run.status)) throw new Error("Finish or stop the run before publishing its frozen evidence.");
  const publicRun = sanitizeRun(run);
  const publicSystem = sanitizeSystem(system);
  let phase = "creating private sandbox";
  const sandbox = await daytona().create({ snapshot: config.PROD_SNAPSHOT,
    labels: { app: "hollow-purple", run: runId, purpose: "evidence-preview" },
    public: false, autoStopInterval: 30, autoDeleteInterval: -1,
  }, { timeout: 180 }).catch(() => { throw new Error("Could not create the private evidence sandbox. Inspect the Daytona dashboard before retrying."); });
  let published = false;
  try {
    phase = "uploading the read-only evidence bundle";
    const directories = [...new Set([REMOTE_ROOT, ...assets.map(asset => dirname(asset.destination))])];
    const preparation = await sandbox.process.executeCommand(`mkdir -p ${directories.map(shellQuote).join(" ")}`, undefined, undefined, 20);
    if (preparation.exitCode !== 0) throw new Error("Cannot prepare preview directory.");
    await sandbox.fs.uploadFiles([...assets,
      { source: Buffer.from(JSON.stringify(publicRun)), destination: `${REMOTE_ROOT}/run.json` },
      { source: Buffer.from(JSON.stringify(publicSystem)), destination: `${REMOTE_ROOT}/system.json` },
      { source: serverSource, destination: `${REMOTE_ROOT}/preview_server.py` },
    ], 120);
    phase = "starting the fixed evidence HTTP server";
    await sandbox.process.createSession("evidence-preview");
    await sandbox.process.executeSessionCommand("evidence-preview", {
      command: `python3 ${REMOTE_ROOT}/preview_server.py --root ${REMOTE_ROOT} --port ${PORT}`,
      runAsync: true,
    }, 20);
    const health = await sandbox.process.executeCommand(
      `python3 -c 'import json,time,urllib.request\nfor attempt in range(20):\n try:\n  data=json.load(urllib.request.urlopen("http://127.0.0.1:8080/api/system",timeout=2)); assert data.get("readOnly") is True; break\n except Exception:\n  if attempt == 19: raise\n  time.sleep(0.5)'`, undefined, undefined, 20);
    if (health.exitCode !== 0) throw new Error("Read-only preview server did not become healthy.");
    phase = "signing the private preview capability";
    const signed = await sandbox.getSignedPreviewUrl(PORT, EXPIRY_SECONDS);
    const url = new URL(signed.url);
    if (url.protocol !== "https:") throw new Error("Preview must use HTTPS.");
    url.searchParams.set("run", runId);
    const createdAt = Date.now();
    const metadata = { version: 1, runId, sandboxId: sandbox.id, port: PORT, url: url.toString(), createdAt,
      expiresAt: createdAt + EXPIRY_SECONDS * 1000, autoStopMinutes: 30, public: false, readOnly: true,
      assetCount: assets.length, snapshot: config.PROD_SNAPSHOT, remoteRoot: REMOTE_ROOT };
    phase = "saving private preview metadata";
    const directory = resolve(config.DATA_DIR, "runs", runId);
    await mkdir(directory, { recursive: true });
    const metadataPath = resolve(directory, "evidence-preview.json");
    await writeFile(metadataPath, JSON.stringify(metadata, null, 2) + "\n", { mode: 0o600 });
    await chmod(metadataPath, 0o600);
    published = true;
    return { ...metadata, metadataPath };
  } catch {
    throw new Error(`Evidence publishing failed while ${phase}. Sandbox ${sandbox.id} will be cleaned up; inspect the Daytona dashboard for provider diagnostics.`);
  } finally {
    if (!published) await sandbox.delete(60, true).catch(() => { console.error(`Preview cleanup failed. Delete sandbox ${sandbox.id} in Daytona.`); });
  }
}

async function main() {
  const args = process.argv.slice(2);
  const runId = args.find(arg => arg.startsWith("--run="))?.slice(6) ?? args[0];
  if (!runId || !safeRunId(runId)) throw new Error("Usage: node --import tsx src/scripts/publish-evidence.ts <run-id>");
  const result = await publishEvidence(runId);
  // This is a user-authorized, expiring evidence capability, never a provider/CDP credential.
  console.log(JSON.stringify({ sandboxId: result.sandboxId, url: result.url, metadataPath: result.metadataPath,
    expiresAt: result.expiresAt, autoStopMinutes: result.autoStopMinutes, readOnly: true }, null, 2));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch(error => { console.error(error instanceof Error && !/(?:api.?key|authorization|token=)/i.test(error.message) ? error.message : "Evidence publishing failed. Inspect local controller and Daytona status."); process.exitCode = 1; });
}
