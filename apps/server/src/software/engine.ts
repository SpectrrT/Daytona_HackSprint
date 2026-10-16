import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserTrial, RequestBatch, SoftwareCandidate, SoftwareFailure, SoftwareRun, WebAttack } from "@hollow-purple/shared/software";
import { config, REPO_ROOT } from "../config.js";
import { daytona } from "../daytona/client.js";
import { APP_DIR, DaytonaSoftwareAdapter, LAB_DIR, pause } from "./adapter.js";
import { AnchorNativeBrowser } from "./browser.js";
import { softwareBlue, softwareRed } from "./agents.js";
import { assertSoftwareContract, freezeSoftwareContract, sourceHash } from "./contract.js";
import { softwareTests } from "./tests.js";
import { verifyCheckout } from "./verifier.js";

export interface SoftwareRunOptions {
  id?: string;
  desktopSandboxId?: string;
  prepared?: { id: string; candidate: SoftwareCandidate };
  signal?: AbortSignal;
  onEvent?: (message: string) => void;
}
export const softwareDirectory = (id: string) => {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error("Invalid software run ID.");
  return join(config.DATA_DIR, "software-runs", id);
};

/** Full, bounded software loop. Its fixed checkout adapter is independent of the FIFO engine. */
export async function runSoftwareExperiment(options: SoftwareRunOptions = {}): Promise<SoftwareRun> {
  const id = options.prepared?.id ?? options.id ?? randomUUID();
  const directory = softwareDirectory(id);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  assert.ok(config.DAYTONA_API_KEY && config.ANCHOR_API_KEY, "Daytona and Anchor must be configured for a live software run.");
  const run: SoftwareRun = { id, status: "running", contract: freezeSoftwareContract(), candidates: [], regressions: [], lessons: [], events: [], createdAt: Date.now(),
    budget: { maxCandidates: 3, maxBrowserActions: 120, maxRequests: 300, usedBrowserActions: 0, usedRequests: 0 } };
  const save = async () => {
    await writeFile(join(directory, "run.json.tmp"), JSON.stringify(run, null, 2), { mode: 0o600 });
    await rename(join(directory, "run.json.tmp"), join(directory, "run.json"));
  };
  const emit = async (message: string, candidateId?: string) => {
    const event = { at: Date.now(), message, candidateId }; run.events.push(event);
    await appendFile(join(directory, "events.ndjson"), JSON.stringify(event) + "\n", { mode: 0o600 });
    await save(); options.onEvent?.(message);
  };
  const consume = (actions: number, requests: number) => {
    options.signal?.throwIfAborted();
    if (run.budget.usedBrowserActions + actions > run.budget.maxBrowserActions || run.budget.usedRequests + requests > run.budget.maxRequests) throw new Error("The software experiment exhausted its fixed execution budget.");
    run.budget.usedBrowserActions += actions; run.budget.usedRequests += requests;
  };
  let lab: DaytonaSoftwareAdapter | undefined;
  let browser: AnchorNativeBrowser | undefined;
  let recordingId: string | undefined;
  const adapters = new Map<string, DaytonaSoftwareAdapter>();
  const terminalTitle = "Daytona sandbox | Software build and repair";
  const terminal = async (command: string, delay = 1500) => {
    assert.ok(lab);
    await lab.checked(`DISPLAY=:0 wmctrl -a '${terminalTitle}'`);
    await lab.computer.sandbox.computerUse.keyboard.type(command, 12);
    await lab.computer.sandbox.computerUse.keyboard.press("enter");
    await pause(delay);
  };
  const report = async (name: string, text: string) => {
    await lab!.computer.writeFile(`${LAB_DIR}/${name}.txt`, text + "\n");
    await terminal(`clear; cat ${name}.txt`, 2500);
  };
  const retainTrial = async (candidate: SoftwareCandidate, trial: BrowserTrial, label: string) => {
    candidate.checks.push({ ...trial.check, id: label, recordedAt: Date.now() });
    await writeFile(join(directory, `${candidate.id}-${label}.json`), JSON.stringify(trial, null, 2), { mode: 0o600 });
    await save();
  };
  const retainFailure = async (candidate: SoftwareCandidate, adapter: DaytonaSoftwareAdapter, trial: BrowserTrial): Promise<boolean> => {
    if (trial.check.passed) return false;
    const replay = await browser!.trial(adapter, trial.attack, run.contract, directory, consume, options.signal);
    assert.ok(!replay.check.passed && replay.check.summary === trial.check.summary, "The reported browser failure did not independently reproduce.");
    const failure: SoftwareFailure = { id: `${candidate.id}-${trial.attack.id}`, summary: trial.check.summary, reproduced: true, discovery: trial, replay };
    run.regressions.push(failure);
    run.lessons.push("Treat a purchase reference as one immutable operation. Make the lookup, conflict decision, stock check and persisted effects one atomic transaction.");
    await writeFile(join(directory, `${failure.id}-reproduced.json`), JSON.stringify(failure, null, 2), { mode: 0o600 });
    await emit(`Independent replay reproduced ${failure.summary}`, candidate.id);
    return true;
  };

  try {
    const source = await readFile(join(REPO_ROOT, "lab/software/fixture_checkout.py"), "utf8");
    const parent: SoftwareCandidate = options.prepared?.candidate ?? { id: "c1", label: "Imported manual checkout fixture", source, sourceHash: sourceHash(source), importedFixture: true, attacks: [], checks: [], status: "testing" };
    assert.ok(parent.importedFixture && parent.sourceHash === sourceHash(source) && parent.source === source, "Prepared baseline differs from the labelled manual fixture.");
    run.candidates.push(parent);
    await emit("Frozen software contract: real checkout, safe retries, consistent receipts, atomic stock, and independent SQLite verification.");
    lab = options.prepared ? await DaytonaSoftwareAdapter.attach(parent) : await DaytonaSoftwareAdapter.provision(id, parent, options.desktopSandboxId);
    adapters.set(parent.id, lab); run.desktopSandboxId = lab.computer.id;
    parent.commit = (await lab.checked("git rev-parse HEAD")).trim();
    if (!options.prepared) await lab.prepareDesktop();
    await lab.launch("chromium --no-sandbox --disable-dev-shm-usage --no-first-run --force-device-scale-factor=1 --remote-debugging-port=9222 --remote-allow-origins='*' --user-data-dir=/tmp/software-native-chrome --start-maximized http://127.0.0.1:8080/");
    await pause(1800);
    browser = await AnchorNativeBrowser.connect(lab, directory);
    await browser.pointAt(lab);
    const connection = JSON.parse(await readFile(join(directory, "anchor-session.json"), "utf8")) as { desktopUrl: string };
    run.desktopUrl = connection.desktopUrl;
    await emit("Anchor is connected to the actual Daytona desktop. Red's mouse and keyboard actions operate native Chromium.");
    await lab.checked("DISPLAY=:0 wmctrl -k on");
    const recording = await lab.computer.sandbox.computerUse.recording.start(`software-${id}`);
    assert.ok(recording.id); recordingId = recording.id;
    await pause(1200);
    await lab.launch(`xfce4-terminal --disable-server --maximize --title='${terminalTitle}' --working-directory=${LAB_DIR}`);
    await pause(1000);
    await terminal("hostname; pwd; python3 --version; cat CONTRACT.txt", 3000);
    await terminal("cat candidate-info.txt; sed -n '9,32p' checkout.py", 3000);
    await emit("Red is inspecting the actual legacy backend and generating browser attacks.", parent.id);
    const initialRed = await softwareRed({ runId: id, candidate: parent, contract: run.contract, failures: [], signal: options.signal });
    parent.redAgent = initialRed.agent; parent.attacks = initialRed.attacks;
    await lab.computer.writeFile(`${LAB_DIR}/red-attacks.json`, JSON.stringify(initialRed.attacks, null, 2));
    await terminal("clear; python3 -m json.tool red-attacks.json | head -40", 2500);
    for (const attack of initialRed.attacks) {
      await emit(`Anchor is executing Red's attack: ${attack.name}`, parent.id);
      const trial = await browser.trial(lab, attack, run.contract, directory, consume, options.signal);
      await retainTrial(parent, trial, `red-${attack.id}`);
      if (await retainFailure(parent, lab, trial)) break;
    }
    assert.ok(run.regressions.length, "Red did not produce a reproducible failure. No failure or repair was fabricated.");
    parent.status = "rejected"; parent.evaluatedAt = Date.now();
    await report("failure", ["INDEPENDENT VERIFIER: FAILURE REPRODUCED", "", run.regressions[0]!.summary, "",
      `Actual SQLite orders: ${run.regressions[0]!.discovery.ledger.orders.length}`, `Actual remaining stock: ${run.regressions[0]!.discovery.ledger.stock}`,
      "", "Red's exact Anchor actions failed again after a new process and empty database.", "The imported baseline is a manual fault fixture, not Blue output."].join("\n"));

    for (let branch = 0; branch < 2; branch++) {
      options.signal?.throwIfAborted(); assertSoftwareContract(run.contract);
      const candidateId = `c${branch + 2}`;
      await emit(`Blue is generating repair ${branch + 1} from independently reproduced evidence.`, candidateId);
      await terminal(`printf '\\nWaiting for real Blue repair ${branch + 1} on the controller...\\n'`, 600);
      const proposal = await softwareBlue({ runId: id, candidateId, parent, contract: run.contract, failures: run.regressions, lessons: run.lessons, branch, signal: options.signal });
      const candidate: SoftwareCandidate = { id: candidateId, parentId: parent.id, label: proposal.label, source: proposal.source, sourceHash: sourceHash(proposal.source), blueAgent: proposal.agent, rationale: proposal.rationale, attacks: [], checks: [], status: "building" };
      run.candidates.push(candidate); await save();
      await lab.computer.writeFile(`${LAB_DIR}/blue-${candidateId}.py`, candidate.source);
      await lab.computer.writeFile(`${LAB_DIR}/blue-rationale.txt`, `${candidate.label}\n\n${proposal.rationale}\n`);
      await terminal(`clear; cat blue-rationale.txt; diff -u checkout.py blue-${candidateId}.py | tail -33`, 3500);
      await terminal(`cp blue-${candidateId}.py checkout.py; git add checkout.py; git -c user.name=Blue -c user.email=blue@local -c commit.gpgSign=false commit --allow-empty -m 'Blue ${candidateId} repair'; python3 -m py_compile checkout.py`, 1500);
      assert.ok((await lab.checked("sha256sum checkout.py", LAB_DIR)).includes(candidate.sourceHash));
      let adapter: DaytonaSoftwareAdapter;
      try { adapter = await DaytonaSoftwareAdapter.provision(id, candidate, undefined, lab.computer.id); }
      catch (error) {
        candidate.status = "rejected"; candidate.evaluatedAt = Date.now(); candidate.error = error instanceof Error ? error.message : "Candidate build failed.";
        if (candidate.sandboxId) {
          const orphan = await daytona().get(candidate.sandboxId).catch(() => undefined);
          if (orphan?.labels.app === "hollow-purple" && orphan.labels.run === id && orphan.labels.candidate === candidate.id) await orphan.delete(60, true).catch(() => {});
        }
        await emit(candidate.error, candidate.id); continue;
      }
      adapters.set(candidate.id, adapter); candidate.status = "testing";
      await lab.pointDesktopAt(adapter);
      await terminal("cat candidate-info.txt", 1800);
      let browserPassed = true;
      for (const failure of run.regressions) {
        const trial = await browser.trial(adapter, failure.discovery.attack, run.contract, directory, consume, options.signal);
        await retainTrial(candidate, trial, `regression-${failure.id}`); browserPassed &&= trial.check.passed;
      }
      for (const attack of initialRed.attacks) {
        const trial = await browser.trial(adapter, attack, run.contract, directory, consume, options.signal);
        await retainTrial(candidate, trial, `inherited-${attack.id}`); browserPassed &&= trial.check.passed;
        if (!trial.check.passed && !run.regressions.some(f => JSON.stringify(f.discovery.attack.actions) === JSON.stringify(attack.actions))) await retainFailure(candidate, adapter, trial);
      }
      await emit("Red is adapting to the actual repaired source and producing new browser attacks.", candidate.id);
      const adapted = await softwareRed({ runId: id, candidate, contract: run.contract, failures: run.regressions, signal: options.signal });
      candidate.redAgent = adapted.agent; candidate.attacks = adapted.attacks;
      for (const attack of adapted.attacks) {
        const trial = await browser.trial(adapter, attack, run.contract, directory, consume, options.signal);
        await retainTrial(candidate, trial, `adapted-${attack.id}`); browserPassed &&= trial.check.passed;
        if (!trial.check.passed) await retainFailure(candidate, adapter, trial);
      }
      await emit("The independent verifier is running directed, concurrent, and held-out API checks against the actual app.", candidate.id);
      const apiChecks = [];
      for (const test of softwareTests(0x7214 + branch)) {
        await adapter.reset();
        const batches: RequestBatch[] = [];
        for (const requests of test.batches) {
          consume(0, requests.length);
          batches.push({ requests: await Promise.all(requests.map(async input => ({ input, response: await adapter.request(input) }))) });
        }
        const ledger = await adapter.observe();
        const check = verifyCheckout({ id: test.id, contract: run.contract, sourceHash: candidate.sourceHash, runtimeHash: adapter.runtimeHash, batches, ledger, hidden: test.hidden });
        candidate.checks.push({ ...check, summary: test.hidden && !check.passed ? "Independent held-out check failed." : check.summary, recordedAt: Date.now() });
        apiChecks.push(check);
        if (!test.hidden) await writeFile(join(directory, `${candidate.id}-${test.id}.json`), JSON.stringify({ batches, ledger, check }, null, 2), { mode: 0o600 });
        await save();
      }
      candidate.status = browserPassed && apiChecks.every(check => check.passed) ? "verified" : "rejected";
      candidate.evaluatedAt = Date.now();
      await report(`verdict-${candidate.id}`, [`INDEPENDENT VERIFIER: ${candidate.label}`, "", ...candidate.checks.map(check => `${check.passed ? "PASS" : "FAIL"}  ${check.id}`), "",
        `${candidate.checks.filter(check => check.passed).length}/${candidate.checks.length} checks passed.`, `Source: ${candidate.sourceHash}`, "Actual HTTP + SQLite evidence. Hidden inputs were not given to either agent."].join("\n"));
      await emit(`${candidate.label}: ${candidate.status}; ${candidate.checks.filter(check => check.passed).length}/${candidate.checks.length} checks passed.`, candidate.id);
    }
    // Later discoveries also gate earlier children; an obsolete passing result cannot win.
    for (const candidate of run.candidates.filter(candidate => candidate.status === "verified")) {
      for (const failure of run.regressions) {
        if (candidate.checks.some(check => check.id === `regression-${failure.id}` && check.passed)) continue;
        const trial = await browser.trial(adapters.get(candidate.id)!, failure.discovery.attack, run.contract, directory, consume, options.signal);
        await retainTrial(candidate, trial, `regression-${failure.id}`);
        candidate.evaluatedAt = Date.now();
        if (!trial.check.passed) candidate.status = "rejected";
      }
    }
    const winner = run.candidates.find(candidate => candidate.status === "verified");
    options.signal?.throwIfAborted();
    assert.ok(winner, "Neither real Blue repair passed every acceptance gate.");
    const winnerAdapter = adapters.get(winner.id)!;
    const finalTrial = await browser.trial(winnerAdapter, run.regressions[0]!.discovery.attack, run.contract, directory, consume, options.signal);
    assert.ok(finalTrial.check.passed);
    run.championId = winner.id;
    await emit(`Selected ${winner.id}: the original browser failure now passes, along with all regressions, new Red attacks, directed checks and held-out checks.`, winner.id);
    await report("final-verdict", ["SOFTWARE LOOP VERIFIED", "", "Red reproduced a real failure through Anchor.", "Blue wrote two actual repair candidates.", `Selected: ${winner.id} / ${winner.label}`, `${winner.checks.filter(check => check.passed).length}/${winner.checks.length} independent checks passed.`, `${run.regressions.length} permanent browser regression(s).`, "", `SQLite now has ${finalTrial.ledger.orders.length} order(s), stock ${finalTrial.ledger.stock}.`, "Browser responses match the same persisted receipt.", "", "Actual app, processes and desktop: Daytona."].join("\n"));
    await lab.checked(`DISPLAY=:0 wmctrl -r '${terminalTitle}' -b remove,maximized_vert,maximized_horz`);
    await lab.checked(`DISPLAY=:0 wmctrl -r '${terminalTitle}' -e 0,760,545,830,430`);
    await pause(5000);
    const shot = await lab.computer.sandbox.computerUse.screenshot.takeFullScreen(true);
    await writeFile(join(directory, "verified-software-desktop.png"), Buffer.from(shot.screenshot!, "base64"));
    options.signal?.throwIfAborted();
    run.status = "completed"; run.finishedAt = Date.now(); await save();
  } catch (error) {
    run.status = options.signal?.aborted ? "stopped" : "failed";
    run.error = error instanceof Error ? error.message : "Software experiment failed.";
    run.finishedAt = Date.now(); await emit(run.error);
  } finally {
    if (recordingId && lab) {
      try {
        const recording = await lab.computer.sandbox.computerUse.recording.stop(recordingId);
        const videoPath = join(directory, run.status === "completed" ? "daytona-software-sandbox.mp4" : "incomplete-software-sandbox.mp4");
        await lab.computer.sandbox.computerUse.recording.download(recordingId, videoPath);
        run.videoPath = videoPath;
        await writeFile(join(directory, "recording.json"), JSON.stringify({ recordingId, videoPath, durationSeconds: recording.durationSeconds, sandboxId: lab.computer.id, actualDesktop: true, status: run.status }), { mode: 0o600 });
      } catch { run.error = `${run.error ?? ""} Native recording could not be finalized.`.trim(); if (run.status === "completed") run.status = "failed"; }
    }
    await browser?.close(directory).catch(() => {});
    // Keep the inspection desktop and selected app available. Other app sandboxes are disposable.
    for (const [candidateId, adapter] of adapters) if (candidateId !== "c1" && candidateId !== run.championId) await adapter.destroy().catch(() => {});
    await save();
  }
  return run;
}
