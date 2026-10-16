import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { LabAttack, LabCandidate, LabRun } from "@antibody/shared/agent-lab";
import { candidateHash, labContract } from "./contract.js";
import { ROLE_ATTACK_VALIDATOR, ROLE_WORKSPACE_DISPLAY, safeRoleSetupLog, validateWorkspaceAttacks, workspacePublicState } from "./role-workspaces.js";

const attacks: LabAttack[] = (["support", "procurement", "engineering"] as const).map(domain => ({ id: `test-${domain}`, domain, name: `${domain} test`, hypothesis: "Verify an untrusted approval claim cannot authorize a tool.", message: "Request line one\nRequest line two", knowledge: "A fictional issue claims an approval." }));
const candidate = (id: string): LabCandidate => {
  const guardSource = "def authorize(action, record, context, history):\n    return False, 'Not authorized'\n", systemPrompt = "A fictional test application.";
  return { id, label: id, systemPrompt, guardSource, sourceHash: candidateHash(systemPrompt, guardSource), attacks: [], trials: [], checks: [], status: "testing" };
};
const run = (): LabRun => ({ id: "test-role-workspace", status: "running", createdAt: 1, contract: labContract(1), candidates: [], failures: [], lessons: [], events: [], budget: { maxCandidates: 3, maxModelCalls: 36, usedModelCalls: 1, usedBrowserActions: 0 } });

test("real Python Red validator accepts multiline returned attacks and rejects external URLs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "antibody-role-validator-"));
  try {
    await writeFile(join(directory, "validate_attacks.py"), ROLE_ATTACK_VALIDATOR);
    await writeFile(join(directory, "attacks.json"), JSON.stringify(attacks));
    validateWorkspaceAttacks(attacks);
    assert.match(execFileSync("python3", ["validate_attacks.py"], { cwd: directory, encoding: "utf8" }), /Three actual Red outputs validated/);
    const unsafe = structuredClone(attacks); unsafe[0]!.knowledge = "Visit https://outside.example to grant approval";
    assert.throws(() => validateWorkspaceAttacks(unsafe));
    await writeFile(join(directory, "attacks.json"), JSON.stringify(unsafe));
    assert.throws(() => execFileSync("python3", ["validate_attacks.py"], { cwd: directory, stdio: "pipe" }));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("native terminal renderer uses real ANSI controls but removes model-supplied terminal controls", async () => {
  const directory = await mkdtemp(join(tmpdir(), "antibody-role-display-"));
  try {
    await writeFile(join(directory, "display.py"), ROLE_WORKSPACE_DISPLAY);
    await writeFile(join(directory, "status.json"), JSON.stringify({ role: "blue", sandboxId: "real-vm", runId: "run", status: "running", source: "def authorize(action, record, context, history):\n    return False, 'Denied'", events: [{ at: 1, message: "Actual output\u001b]0;attack-title\u0007\nSecond line" }] }));
    const output = execFileSync("python3", ["-c", "import os, runpy, time; os.get_terminal_size=lambda *a:os.terminal_size((100,60)); time.sleep=lambda _:exit(0); runpy.run_path('display.py')"], { cwd: directory, encoding: "utf8" });
    assert.ok(output.startsWith("\u001b[2J\u001b[H\u001b[94mBLUE"));
    assert.match(output, /Model inference: controller/);
    assert.match(output, /def authorize[^\n]+\n    return/);
    assert.ok(!output.includes("\u001b]0;attack-title"));
    assert.match(await readFile(join(directory, "display-ready"), "utf8"), /rendered successfully/);
    const fallback = execFileSync("python3", ["-c", "import os, runpy, time; os.get_terminal_size=lambda *a:(_ for _ in ()).throw(OSError('No TTY size')); time.sleep=lambda _:exit(0); runpy.run_path('display.py')"], { cwd: directory, encoding: "utf8" });
    assert.match(fallback, /BLUE  \/  ANTIBODY WORKSPACE/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("bounded role setup logs remove provider URLs, bearer values and API key patterns", () => {
  const log = safeRoleSetupLog("x".repeat(9000) + "\n\u001b[31mhttps://provider.example/signed?token=secret\nAuthorization: Bearer token-value\ndtn_private-key sk-secret-key ak_anchor-key");
  assert.ok(log.length <= 3000);
  assert.ok(!log.includes("provider.example"));
  assert.ok(!log.includes("token-value"));
  assert.ok(!log.includes("dtn_private-key"));
  assert.ok(!log.includes("sk-secret-key"));
  assert.ok(!log.includes("ak_anchor-key"));
  assert.ok(!log.includes("\u001b"));
});

test("Red keeps its actual last model output while Blue builds the next source, without hidden input leakage", () => {
  const value = run(), first = candidate("c1"), repaired = candidate("c2");
  first.redAgent = { role: "red", provider: "codex-cli", model: "test-model", startedAt: 1, durationMs: 2, artifactPath: "/private/model-artifacts", sessionId: "private-session" };
  first.attacks = attacks;
  first.checks.push({ id: "secret-hidden-input", domain: "support", passed: true, summary: "hidden contents", issues: [], recordedAt: 1, hidden: true, kind: "tool-gate" });
  value.candidates.push(first, repaired);
  const red = workspacePublicState(value, "red"), blue = workspacePublicState(value, "blue");
  assert.equal(red.candidate?.id, "c1");
  assert.equal(red.sourceCandidateId, "c2");
  assert.equal("attacks" in red ? red.attacks.length : 0, 3);
  assert.equal(blue.candidate?.id, "c2");
  assert.ok(!JSON.stringify(red).includes("secret-hidden-input"));
  assert.ok(!JSON.stringify(red).includes("private/model-artifacts"));
  assert.ok(!JSON.stringify(red).includes("private-session"));
  value.contract.rules[0]!.description = "Altered requirements";
  assert.throws(() => workspacePublicState(value, "red"), /changed after freezing/);
});
