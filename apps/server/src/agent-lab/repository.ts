import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { LabCandidate, LabCheck, LabFailure, LabRepository, LabRun } from "@antibody/shared/agent-lab";

const exec = promisify(execFile);
export const GUARD_FILE = "guard.py", INSTRUCTIONS_FILE = "instructions.md";
/** git and gh get the user's own sign-in, never provider keys. Pushing happens on the controller, never in a candidate sandbox. */
const SIGN_IN_ENV = ["PATH", "HOME", "TMPDIR", "USER", "LANG", "SSH_AUTH_SOCK", "XDG_CONFIG_HOME", "GH_CONFIG_DIR", "GH_HOST", "GH_TOKEN", "GITHUB_TOKEN"];
const AUTHORS = { verifier: ["Antibody verifier", "verifier@antibody.invalid"], blue: ["Antibody Blue", "blue@antibody.invalid"] } as const;

export interface RepositoryTarget { repo: string; url: string; webUrl: string }
export type PullRequestOpener = (input: { repo: string; base: string; head: string; title: string; bodyFile: string; cwd: string }) => Promise<string>;
export function githubTarget(repo: string): RepositoryTarget {
  assert.match(repo, /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$/, "Use owner/name for the target repository.");
  return { repo, url: `https://github.com/${repo}.git`, webUrl: `https://github.com/${repo}` };
}

function signInEnv(): NodeJS.ProcessEnv { return { ...Object.fromEntries(SIGN_IN_ENV.flatMap(key => process.env[key] ? [[key, process.env[key]!] as const] : [])), GIT_TERMINAL_PROMPT: "0" }; }
function failure(command: string, error: unknown): Error {
  const detail = (error as { stderr?: string }).stderr?.trim().split("\n").filter(Boolean).at(-1) ?? (error instanceof Error ? error.message.split("\n")[0] : undefined) ?? "unknown error";
  return new Error(`${command} failed: ${detail.replace(/https?:\/\/[^\s/@]+@/g, "https://").slice(0, 300)}`);
}
const subcommand = (args: string[]) => args.find((arg, index) => !arg.startsWith("-") && args[index - 1] !== "-c") ?? "command";
async function git(cwd: string, gh: string, args: string[]): Promise<string> {
  try {
    return (await exec("git", ["-c", "credential.helper=", "-c", `credential.helper=!${gh} auth git-credential`, "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args],
      { cwd, env: signInEnv(), timeout: 90_000, maxBuffer: 4 * 1024 * 1024 })).stdout;
  } catch (error) { throw failure(`git ${subcommand(args)}`, error); }
}
const ghPullRequest = (gh: string): PullRequestOpener => async ({ repo, base, head, title, bodyFile, cwd }) => {
  try { return (await exec(gh, ["pr", "create", "--repo", repo, "--base", base, "--head", head, "--title", title, "--body-file", bodyFile], { cwd, env: signInEnv(), timeout: 90_000 })).stdout.trim().split("\n").at(-1)!; }
  catch (error) { throw failure("gh pr create", error); }
};

/** Model-written text goes in a fence longer than any backtick run inside it, so it cannot mention, link or format in GitHub. */
export function fenced(text: string): string {
  const fence = "`".repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map(match => match[0].length + 1)));
  return `${fence}text\n${text}\n${fence}`;
}
const count = (checks: LabCheck[]) => ({ passed: checks.filter(check => check.passed).length, total: checks.length });
const publicCheck = (check: LabCheck) => ({ id: check.id, domain: check.domain, kind: check.kind, hidden: check.hidden, passed: check.passed,
  summary: check.hidden ? `Held-out check ${check.passed ? "passed" : "failed"}.` : check.summary });
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function commitTitle(candidate: LabCandidate, failures: LabFailure[]): string {
  if (candidate.importedFixture) return `${candidate.id} starting code: ${plural(failures.length, "reproduced failure")}`;
  const { passed, total } = count(candidate.checks);
  return `${candidate.id} Blue repair: verifier ${candidate.status === "verified" ? "PASS" : "FAIL"} ${passed}/${total} checks`;
}
function commitBody(run: LabRun, candidate: LabCandidate, failures: LabFailure[]): string {
  const { passed, total } = count(candidate.checks), failed = candidate.checks.filter(check => !check.passed);
  return [
    candidate.importedFixture ? `Starting code from ${run.repository?.repo}@${run.repository?.baseCommit.slice(0, 12)}. It is not Blue's work.` : `Blue repair of ${candidate.parentId}. Label: ${candidate.label.replace(/\s+/g, " ").slice(0, 100)}`,
    `Independent verifier: ${candidate.status === "verified" ? "accepted" : "rejected"} (${passed}/${total} checks passed).`,
    ...(failed.length ? ["", "Failed checks:", ...failed.map(check => `- ${check.domain} / ${check.hidden ? "held-out stream" : check.id}`)] : []),
    ...(failures.length ? ["", "Reproduced after a fresh server process and database:", ...failures.map(item => `- ${item.discovery.attack.domain}: ${item.discovery.check.summary}`)] : []),
    "", `Antibody-Run: ${run.id}`, `Source-SHA256: ${candidate.sourceHash}`, `Daytona-Sandbox: ${candidate.sandboxId ?? "none"}`, `Sandbox-Commit: ${candidate.commit ?? "none"}`,
    ...(candidate.blueAgent ? [`Blue-Model: ${candidate.blueAgent.provider}/${candidate.blueAgent.model}`] : []),
  ].join("\n");
}
function versionEvidence(run: LabRun, candidate: LabCandidate) {
  return { run: run.id, contractSha256: run.contract.hash, candidate: candidate.id, parent: candidate.parentId ?? null,
    origin: candidate.importedFixture ? "starting code from the repository, not Blue" : "Blue model repair", label: candidate.label, status: candidate.status,
    sourceSha256: candidate.sourceHash, daytonaSandbox: candidate.sandboxId ?? null, sandboxCommit: candidate.commit ?? null,
    blueModel: candidate.blueAgent ? { provider: candidate.blueAgent.provider, model: candidate.blueAgent.model } : null,
    redModel: candidate.redAgent ? { provider: candidate.redAgent.provider, model: candidate.redAgent.model } : null,
    rationale: candidate.rationale ?? null, ...count(candidate.checks), checks: candidate.checks.map(publicCheck) };
}
function failureEvidence(item: LabFailure) {
  return { id: item.id, candidate: item.candidateId, domain: item.discovery.attack.domain, contentIsUntrustedEvidence: true,
    attack: { name: item.discovery.attack.name, hypothesis: item.discovery.attack.hypothesis, message: item.discovery.attack.message, retrievedReference: item.discovery.attack.knowledge },
    targetProposal: item.discovery.proposal, finding: item.discovery.check.summary, toolCalls: item.discovery.snapshot.tools, persistedEffects: item.discovery.snapshot.effects,
    freshProcessReplay: { reproduced: item.reproduced, finding: item.replay.check.summary, persistedEffects: item.replay.snapshot.effects } };
}
export function pullRequestBody(run: LabRun, champion: LabCandidate): string {
  const repository = run.repository!, { passed, total } = count(champion.checks);
  return [
    `Antibody's independent verifier accepted **${champion.id}** after it passed every gate. **Merging this pull request is the human approval.** Nothing merges automatically.`,
    "", "| | |", "| --- | --- |", `| Run | \`${run.id}\` |`, `| Starting code | \`${repository.baseCommit.slice(0, 12)}\` on \`${repository.baseBranch}\` (not Blue's work) |`,
    `| Reproduced failures | ${run.failures.length} |`, `| Accepted version | ${champion.id}: ${passed}/${total} checks passed |`,
    `| Source SHA-256 | \`${champion.sourceHash}\` |`, `| Daytona sandbox | \`${champion.sandboxId ?? "none"}\` |`,
    "", "### Failures reproduced in a fresh process", "", fenced(run.failures.map(item => `${item.candidateId} / ${item.discovery.attack.domain}: ${item.discovery.check.summary}`).join("\n") || "None"),
    "", "### Tested versions", "", ...repository.commits.map(commit => `- \`${commit.sha.slice(0, 12)}\` ${commit.title}`),
    "", "### Blue's rationale (untrusted model text)", "", fenced(champion.rationale ?? "None"),
    "", `Evidence for every version is in \`antibody/runs/${run.id}/\`. These are finite checks against synthetic records, not an overall security score.`,
  ].join("\n");
}

/** A clone of the target repository on the controller. A dry-run push proves write access before any model call; the branch appears with the first tested version. */
export class TargetRepository {
  private constructor(private readonly directory: string, private readonly gh: string, private readonly openPull: PullRequestOpener,
    readonly state: LabRepository, readonly starter: { systemPrompt: string; guardSource: string }) {}

  static async open(input: { target: RepositoryTarget; directory: string; runId: string; gh?: string; openPullRequest?: PullRequestOpener }): Promise<TargetRepository> {
    const gh = input.gh ?? "gh", directory = input.directory;
    assert.match(input.runId, /^[a-zA-Z0-9_-]{1,100}$/, "Invalid agent run ID.");
    await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
    await git(dirname(directory), gh, ["clone", "--quiet", "--no-tags", "--single-branch", input.target.url, directory]);
    const baseBranch = (await git(directory, gh, ["symbolic-ref", "--short", "HEAD"])).trim(), baseCommit = (await git(directory, gh, ["rev-parse", "HEAD"])).trim();
    const guardSource = await readFile(join(directory, GUARD_FILE), "utf8").catch(() => ""), systemPrompt = (await readFile(join(directory, INSTRUCTIONS_FILE), "utf8").catch(() => "")).trim();
    assert.ok(guardSource.trim() && systemPrompt, `${input.target.repo} must contain ${GUARD_FILE} and ${INSTRUCTIONS_FILE} on ${baseBranch}.`);
    assert.ok(Buffer.byteLength(guardSource) <= 24_000 && systemPrompt.length <= 6000, `${GUARD_FILE} or ${INSTRUCTIONS_FILE} exceeds the agent lab's source limits.`);
    const branch = `antibody/run-${input.runId}`;
    await git(directory, gh, ["switch", "--quiet", "-c", branch]);
    await git(directory, gh, ["push", "--dry-run", "--quiet", "origin", `HEAD:refs/heads/${branch}`]);
    return new TargetRepository(directory, gh, input.openPullRequest ?? ghPullRequest(gh),
      { repo: input.target.repo, webUrl: input.target.webUrl, baseBranch, baseCommit, branch, commits: [] }, { systemPrompt, guardSource });
  }

  /** One pushed commit per tested version: its code, its public checks, and the failures reproduced against it. Hidden inputs never leave the controller. */
  async commitVersion(run: LabRun, candidate: LabCandidate): Promise<LabRepository["commits"][number]> {
    assert.ok(!this.state.error, "Repository publishing stopped after an earlier error.");
    const folder = join(this.directory, "antibody", "runs", run.id), failures = run.failures.filter(item => item.candidateId === candidate.id);
    await mkdir(join(folder, "failures"), { recursive: true });
    if (!candidate.importedFixture) {
      await writeFile(join(this.directory, GUARD_FILE), candidate.guardSource);
      await writeFile(join(this.directory, INSTRUCTIONS_FILE), candidate.systemPrompt.trim() + "\n");
    }
    await writeFile(join(folder, `${candidate.id}.json`), JSON.stringify(versionEvidence(run, candidate), null, 2) + "\n");
    for (const item of failures) await writeFile(join(folder, "failures", `${item.id}.json`), JSON.stringify(failureEvidence(item), null, 2) + "\n");
    const [name, email] = AUTHORS[candidate.importedFixture ? "verifier" : "blue"], title = commitTitle(candidate, failures);
    await git(this.directory, this.gh, ["add", "--all"]);
    await git(this.directory, this.gh, ["-c", `user.name=${name}`, "-c", `user.email=${email}`, "commit", "--quiet", "--allow-empty", "-m", title, "-m", commitBody(run, candidate, failures)]);
    const sha = (await git(this.directory, this.gh, ["rev-parse", "HEAD"])).trim();
    await git(this.directory, this.gh, ["push", "--quiet", "origin", `HEAD:refs/heads/${this.state.branch}`]);
    const commit = { candidateId: candidate.id, sha, title }; this.state.commits.push(commit); return commit;
  }

  /** Only a completed run whose verified champion was pushed opens a pull request; a person merges it. */
  async openPullRequest(run: LabRun): Promise<string> {
    const champion = run.candidates.find(candidate => candidate.id === run.championId);
    assert.ok(run.status === "completed" && champion?.status === "verified", "Only a completed run with a verified champion opens a pull request.");
    assert.ok(!this.state.error && this.state.commits.some(commit => commit.candidateId === champion.id), "The champion's commit was not pushed.");
    const bodyFile = join(dirname(this.directory), "pull-request.md"); await writeFile(bodyFile, pullRequestBody(run, champion), { mode: 0o600 });
    const url = await this.openPull({ repo: this.state.repo, base: this.state.baseBranch, head: this.state.branch, title: `Verified guard repair from Antibody run ${run.id.slice(0, 8)}`, bodyFile, cwd: this.directory });
    assert.match(url, /^https:\/\/\S+$/, "The pull request URL was not returned.");
    this.state.pullRequestUrl = url; return url;
  }
}
