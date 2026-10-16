/** Record the real Daytona XFCE desktop while compiling, failing, and repairing RTL. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EvolutionRun } from "@hollow-purple/shared/evolution";
import { buildBlue } from "../agents/index.js";
import { auditDaytonaDesktop } from "../browser/desktop.js";
import { config, REPO_ROOT } from "../config.js";
import { daytona } from "../daytona/client.js";
import { Computer, shellQuote } from "../daytona/computer.js";
import { buildTests } from "../lab/tests.js";
import { validateRtl } from "../lab/validation.js";
import type { Observation } from "../lab/model.js";

const home = "/home/daytona/hardware";
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const hash = (source: string) => createHash("sha256").update(source).digest("hex");

function observations(text: string): Observation[][] {
  const groups: Observation[][] = [];
  for (const line of text.trim().split(/\r?\n/)) {
    if (line === "T") { groups.push([]); continue; }
    const values = line.split(" ").map(Number);
    assert.ok(groups.length && values.length === 5 && values.every(Number.isInteger));
    const [valid, data, full, empty, occupancy] = values as [number, number, number, number, number];
    assert.ok([valid, full, empty].every(value => value === 0 || value === 1));
    assert.ok(data >= 0 && data <= 65535 && occupancy >= 0 && occupancy <= 63);
    groups.at(-1)!.push({ valid: !!valid, data, full: !!full, empty: !!empty, occupancy });
  }
  return groups;
}

async function main() {
  const [runId, existingSandboxId] = process.argv.slice(2);
  assert.ok(runId && /^[a-zA-Z0-9_-]{1,100}$/.test(runId), "Pass a verified repair run ID and optionally an empty desktop sandbox ID.");
  assert.ok(!existingSandboxId || /^[a-zA-Z0-9-]+$/.test(existingSandboxId));
  const response = await fetch(`http://127.0.0.1:${config.PORT}/api/runs/${runId}`);
  assert.ok(response.ok, "Start the local controller so its durable run can be read.");
  const verified = await response.json() as EvolutionRun;
  assert.ok(verified.status === "completed" && verified.provider === "daytona");
  const parent = verified.candidates.find(candidate => candidate.failure?.reproduced);
  assert.ok(parent?.failure && verified.verificationFixture, "This walkthrough explicitly identifies its fault-seeded manual baseline.");
  const sandbox = existingSandboxId ? await daytona().get(existingSandboxId) : await daytona().create({
    snapshot: "daytona-medium", public: false, envVars: { VNC_RESOLUTION: "1600x1000" },
    labels: { app: "hollow-purple", purpose: "visible-desktop" }, autoStopInterval: 30, autoDeleteInterval: -1,
  }, { timeout: 180 });
  const sandboxId = sandbox.id;
  assert.equal(sandbox.labels?.app, "hollow-purple");
  assert.equal(sandbox.labels?.purpose, "visible-desktop", "Refusing to modify an unrelated sandbox.");
  const computer = new Computer(sandbox);
  const outputDir = join(config.DATA_DIR, "runs", runId, "native-desktop");
  await mkdir(outputDir, { recursive: true });
  await writeFile(join(outputDir, "desktop.json"), JSON.stringify({ sandboxId, createdAt: Date.now() }), { mode: 0o600 });
  if (!existingSandboxId) await sandbox.computerUse.start();
  const checked = async (command: string) => {
    const result = await computer.exec(command);
    assert.equal(result.exitCode, 0, result.output.slice(-1500));
    return result.output;
  };
  const tools = await computer.exec("command -v verilator && command -v xfce4-terminal && command -v chromium && command -v mousepad && command -v wmctrl");
  if (tools.exitCode !== 0) {
    const install = await computer.exec("sudo -n apt-get update -qq && sudo -n DEBIAN_FRONTEND=noninteractive apt-get install -y -qq verilator g++ make git mousepad wmctrl", { timeoutSec: 240 });
    assert.equal(install.exitCode, 0, "Desktop hardware toolchain installation failed.");
  }
  assert.equal((await computer.exec(`test ! -d ${home}/.git`)).exitCode, 0, "Use a fresh desktop workspace for each recording.");
  await checked(`mkdir -p ${home} /home/daytona/.config/xfce4/terminal`);
  // Only public tests go into this inspection desktop. The controller's oracle stays local.
  const tests = buildTests(parent.failure.seed, verified.regressions, parent.attacks).filter(test => !test.hidden);
  const stimulus = tests.map(test => `T\n${test.sequence.map(s => `${+s.reset} ${+s.write} ${+s.read} ${s.data}`).join("\n")}\n`).join("");
  const contractText = [verified.contract.title, "", `Frozen contract SHA-256: ${verified.contract.hash}`, "",
    ...verified.contract.rules.map(rule => `${rule.title}\n${rule.description}\n`),
    "Demo baseline: explicitly fault-seeded manual count-race fixture.",
    "Red's input sequences came from a real model job in the verified run.",
    "This desktop will compile and run them again, then request a NEW Blue repair.",
    "The independent Python oracle runs on the controller, outside this desktop.",
    "No formal proof is claimed. Hidden inputs are not published here."].join("\n");
  await computer.writeFile(`${home}/CONTRACT.txt`, contractText);
  await computer.writeFile(`${home}/fifo.sv`, parent.source);
  await computer.writeFile(`${home}/baseline.sv`, parent.source);
  await computer.writeFile(`${home}/stimuli.txt`, stimulus);
  await computer.writeFile(`${home}/red-tests.json`, JSON.stringify(tests, null, 2));
  await computer.writeFile(`${home}/verilator_driver.cpp`, await readFile(join(REPO_ROOT, "lab/verilator_driver.cpp")));
  await computer.writeFile(`${home}/build.sh`, `#!/usr/bin/env bash\nset -euo pipefail\ncd ${home}\nverilator --cc --exe --build -j 2 -Wno-fatal --top-module fifo --Mdir obj_dir fifo.sv verilator_driver.cpp -CFLAGS '-std=c++17' 2>&1 | tee build.log\n`);
  await computer.writeFile("/home/daytona/.config/xfce4/terminal/terminalrc", "[Configuration]\nFontName=Monospace 16\nColorBackground=#11151b\nColorForeground=#e6edf3\nMiscMenubarDefault=FALSE\nMiscToolbarDefault=FALSE\nScrollingLines=10000\nMiscBell=FALSE\n");
  await checked(`cd ${home} && chmod +x build.sh && git init -q && git add fifo.sv && git -c user.name=Demo -c user.email=demo@local -c commit.gpgSign=false commit -qm 'Manual count-race baseline'`);

  const signed = await sandbox.getSignedPreviewUrl(6080, 21600);
  const desktopUrl = new URL("/vnc.html", signed.url);
  desktopUrl.searchParams.set("autoconnect", "true"); desktopUrl.searchParams.set("resize", "scale");
  const chapters: { title: string; at: number }[] = [];
  const started = Date.now();
  const chapter = (title: string) => { chapters.push({ title, at: Date.now() - started }); console.log(JSON.stringify({ chapter: title })); };
  const screenshot = async (name: string) => {
    const shot = await sandbox.computerUse.screenshot.takeFullScreen(true);
    await writeFile(join(outputDir, `${name}.png`), Buffer.from(shot.screenshot!, "base64"));
  };
  const launch = async (command: string) => checked(`nohup env DISPLAY=:0 ${command} >/tmp/hollow-desktop-app.log 2>&1 </dev/null &`);
  const type = async (command: string) => {
    await sandbox.computerUse.keyboard.type(command, 15);
    await sandbox.computerUse.keyboard.press("enter");
    await pause(800);
  };
  const waitFile = async (path: string, seconds = 120) => {
    const deadline = Date.now() + seconds * 1000;
    while (Date.now() < deadline) {
      if ((await computer.exec(`test -f ${shellQuote(path)}`, { timeoutSec: 10 })).exitCode === 0) return;
      await pause(1500);
    }
    throw new Error(`Visible command did not create ${path}.`);
  };
  const grade = async (name: string) => {
    const raw = await computer.readText(`${home}/${name}.observations`);
    const actual = observations(raw);
    const result = JSON.parse(execFileSync(process.env.PYTHON_BIN ?? "python3", [join(REPO_ROOT, "lab/oracle.py")],
      { input: JSON.stringify({ tests, observations: actual, seed: parent.failure!.seed }), encoding: "utf8" })) as
      { checks: { name: string; passed: boolean; summary: string }[]; failure?: { summary: string }; cycles: number };
    await writeFile(join(outputDir, `${name}.observations`), raw);
    await writeFile(join(outputDir, `${name}.verdict.json`), JSON.stringify(result, null, 2));
    const report = [`INDEPENDENT CONTROLLER VERDICT: ${name.toUpperCase()}`, "",
      ...result.checks.map(check => `${check.passed ? "PASS" : "FAIL"}  ${check.name}`), "",
      `${result.checks.filter(check => check.passed).length}/${result.checks.length} public checks passed; ${result.cycles} simulated clock edges.`,
      result.failure?.summary ?? "All observed outputs match the frozen contract.", "",
      "Actual Verilator observations graded outside this sandbox."].join("\n");
    await computer.writeFile(`${home}/${name}.verdict.txt`, report + "\n");
    return result;
  };
  const recording = await sandbox.computerUse.recording.start(`actual-sandbox-${Date.now()}`);
  await writeFile(join(outputDir, "active-recording.json"), JSON.stringify({ sandboxId, recordingId: recording.id, desktopUrl: desktopUrl.toString() }), { mode: 0o600 });
  let completed = false;
  try {
    chapter("Actual Daytona XFCE desktop"); await pause(2000);
    await launch(`chromium --no-sandbox --disable-dev-shm-usage --no-first-run --window-size=1480,880 --window-position=50,40 file://${home}/CONTRACT.txt`);
    await pause(4500); await screenshot("01-browser-in-sandbox");
    chapter("Open the sandbox terminal and inspect the actual RTL");
    await launch(`xfce4-terminal --disable-server --maximize --title='Daytona sandbox | Verilator hardware lab' --working-directory=${home}`);
    await pause(2000);
    await type("hostname; pwd; verilator --version; git log -1 --oneline"); await pause(2200);
    await type("sed -n '27,55p' fifo.sv"); await pause(3500);
    chapter("Compile the faulty manual baseline with Verilator");
    await type("./build.sh && touch .baseline-built");
    await waitFile(`${home}/.baseline-built`); await pause(1500);
    await type("./obj_dir/Vfifo < stimuli.txt > baseline.observations; touch .baseline-simulated");
    await waitFile(`${home}/.baseline-simulated`);
    const baseline = await grade("baseline"); assert.ok(baseline.failure);
    chapter("Independent verifier reproduces the contract violation");
    await type("clear; cat baseline.verdict.txt"); await pause(6500); await screenshot("02-reproduced-failure");
    await type("printf '\\nRequesting a new Blue model repair from the controller...\\n'");
    chapter("New real Blue model call repairs the observed failure");
    const proposal = await buildBlue({ runId: `desktop-${Date.now()}`, candidateId: "repair", contract: verified.contract,
      parent, failures: verified.regressions, lessons: parent.lessons, branch: 0, generation: 1 });
    validateRtl(proposal.source);
    await computer.writeFile(`${home}/blue-repair.sv`, proposal.source);
    await computer.writeFile(`${home}/blue-response.txt`, `${proposal.label}\n\n${proposal.rationale}\n\nNew model response; tests have not run yet.\n`);
    await writeFile(join(outputDir, "blue-proposal.json"), JSON.stringify(proposal, null, 2), { mode: 0o600 });
    await type("cat blue-response.txt; diff -u fifo.sv blue-repair.sv | tail -42");
    await pause(6500); await screenshot("03-blue-repair-diff");
    chapter("Apply Blue's real RTL repair and rebuild");
    await type("cp blue-repair.sv fifo.sv; git add fifo.sv; git -c user.name=Blue -c user.email=blue@local -c commit.gpgSign=false commit -m 'Blue repair after reproduced failure'");
    await type("./build.sh && touch .repair-built");
    await waitFile(`${home}/.repair-built`);
    await type("./obj_dir/Vfifo < stimuli.txt > repaired.observations; touch .repair-simulated");
    await waitFile(`${home}/.repair-simulated`);
    const repaired = await grade("repaired"); assert.ok(repaired.checks.every(check => check.passed), "A new Blue repair failed; retain the real evidence.");
    assert.equal(await computer.readText(`${home}/fifo.sv`), proposal.source);
    chapter("Fresh hardware execution passes the inherited public regression suite");
    await type("clear; cat repaired.verdict.txt; git log -2 --oneline");
    await pause(7500); await screenshot("04-verified-repair");
    await launch(`mousepad --disable-server --line=35 ${home}/fifo.sv`);
    await pause(1500);
    await checked("DISPLAY=:0 wmctrl -r :ACTIVE: -b add,maximized_vert,maximized_horz");
    await pause(4000); await screenshot("05-actual-repaired-source");
    // Finish on the actual terminal's independently produced verdict.
    await checked("DISPLAY=:0 wmctrl -a 'Daytona sandbox | Verilator hardware lab'");
    await pause(3500);
    await writeFile(join(outputDir, "evidence.json"), JSON.stringify({ sandboxId, runId, sourceHash: hash(proposal.source),
      baselineSourceHash: hash(parent.source), fixture: "Explicitly fault-seeded manual count-race fixture", newBlueAgent: proposal.agent,
      baseline, repaired, chapters, recordedAt: new Date().toISOString(), oracleLocation: "controller; not uploaded", tests: "public only" }, null, 2), { mode: 0o600 });
    completed = true;
  } finally {
    const stopped = await sandbox.computerUse.recording.stop(recording.id!);
    const output = join(outputDir, completed ? "daytona-actual-sandbox.mp4" : "daytona-incomplete-sandbox.mp4");
    await sandbox.computerUse.recording.download(recording.id!, output);
    await writeFile(join(outputDir, "recording.json"), JSON.stringify({ sandboxId, recordingId: recording.id, completed,
      output, durationSeconds: stopped.durationSeconds, chapters, desktopUrl: desktopUrl.toString() }, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ completed, output, durationSeconds: stopped.durationSeconds }));
  }
  if (completed && config.ANCHOR_API_KEY) {
    const audit = await auditDaytonaDesktop(sandbox, outputDir);
    console.log(JSON.stringify({ actualDesktopAnchorChecks: `${audit.checks.filter(check => check.passed).length}/${audit.checks.length}` }));
  }
}

main().catch(error => { console.error(error instanceof Error ? error.message : "Desktop recording failed."); process.exitCode = 1; });
