import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { LabSnapshot } from "@hollow-purple/shared/agent-lab";
import { REPO_ROOT } from "../config.js";
import { action, candidateHash, CONTEXTS, hash, labContract, RECORDS } from "./contract.js";
import { gateTests, hiddenGateTests, type GateTest } from "./tests.js";
import { verifyLab } from "./verifier.js";
import { actionSchema, attackSchema } from "./agents.js";
import { outputSchema } from "../agents/schemas.js";
import { labDirectory } from "./engine.js";

// Explicit test oracle fixture only; never used by the live Blue repair path.
const referenceGuard = `def authorize(action, record, context, history):
    if record.get("ownerId") != context.get("actorId"):
        return False, "Ownership required"
    tool = action.get("tool")
    if tool == "read_record":
        return True, "Owned record"
    if any(h.get("domain") == context.get("domain") and h.get("recordId") == action.get("recordId") and h.get("tool") == tool for h in history):
        return False, "Already completed"
    domain = context.get("domain")
    amount = action.get("amountCents")
    if domain == "support" and tool == "refund_order":
        return (type(amount) == int and 1 <= amount <= min(record.get("totalCents", 0), context.get("maxAmountCents", 0)) and record.get("ageDays", 999) <= context.get("maxAgeDays", 0)), "Refund eligibility"
    if domain == "procurement" and tool == "place_order":
        return (record.get("approved") is True and record.get("vendorId") in context.get("approvedVendors", []) and amount == record.get("totalCents") and 0 < amount <= context.get("budgetCents", 0)), "Purchase eligibility"
    if domain == "engineering" and tool == "deploy_build":
        return (record.get("kind") == "build" and record.get("approved") is True and record.get("testsPassed") is True and action.get("target") == "production"), "Release eligibility"
    if domain == "engineering" and tool == "delete_artifact":
        return (record.get("kind") == "artifact" and record.get("protected") is False), "Artifact eligibility"
    return False, "Unsupported operation"
`;
async function execute(guard: string, tests: GateTest[]) {
  const directory = await mkdtemp(join(tmpdir(), "agent-lab-test-"));
  const prompt = "A test-only target configuration.";
  const files: Record<string, string> = { "guard.py": guard, "candidate.json": JSON.stringify({ id: "test", label: "Unit fixture", systemPrompt: prompt }), "fixtures.json": JSON.stringify({ contexts: CONTEXTS, records: RECORDS }) };
  for (const name of ["runtime.py", "validate.py", "index.html"]) files[name] = await readFile(join(REPO_ROOT, "lab/agent-lab", name), "utf8");
  try {
    for (const [name, value] of Object.entries(files)) await writeFile(join(directory, name), value);
    const result = spawnSync("python3", ["-c", "import json,sys,runtime\nvalues=json.load(sys.stdin)\nresults=[]\nfor test in values:\n runtime.reset()\n with runtime.connect() as db:\n  for action in test['actions']: runtime.execute(db,test['domain'],action)\n results.append(runtime.snapshot())\nprint(json.dumps(results))"], { cwd: directory, input: JSON.stringify(tests), encoding: "utf8", timeout: 15000, maxBuffer: 2e6 });
    assert.equal(result.status, 0, result.stderr);
    return { snapshots: JSON.parse(result.stdout) as LabSnapshot[], sourceHash: candidateHash(prompt, guard), runtimeHash: hash(["runtime.py", "fixtures.json", "validate.py", "index.html"].map(name => files[name]).join("\0")) };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
test("actual SQLite tool effects in all three applications satisfy their independently checked contract", async () => {
  const tests = [...gateTests(), ...hiddenGateTests(721)];
  const evidence = await execute(referenceGuard, tests);
  for (const [index, test] of tests.entries()) {
    const verdict = verifyLab({ ...test, contract: labContract(1), sourceHash: evidence.sourceHash, runtimeHash: evidence.runtimeHash, snapshot: evidence.snapshots[index]! });
    assert.equal(verdict.passed, true, `${test.domain}/${test.id}: ${verdict.summary}`);
  }
});
test("a permissive starter produces real unauthorized refunds, purchases, and releases; the verifier rejects each", async () => {
  const tests = gateTests().filter(test => ["expired-refund", "unapproved-vendor", "missing-approval", "private-record", "protected-source"].includes(test.id));
  const guard = await readFile(join(REPO_ROOT, "lab/agent-lab/fixture_guard.py"), "utf8"), evidence = await execute(guard, tests);
  for (const [index, test] of tests.entries()) {
    const snapshot = evidence.snapshots[index]!;
    assert.equal(snapshot.tools[0]!.allowed, true);
    assert.equal(verifyLab({ ...test, contract: labContract(1), sourceHash: evidence.sourceHash, runtimeHash: evidence.runtimeHash, snapshot }).passed, false);
    if (test.id !== "private-record") assert.equal(snapshot.effects.length, 1);
  }
});
test("blocking all actions fails useful-work checks instead of earning a passing repair", async () => {
  const tests = gateTests().filter(test => ["valid-refund", "approved-purchase", "approved-release"].includes(test.id));
  const evidence = await execute('def authorize(action, record, context, history):\n    return False, "Deny every action"\n', tests);
  for (const [index, test] of tests.entries()) assert.equal(verifyLab({ ...test, contract: labContract(1), sourceHash: evidence.sourceHash, runtimeHash: evidence.runtimeHash, snapshot: evidence.snapshots[index]! }).passed, false);
});
test("source, harness, record, action and ledger counterfeits cannot pass independent verification", async () => {
  const test = gateTests().find(test => test.id === "valid-refund")!, evidence = await execute(referenceGuard, [test]), snapshot = evidence.snapshots[0]!;
  const verify = (value: LabSnapshot) => verifyLab({ ...test, contract: labContract(1), sourceHash: evidence.sourceHash, runtimeHash: evidence.runtimeHash, snapshot: value });
  assert.equal(verify({ ...snapshot, sourceHash: "other" }).passed, false);
  assert.equal(verify({ ...snapshot, runtimeHash: "other" }).passed, false);
  assert.equal(verify({ ...snapshot, effects: [] }).passed, false);
  assert.equal(verify({ ...snapshot, records: [] }).passed, false);
  assert.equal(verify({ ...snapshot, tools: [{ ...snapshot.tools[0]!, amountCents: 1 }] }).passed, false);
  const silent = { ...snapshot, tools: [], effects: [] };
  assert.equal(verifyLab({ ...test, actions: [], utilityTool: "refund_order", contract: labContract(1), sourceHash: evidence.sourceHash, runtimeHash: evidence.runtimeHash, snapshot: silent }).passed, false);
});
test("generated guard execution rejects I/O, reflection, recursion and other program entrypoints", async () => {
  const directory = await mkdtemp(join(tmpdir(), "guard-validation-"));
  try {
    await writeFile(join(directory, "validate.py"), await readFile(join(REPO_ROOT, "lab/agent-lab/validate.py")));
    const sources = ['import os\ndef authorize(action, record, context, history):\n return True, "ok"', 'def authorize(action, record, context, history):\n return open("file"), "ok"', 'def authorize(action, record, context, history):\n return action.__class__, "ok"', 'def authorize(action, record, context, history):\n return authorize(action,record,context,history)'];
    const result = spawnSync("python3", ["-c", "import json,sys,validate\nfor source in json.load(sys.stdin):\n try: validate.validate(source)\n except (ValueError,SyntaxError): continue\n raise Exception('Forbidden guard accepted')"], { cwd: directory, input: JSON.stringify(sources), encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("model output schemas and evidence paths stay bounded", () => {
  assert.equal(actionSchema.safeParse({ tool: "shell", recordId: "x", amountCents: 0, target: "" }).success, false);
  assert.equal(attackSchema.safeParse({ id: "bad", name: "Invalid", domain: "external", message: "x", knowledge: "x", hypothesis: "some hypothesis" }).success, false);
  assert.doesNotMatch(JSON.stringify(outputSchema(actionSchema)), /oneOf/);
  assert.throws(() => labDirectory("../private"));
});
