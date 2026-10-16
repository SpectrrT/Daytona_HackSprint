/** Record real Anchor browser interactions with a verified Daytona evidence snapshot. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type CDPSession, type Page } from "playwright-core";
import type { EvolutionRun } from "@hollow-purple/shared/evolution";
import { config } from "../config.js";
import { createAnchorSession, endAnchorSession } from "../browser/anchor.js";
import { dashboardUrl } from "../browser/session.js";

const FPS = 15;
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function caption(page: Page, title: string, detail: string) {
  await page.locator("body").evaluate((element, { title, detail }) => {
    const document = element.ownerDocument;
    let box = document.getElementById("demo-caption");
    if (!box) {
      box = document.createElement("div");
      box.id = "demo-caption";
      Object.assign(box.style, { position: "fixed", bottom: "18px", left: "50%", transform: "translateX(-50%)", width: "min(1120px,90vw)",
        boxSizing: "border-box", padding: "17px 24px", background: "rgba(26,32,30,.96)", color: "#fff", border: "1px solid #667567",
        borderRadius: "14px", zIndex: "2147483647", boxShadow: "0 12px 40px #0004", fontFamily: "system-ui,sans-serif", pointerEvents: "none" });
      document.body.append(box);
    }
    box.replaceChildren();
    const label = document.createElement("div"); label.textContent = "VERIFIED RUN · EVIDENCE REPLAY";
    Object.assign(label.style, { fontSize: "10px", color: "#b6cbbd", letterSpacing: "2px", marginBottom: "5px" });
    const heading = document.createElement("div"); heading.textContent = title;
    Object.assign(heading.style, { fontSize: "21px", fontWeight: "650", marginBottom: "4px" });
    const body = document.createElement("div"); body.textContent = detail;
    Object.assign(body.style, { fontSize: "15px", lineHeight: "1.4", color: "#e2e8e3" });
    box.append(label, heading, body);
  }, { title, detail });
}

async function startRecording(page: Page, output: string) {
  const cdp: CDPSession = await page.context().newCDPSession(page);
  const encoder = spawn(process.env.FFMPEG_BIN ?? "ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "image2pipe", "-vcodec", "mjpeg",
    "-framerate", String(FPS), "-i", "pipe:0", "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
    "-movflags", "+faststart", output], { stdio: ["pipe", "ignore", "pipe"] });
  let frame: Buffer | undefined;
  let failure: Error | undefined;
  let encoderError = "";
  encoder.on("error", () => { failure = new Error("Could not start ffmpeg. Install ffmpeg or set FFMPEG_BIN."); });
  encoder.stdin.on("error", () => { failure ??= new Error("Video encoder input closed unexpectedly."); });
  encoder.stderr.on("data", (data: Buffer) => { encoderError = (encoderError + data.toString()).slice(-2000); });
  const exited = new Promise<number | null>(resolve => encoder.on("close", resolve));
  cdp.on("Page.screencastFrame", (event: { data: string; sessionId: number }) => {
    frame = Buffer.from(event.data, "base64");
    void cdp.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 85, maxWidth: 1600, maxHeight: 1000, everyNthFrame: 1 });
  for (let attempt = 0; !frame && attempt < 50 && !failure; attempt++) await pause(100);
  if (!frame || failure) {
    encoder.kill("SIGTERM"); await cdp.detach().catch(() => {});
    throw failure ?? new Error("Anchor did not provide browser video frames.");
  }
  const timer = setInterval(() => { if (frame && !failure && !encoder.stdin.writableNeedDrain) encoder.stdin.write(frame); }, 1000 / FPS);
  let stopped = false;
  return async () => {
    if (stopped) return;
    stopped = true; clearInterval(timer);
    await cdp.send("Page.stopScreencast").catch(() => {});
    await cdp.detach().catch(() => {});
    encoder.stdin.end();
    const timeout = setTimeout(() => encoder.kill("SIGKILL"), 20_000);
    const code = await exited; clearTimeout(timeout);
    if (failure || code !== 0) throw new Error(`Browser video encoding failed (${code ?? "signal"}). ${encoderError.slice(0, 500)}`);
    assert.ok((await stat(output)).size > 10_000, "Browser recording is empty.");
  };
}

async function main() {
  const runId = process.argv[2];
  if (!runId || !/^[a-zA-Z0-9_-]{1,100}$/.test(runId)) throw new Error("Usage: node --import tsx src/scripts/record-demo.ts <verified-run-id>");
  const directory = join(config.DATA_DIR, "runs", runId);
  const metadata = JSON.parse(await readFile(join(directory, "evidence-preview.json"), "utf8")) as { url: string; readOnly: boolean; expiresAt: number };
  assert.ok(metadata.readOnly && metadata.expiresAt > Date.now(), "Publish a current read-only preview first.");
  const url = dashboardUrl(metadata.url);
  assert.equal(url.searchParams.get("run"), runId);
  const response = await fetch(`http://127.0.0.1:${config.PORT}/api/runs/${runId}`, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error("The local controller must contain the completed run before recording.");
  const run = await response.json() as EvolutionRun;
  assert.ok(run.status === "completed" && run.provider === "daytona" && run.strategy === "agents");
  const baseline = run.candidates.find(candidate => candidate.failure?.reproduced);
  const champion = run.candidates.find(candidate => candidate.id === run.championId);
  assert.ok(baseline?.failure && champion?.agent && champion.parentId === baseline.id);
  const children = run.candidates.filter(candidate => candidate.parentId === baseline.id && candidate.agent);
  assert.ok(children.length >= 2 && children.every(candidate => candidate.backend === "verilator" && candidate.checks.every(check => check.passed)));
  await mkdir(directory, { recursive: true });
  const output = join(directory, "hollow-purple-daytona-walkthrough.mp4");
  const session = await createAnchorSession(["hollow-purple", "verified-video"]);
  let stop: (() => Promise<void>) | undefined;
  let browser;
  const chapters: { title: string; wallTime: number }[] = [];
  const started = Date.now();
  const chapter = async (page: Page, title: string, detail: string) => {
    chapters.push({ title, wallTime: Date.now() - started });
    await caption(page, title, detail);
    console.log(JSON.stringify({ chapter: title }));
  };
  try {
    browser = await chromium.connectOverCDP(session.cdpUrl, { timeout: 30_000 });
    const context = browser.contexts()[0] ?? await browser.newContext();
    const page = context.pages()[0] ?? await context.newPage();
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.setExtraHTTPHeaders({ "X-Daytona-Skip-Preview-Warning": "true" });
    await page.setContent('<html><head><title>Hollow Purple walkthrough</title></head><body style="margin:0;background:#f6f6f2;color:#27362c;font-family:system-ui;display:grid;place-items:center;height:100vh"><main style="max-width:1050px"><div style="font-size:16px;letter-spacing:4px;color:#857391">HOLLOW PURPLE / DAYTONA + ANCHOR</div><h1 style="font-size:72px;line-height:1.1;letter-spacing:-3px">A failure becomes<br>a better design.</h1><p style="font-size:27px;color:#697267">Open the lab → reproduce the failure → inspect Blue’s repairs.</p><p style="font-size:20px;color:#857391">A walkthrough of a completed, independently verified hardware run.</p></main></body></html>');
    stop = await startRecording(page, output);
    await chapter(page, "Actual cloud execution, replayed for inspection", run.verificationFixture ? "The first source is an explicitly fault-seeded manual fixture. Real Blue agents wrote both repair children; Red and Daytona tested them." : "These are recorded model proposals and actual Verilator results, not a newly running generation.");
    await pause(4500);
    await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.getByTestId("lineage-graph").waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(await page.getByTestId("app-shell").getAttribute("data-run-id"), runId);
    await chapter(page, "1 · Open the Daytona-hosted engineering lab", "Anchor drives this real cloud browser. The published dashboard is a read-only snapshot of the verified run.");
    await pause(5000);
    const nav = page.getByRole("navigation", { name: "Main navigation" });
    await nav.getByRole("button", { name: "Contract", exact: true }).click();
    await page.getByTestId("contract-panel").waitFor();
    await chapter(page, "2 · Freeze the contract", "32 readings, FIFO ordering, full-buffer replacement, concurrent operations, and reset. The SHA-256 contract stays unchanged across repairs.");
    await pause(6500);
    await nav.getByRole("button", { name: "Lineage", exact: true }).click();
    await page.locator(".candidate-card").nth(run.candidates.indexOf(baseline)).click();
    await page.getByTestId("lineage-graph").evaluate(node => node.scrollIntoView({ behavior: "smooth", block: "center" }));
    await chapter(page, "3 · Red finds a reproducible failure", baseline.failure.summary);
    await pause(5500);
    await nav.getByRole("button", { name: /Evidence/ }).click();
    await page.locator(".evidence-facts").scrollIntoViewIfNeeded();
    await chapter(page, "4 · Replay the failure evidence", "The verifier replayed the exact input sequence in a fresh simulator. The waveform exposes the wrong occupancy and full flag.");
    await page.getByRole("button", { name: "Restart replay", exact: true }).click();
    await page.getByRole("button", { name: "Play trace replay", exact: true }).click();
    await pause(4500);
    const pauseButton = page.getByRole("button", { name: "Pause replay", exact: true });
    if (await pauseButton.isVisible()) await pauseButton.click();
    await page.locator(".sequence-details > summary").click();
    await page.locator(".sequence-details").scrollIntoViewIfNeeded();
    await page.locator(".sequence-details .table-scroll").evaluate(node => node.scrollTo({ top: node.scrollHeight, behavior: "smooth" }));
    await pause(5500);
    await nav.getByRole("button", { name: "Overview", exact: true }).click();
    await page.getByRole("button", { name: "View source", exact: true }).click();
    await page.getByRole("dialog").waitFor();
    await chapter(page, "5 · Inspect the faulty source", "Two separate nonblocking assignments update count. When a read and write are both accepted, the later decrement overwrites the increment.");
    await page.locator(".source-code").evaluate(node => { node.style.fontSize = "16px"; node.scrollTo({ top: node.scrollHeight, behavior: "smooth" }); });
    await pause(7500);
    await page.getByRole("button", { name: "Close source", exact: true }).click();
    await nav.getByRole("button", { name: "Lineage", exact: true }).click();
    await page.locator(".candidate-card").nth(run.candidates.indexOf(champion)).click();
    await page.getByTestId("lineage-graph").evaluate(node => node.scrollIntoView({ behavior: "smooth", block: "center" }));
    await chapter(page, "6 · Blue creates two repaired descendants", "Each child has its own model-written RTL, source hash, Red search, and actual Daytona simulation. The reproduced failure becomes a permanent regression.");
    await pause(5000);
    await page.locator(".agent-invocation.blue > summary").click();
    await pause(4000);
    await page.locator(".agent-invocation.blue > summary").click();
    await page.getByRole("button", { name: "View source", exact: true }).click();
    await page.getByRole("dialog").waitFor();
    await chapter(page, "7 · Inspect Blue’s actual fix", champion.rationale ?? "Blue repaired the source using the reproduced evidence; the independent verifier checked the result.");
    await page.locator(".source-code").evaluate(node => { node.style.fontSize = "16px"; node.scrollTo({ top: node.scrollHeight, behavior: "smooth" }); });
    await pause(8500);
    await page.getByRole("button", { name: "Close source", exact: true }).click();
    const alternative = children.find(candidate => candidate.id !== champion.id)!;
    await page.locator(".candidate-card").nth(run.candidates.indexOf(alternative)).click();
    await chapter(page, "8 · Independently verify both repairs", `${champion.checks.length}/${champion.checks.length} checks passed for the champion; ${alternative.checks.length}/${alternative.checks.length} for the alternative. Both pass the retained regression and separate hidden checks.`);
    await pause(5500);
    await nav.getByRole("button", { name: "Overview", exact: true }).click();
    await page.locator(".candidate-card").nth(run.candidates.indexOf(champion)).click();
    await page.getByTestId("lineage-graph").evaluate(node => node.scrollIntoView({ behavior: "smooth", block: "center" }));
    await chapter(page, "A verified improvement, with evidence retained", `${run.budget.usedCycles.toLocaleString()} measured Verilator cycles · ${children.length} model-written repairs · ${run.regressions.length} retained regression. Simulation coverage; no formal proof claimed.`);
    await pause(7500);
    await writeFile(join(directory, "demo-poster.png"), await page.screenshot(), { mode: 0o600 });
    await stop(); stop = undefined;
    const report = { runId, videoPath: output, replay: true, importedFixture: Boolean(run.verificationFixture), sessionId: session.id,
      recordedAt: Date.now(), durationMs: Date.now() - started, chapters, cycles: run.budget.usedCycles, repairs: children.length, regressions: run.regressions.length };
    await writeFile(join(directory, "video-recording.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await stop?.().catch(() => {});
    await browser?.close().catch(() => {});
    await endAnchorSession(session.id);
  }
}
void main().catch(error => { console.error(error instanceof Error && !/(?:api.?key|authorization|token=|wss?:)/i.test(error.message) ? error.message.slice(0, 1000) : "Video recording failed. Inspect the Anchor session and local recording status."); process.exitCode = 1; });
