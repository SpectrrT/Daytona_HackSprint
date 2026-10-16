import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import type { EngineeringContract } from "@antibody/shared/evolution";
import type { LabAction, LabAttack, LabTrial } from "@antibody/shared/agent-lab";
import { createAnchorSession, endAnchorSession, type AnchorSession } from "../browser/anchor.js";
import { DaytonaAgentAdapter, pause } from "./adapter.js";
import { targetAgent, type AgentContext } from "./agents.js";
import { verifyLab } from "./verifier.js";

/** Red inputs physically reach the native application via Anchor -> noVNC -> Chromium. */
export class LabBrowser {
  private constructor(private readonly desktop: DaytonaAgentAdapter, private readonly session: AnchorSession,
    private readonly anchor: Browser, private readonly native: Browser, readonly viewer: Page, readonly app: Page) {}
  static async connect(desktop: DaytonaAgentAdapter, directory: string): Promise<LabBrowser> {
    const session = await createAnchorSession(["antibody", "cross-domain-agent-lab"]);
    let anchor: Browser | undefined, native: Browser | undefined;
    try {
      anchor = await chromium.connectOverCDP(session.cdpUrl, { timeout: 30000 });
      const context = anchor.contexts()[0] ?? await anchor.newContext(), viewer = context.pages()[0] ?? await context.newPage();
      await viewer.setViewportSize({ width: 1640, height: 1060 }); await viewer.setExtraHTTPHeaders({ "X-Daytona-Skip-Preview-Warning": "true" });
      const preview = await desktop.computer.sandbox.getSignedPreviewUrl(6080, 21600), url = new URL("/vnc.html", preview.url);
      url.searchParams.set("autoconnect", "true"); url.searchParams.set("resize", "scale");
      await viewer.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: 30000 });
      await viewer.waitForFunction("document.querySelector('canvas')?.width===1600 && document.querySelector('canvas')?.height===1000", undefined, { timeout: 30000 });
      assert.ok((await viewer.title()).includes(desktop.computer.id), "The VNC browser is connected to the wrong sandbox.");
      const debug = JSON.parse(await desktop.checked("curl -fsS http://127.0.0.1:9222/json/version")) as { webSocketDebuggerUrl: string };
      const proxy = new URL((await desktop.computer.sandbox.getSignedPreviewUrl(9223, 21600)).url), websocket = new URL(debug.webSocketDebuggerUrl);
      websocket.protocol = "wss:"; websocket.hostname = proxy.hostname; websocket.port = proxy.port;
      native = await chromium.connectOverCDP(websocket.toString(), { timeout: 30000, headers: { "X-Daytona-Skip-Preview-Warning": "true" } });
      const app = native.contexts().flatMap(context => context.pages()).filter(page => page.url() === "http://127.0.0.1:8080/").at(-1);
      assert.ok(app, "The native agent application is missing."); await app.locator("#send").waitFor({ state: "visible" });
      await writeFile(join(directory, "anchor-session.json"), JSON.stringify({ sessionId: session.id, sandboxId: desktop.computer.id, desktopUrl: url.toString() }), { mode: 0o600 });
      await viewer.screenshot({ path: join(directory, "anchor-connected.png") });
      return new LabBrowser(desktop, session, anchor, native, viewer, app);
    } catch (error) { await native?.close().catch(() => {}); await anchor?.close().catch(() => {}); await endAnchorSession(session.id); throw error; }
  }
  private async point(id: string) {
    const box = await this.app.locator(`#${id}`).boundingBox(); assert.ok(box, `The native ${id} control is missing.`);
    const m = await this.app.evaluate("({x:screenX,y:screenY,outerWidth,outerHeight,innerWidth,innerHeight,scale:devicePixelRatio})") as { x: number; y: number; outerWidth: number; outerHeight: number; innerWidth: number; innerHeight: number; scale: number };
    assert.equal(m.scale, 1); const border = (m.outerWidth - m.innerWidth) / 2;
    const x = m.x + border + box.x + box.width / 2, y = m.y + m.outerHeight - m.innerHeight - border + box.y + box.height / 2;
    const canvas = await this.viewer.locator("canvas").boundingBox(); assert.ok(canvas && x >= 0 && x < 1600 && y >= 0 && y < 1000, `Native ${id} is outside the desktop.`);
    return { x: canvas.x + x * canvas.width / 1600, y: canvas.y + y * canvas.height / 1000 };
  }
  private async click(id: string) { const point = await this.point(id); await this.viewer.mouse.click(point.x, point.y); await pause(250); }
  private async fill(id: string, value: string) {
    await this.click(id); await this.viewer.keyboard.press("Control+a"); await this.viewer.keyboard.press("Backspace"); await this.viewer.keyboard.type(value, { delay: 3 });
    for (let n = 0; n < 20 && await this.app.locator(`#${id}`).inputValue() !== value; n++) await pause(150);
    assert.equal(await this.app.locator(`#${id}`).inputValue(), value, "Anchor's input did not reach native Chromium.");
  }
  async trial(adapter: DaytonaAgentAdapter, attack: LabAttack, contract: EngineeringContract, directory: string, context: AgentContext, consume: () => void, utilityTool?: LabAction["tool"]): Promise<LabTrial> {
    context.signal?.throwIfAborted(); await adapter.reset(); await this.desktop.pointAt(adapter);
    const health = JSON.parse(await this.desktop.checked("curl -fsS --max-time 15 http://127.0.0.1:8080/healthz")); assert.equal(health.sourceHash, adapter.candidate.sourceHash);
    await this.desktop.checked("DISPLAY=:0 wmctrl -a 'Agent Workbench'"); await this.app.reload({ waitUntil: "domcontentloaded" }); await this.app.bringToFront(); await pause(650);
    consume(); await this.click(`environment-${attack.domain}`); assert.equal(await this.app.locator("#domain").inputValue(), attack.domain);
    consume(); await this.fill("message", attack.message); consume(); await this.fill("knowledge", attack.knowledge);
    const responsePromise = this.app.waitForResponse(response => response.request().method() === "POST" && response.url() === "http://127.0.0.1:8080/api/messages", { timeout: 25000 });
    consume(); await this.click("send"); const response = await responsePromise; assert.equal(response.status(), 201);
    assert.deepEqual(response.request().postDataJSON(), { domain: attack.domain, message: attack.message, knowledge: attack.knowledge });
    assert.equal(response.headers()["x-candidate-sha256"], adapter.candidate.sourceHash);
    // CDP response.body can wait indefinitely when fetch's body was not consumed.
    // Fresh state has exactly one queued job: bind the observed POST to that actual row.
    const jobs = await adapter.jobs(); assert.equal(jobs.length, 1, "Fresh browser input did not create exactly one job.");
    const job = jobs[0]!;
    assert.deepEqual(job.input, { domain: attack.domain, message: attack.message, knowledge: attack.knowledge });
    const { agent: targetInvocation, ...proposal } = await targetAgent(context, adapter.candidate, attack);
    const completion = await adapter.request<{ tools: unknown[] }>(`/api/jobs/${job.id}/result`, { proposal, targetModel: targetInvocation.model });
    const snapshot = await adapter.observe();
    assert.deepEqual(completion.tools, snapshot.tools, "Actual gateway responses differ from the persisted tool journal.");
    const check = verifyLab({ id: attack.id, domain: attack.domain, contract, sourceHash: adapter.candidate.sourceHash, runtimeHash: adapter.runtimeHash, actions: proposal.actions, snapshot, utilityTool, kind: utilityTool ? "utility" : "browser" });
    await adapter.request(`/api/jobs/${job.id}/verdict`, { passed: check.passed, summary: check.summary }); await pause(1200);
    const screenshotPath = join(directory, `${adapter.candidate.id}-${attack.id}-${Date.now()}.png`);
    const shot = await this.desktop.computer.sandbox.computerUse.screenshot.takeFullScreen(true); await writeFile(screenshotPath, Buffer.from(shot.screenshot!, "base64"));
    return { attack, proposal, targetAgent: targetInvocation, snapshot, check, screenshotPath };
  }
  async close(directory: string) { await this.native.close().catch(() => {}); await this.anchor.close().catch(() => {}); await endAnchorSession(this.session.id); await writeFile(join(directory, "anchor-ended.json"), JSON.stringify({ sessionId: this.session.id, endedAt: Date.now() }), { mode: 0o600 }); }
}
