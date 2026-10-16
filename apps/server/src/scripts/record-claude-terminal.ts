import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config, REPO_ROOT } from "../config.js";
import { daytona } from "../daytona/client.js";
import { Computer, shellQuote } from "../daytona/computer.js";

const [command = "help", id, ...args] = process.argv.slice(2);
const remote = "/home/daytona/claude-terminal";
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function directoryFor(value: string) { assert.match(value, /^[a-zA-Z0-9_-]{1,100}$/); return join(config.DATA_DIR, "terminal-recordings", value); }
async function checked(computer: Computer, source: string, timeoutSec = 30) {
  const result = await computer.exec(source, { timeoutSec });
  assert.equal(result.exitCode, 0, `Native terminal command failed: ${result.output.slice(-600)}`);
  return result.output;
}

if (command === "help") {
  console.log("terminal:record prepare | start <id> | type <id> <text> | key <id> <key> [modifiers] | move <id> <x> <y> | highlight <id> <x1> <y1> <x2> <y2> | scroll <id> <up|down> <amount> | screenshot <id> | finish <id>");
} else if (command === "prepare") {
  const recordingId = randomUUID(), directory = directoryFor(recordingId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const sandbox = await daytona().create({ name: `claude-terminal-${recordingId.slice(0, 12)}`, snapshot: "daytona-small", public: false,
    labels: { app: "hollow-purple", purpose: "claude-terminal", recording: recordingId }, envVars: { VNC_RESOLUTION: "1600x1000" }, autoStopInterval: 30, autoDeleteInterval: -1 }, { timeout: 180 });
  const computer = new Computer(sandbox);
  await writeFile(join(directory, "recording-state.json"), JSON.stringify({ id: recordingId, sandboxId: sandbox.id, actualNativeTerminal: true, terminalHost: "Daytona", claudeProcessHost: "controller via real PTY", createdAt: Date.now() }), { mode: 0o600 });
  try {
    await sandbox.computerUse.start();
    await checked(computer, `mkdir -p ${remote}/bin /home/daytona/antibody /home/daytona/.config/xfce4/terminal`);
    for (const name of ["terminal_relay.py", "capture_terminal.py"]) await computer.writeFile(`${remote}/${name}`, await readFile(join(REPO_ROOT, "tools/recording", name)));
    const secret = { token: randomBytes(32).toString("hex"), expiresAt: Date.now() / 1000 + 3600 };
    await computer.writeFile(`${remote}/relay-secret.json`, JSON.stringify(secret));
    await checked(computer, `chmod 600 ${remote}/relay-secret.json`);
    await computer.writeFile("/home/daytona/.config/xfce4/terminal/terminalrc", "[Configuration]\nFontName=DejaVu Sans Mono 17\nColorBackground=#111318\nColorForeground=#e7e6e2\nColorSelectionBackground=#5c467d\nColorSelection=#ffffff\nMiscMenubarDefault=FALSE\nMiscBordersDefault=FALSE\nMiscBell=FALSE\nScrollingLines=30000\nScrollingBar=TERMINAL_SCROLLBAR_NONE\n");
    await computer.writeFile(`${remote}/bin/claude`, `#!/bin/sh\nexec python3 ${remote}/terminal_relay.py client --directory ${remote}\n`);
    await computer.writeFile(`${remote}/bashrc`, `export PATH="${remote}/bin:$PATH"\nexport TERM=xterm-256color\nexport COLORTERM=truecolor\nPS1='\\[\\e[38;5;141m\\]daytona \\[\\e[38;5;245m\\]~/antibody \\[\\e[0m\\]❯ '\nclear\n`);
    await checked(computer, `chmod 700 ${remote}/bin/claude; nohup python3 -u ${remote}/terminal_relay.py server --directory ${remote} >${remote}/relay.log 2>&1 </dev/null &`);
    const preview = await sandbox.getSignedPreviewUrl(8778, 3600);
    await writeFile(join(directory, "relay.json"), JSON.stringify({ url: preview.url, token: secret.token, expiresAt: secret.expiresAt }), { mode: 0o600 });
    await checked(computer, `nohup env DISPLAY=:0 xfce4-terminal --disable-server --maximize --title='Claude Code | Antibody' --working-directory=/home/daytona/antibody --command='/bin/bash --noprofile --rcfile ${remote}/bashrc -i' >${remote}/terminal.log 2>&1 </dev/null &`);
    await delay(1200); await sandbox.computerUse.keyboard.press("f11"); await delay(500);
    const screenshot = await sandbox.computerUse.screenshot.takeFullScreen(false);
    await writeFile(join(directory, "prepared-terminal.png"), Buffer.from(screenshot.screenshot!, "base64"));
    console.log(JSON.stringify({ id: recordingId, sandboxId: sandbox.id, directory, next: `python3 tools/recording/claude_pty.py --config ${join(directory, "relay.json")} --directory ${directory}` }));
  } catch (error) { await sandbox.stop().catch(() => {}); throw error; }
} else {
  assert.ok(id, "A recording ID is required."); const directory = directoryFor(id);
  const state = JSON.parse(await readFile(join(directory, "recording-state.json"), "utf8")) as { id: string; sandboxId: string };
  const sandbox = await daytona().get(state.sandboxId), computer = new Computer(sandbox);
  if (command === "start") {
    await checked(computer, `nohup env DISPLAY=:0 python3 -u ${remote}/capture_terminal.py --output ${remote}/claude-terminal.mp4 >${remote}/capture.log 2>&1 </dev/null &`);
    await delay(1000); console.log("Recording the actual native terminal and sampling real cursor movement.");
  } else if (command === "type") {
    await sandbox.computerUse.keyboard.type(args.join(" "), 45);
  } else if (command === "key") {
    assert.ok(args[0]); await sandbox.computerUse.keyboard.press(args[0], args.slice(1));
  } else if (command === "move" || command === "highlight") {
    const coordinates = args.map(Number); assert.ok(coordinates.every(value => Number.isFinite(value) && value >= 0 && value <= 1600));
    assert.equal(coordinates.length, command === "move" ? 2 : 4);
    const position = await sandbox.computerUse.mouse.getPosition();
    const startX = position.x, startY = position.y;
    assert.ok(typeof startX === "number" && typeof startY === "number");
    for (let step = 1; step <= 15; step++) {
      const t = step / 15, eased = t * t * (3 - 2 * t);
      await sandbox.computerUse.mouse.move(Math.round(startX + (coordinates[0]! - startX) * eased), Math.round(startY + (coordinates[1]! - startY) * eased));
    }
    if (command === "highlight") {
      assert.equal(coordinates.length, 4);
      await sandbox.computerUse.mouse.down(coordinates[0], coordinates[1]); await delay(100);
      for (let step = 1; step <= 20; step++) {
        await sandbox.computerUse.mouse.move(Math.round(coordinates[0]! + (coordinates[2]! - coordinates[0]!) * step / 20), Math.round(coordinates[1]! + (coordinates[3]! - coordinates[1]!) * step / 20));
      }
      await sandbox.computerUse.mouse.up(coordinates[2], coordinates[3]);
    }
  } else if (command === "scroll") {
    assert.ok(args[0] === "up" || args[0] === "down"); const amount = Number(args[1] ?? 5); assert.ok(Number.isInteger(amount) && amount > 0 && amount <= 40);
    await sandbox.computerUse.mouse.scroll(1200, 420, args[0], amount);
  } else if (command === "screenshot") {
    const screenshot = await sandbox.computerUse.screenshot.takeFullScreen(false);
    const path = join(directory, `terminal-${Date.now()}.png`); await writeFile(path, Buffer.from(screenshot.screenshot!, "base64")); console.log(path);
  } else if (command === "finish") {
    await checked(computer, `recording_pid=$(cat ${remote}/claude-terminal.capture.pid); case "$recording_pid" in ''|*[!0-9]*) exit 1;; esac; kill -TERM "$recording_pid"`);
    for (let attempt = 0; attempt < 60; attempt++) {
      if (!(await computer.exec(`test -f ${remote}/claude-terminal.mp4.cursor.json`)).exitCode) break;
      await delay(500);
    }
    for (const name of ["claude-terminal.mp4", "claude-terminal.mp4.cursor.json", "claude-terminal.capture.json"]) await sandbox.fs.downloadFile(`${remote}/${name}`, join(directory, name), 180);
    console.log(JSON.stringify({ video: join(directory, "claude-terminal.mp4"), cursorTelemetry: join(directory, "claude-terminal.mp4.cursor.json"), captions: false }));
  } else { throw new Error("Unknown terminal recording command."); }
}
