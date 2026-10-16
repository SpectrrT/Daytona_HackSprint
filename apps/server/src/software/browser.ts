import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Browser, type Page, type Response } from "playwright-core";
import type { BrowserTrial, CheckoutContract, CheckoutInput, ObservedRequest, RequestBatch, WebAction, WebAttack } from "@antibody/shared/software";
import { createAnchorSession, endAnchorSession, type AnchorSession } from "../browser/anchor.js";
import { DaytonaSoftwareAdapter, pause } from "./adapter.js";
import { verifyCheckout } from "./verifier.js";

/** Anchor sends real keyboard/mouse input through noVNC to Chromium inside Daytona.
 * A separate CDP connection reads element geometry and confirms actions; it never clicks or fills.
 */
export class AnchorNativeBrowser {
  private constructor(readonly lab: DaytonaSoftwareAdapter, private readonly session: AnchorSession,
    private readonly anchor: Browser, private readonly native: Browser, readonly viewer: Page, readonly app: Page) {}

  static async connect(lab: DaytonaSoftwareAdapter, directory: string): Promise<AnchorNativeBrowser> {
    const session = await createAnchorSession(["antibody", "software-red", "actual-daytona-desktop"]);
    let anchor: Browser | undefined, native: Browser | undefined;
    try {
      try { anchor = await chromium.connectOverCDP(session.cdpUrl, { timeout: 30000 }); }
      catch { throw new Error("Anchor session could not connect for software testing."); }
      const context = anchor.contexts()[0] ?? await anchor.newContext();
      const viewer = context.pages()[0] ?? await context.newPage();
      await viewer.setViewportSize({ width: 1640, height: 1060 });
      await viewer.setExtraHTTPHeaders({ "X-Daytona-Skip-Preview-Warning": "true" });
      const preview = await lab.computer.sandbox.getSignedPreviewUrl(6080, 21600);
      const desktopUrl = new URL("/vnc.html", preview.url);
      desktopUrl.searchParams.set("autoconnect", "true"); desktopUrl.searchParams.set("resize", "scale");
      await viewer.goto(desktopUrl.toString(), { waitUntil: "domcontentloaded", timeout: 30000 });
      await viewer.locator("canvas").waitFor({ state: "visible", timeout: 30000 });
      await viewer.waitForFunction("document.querySelector('canvas')?.width===1600 && document.querySelector('canvas')?.height===1000", undefined, { timeout: 30000 });
      assert.ok((await viewer.title()).includes(lab.computer.id), "VNC connected to the wrong sandbox.");

      const debug = JSON.parse(await lab.checked("curl -fsS http://127.0.0.1:9222/json/version")) as { webSocketDebuggerUrl: string };
      const remote = await lab.computer.sandbox.getSignedPreviewUrl(9223, 21600);
      const websocket = new URL(debug.webSocketDebuggerUrl);
      const proxy = new URL(remote.url);
      websocket.protocol = "wss:"; websocket.hostname = proxy.hostname; websocket.port = proxy.port;
      try { native = await chromium.connectOverCDP(websocket.toString(), { timeout: 30000, headers: { "X-Daytona-Skip-Preview-Warning": "true" } }); }
      catch { throw new Error("Cannot read the sandbox browser geometry through its private CDP endpoint."); }
      const app = native.contexts().flatMap(context => context.pages()).filter(page => page.url() === "http://127.0.0.1:8080/").at(-1);
      assert.ok(app, "The native storefront window is missing.");
      await app.locator("#checkout").waitFor({ state: "visible", timeout: 15000 });
      await viewer.screenshot({ path: join(directory, "anchor-desktop-connected.png") });
      await writeFile(join(directory, "anchor-session.json"), JSON.stringify({ sessionId: session.id, sandboxId: lab.computer.id, desktopUrl: desktopUrl.toString(), connectedAt: Date.now() }), { mode: 0o600 });
      return new AnchorNativeBrowser(lab, session, anchor, native, viewer, app);
    } catch (error) {
      await native?.close().catch(() => {}); await anchor?.close().catch(() => {}); await endAnchorSession(session.id);
      throw error;
    }
  }

  async pointAt(candidate: DaytonaSoftwareAdapter): Promise<void> {
    await this.lab.pointDesktopAt(candidate);
    const health = JSON.parse(await this.lab.checked("curl -fsS --max-time 10 http://127.0.0.1:8080/api/state")) as { sourceHash: string };
    assert.equal(health.sourceHash, candidate.candidate.sourceHash, "The visible storefront is not connected to the selected backend.");
    await this.lab.checked("DISPLAY=:0 wmctrl -a 'Field Kit'");
    // Fresh-test setup, not an adversarial action. Red's interactions below all go through Anchor.
    await this.app.reload({ waitUntil: "domcontentloaded" });
    await this.app.bringToFront();
    await this.app.locator("#checkout").waitFor({ state: "visible" });
    await pause(900);
  }

  private async coordinates(target: "request-id" | "quantity" | "checkout") {
    const element = await this.app.locator(`#${target}`).boundingBox();
    assert.ok(element, "The target is not visible in the actual app.");
    const metrics = await this.app.evaluate("({x:screenX,y:screenY,outerWidth,outerHeight,innerWidth,innerHeight,scale:devicePixelRatio})") as { x: number; y: number; outerWidth: number; outerHeight: number; innerWidth: number; innerHeight: number; scale: number };
    assert.equal(metrics.scale, 1, "Unexpected native desktop device scale.");
    const border = (metrics.outerWidth - metrics.innerWidth) / 2;
    const x = metrics.x + border + element.x + element.width / 2;
    const y = metrics.y + metrics.outerHeight - metrics.innerHeight - border + element.y + element.height / 2;
    const canvas = await this.viewer.locator("canvas").boundingBox();
    assert.ok(canvas && x >= 0 && x < 1600 && y >= 0 && y < 1000, "Native element is outside the desktop.");
    return { x: canvas.x + x * canvas.width / 1600, y: canvas.y + y * canvas.height / 1000 };
  }

  async action(action: WebAction): Promise<void> {
    if (action.kind === "reload") {
      await this.viewer.keyboard.press("Control+r"); await pause(1100);
      assert.equal(await this.app.locator("#request-id").inputValue(), "purchase-001", "Anchor reload did not reach the native app.");
      assert.equal(await this.app.locator("#quantity").inputValue(), "1");
      return;
    }
    const point = await this.coordinates(action.target);
    if (action.kind === "fill") {
      await this.viewer.mouse.click(point.x, point.y);
      await this.viewer.keyboard.press("Control+a");
      await this.viewer.keyboard.press("Backspace");
      await this.viewer.keyboard.type(action.value, { delay: 18 });
      for (let attempt = 0; attempt < 15 && await this.app.locator(`#${action.target}`).inputValue() !== action.value; attempt++) await pause(150);
      assert.equal(await this.app.locator(`#${action.target}`).inputValue(), action.value, "Anchor input did not reach the native browser.");
    } else if (action.kind === "double-click") {
      await this.viewer.mouse.dblclick(point.x, point.y, { delay: 65 });
    } else {
      await this.viewer.mouse.click(point.x, point.y);
    }
    await pause(450);
  }

  async trial(candidate: DaytonaSoftwareAdapter, attack: WebAttack, contract: CheckoutContract, directory: string,
    consume: (actions: number, requests: number) => void, signal?: AbortSignal): Promise<BrowserTrial> {
    await candidate.reset();
    await this.pointAt(candidate);
    const batches: RequestBatch[] = [];
    let eventCount = 0;
    const browserResponses: Promise<ObservedRequest>[] = [];
    const listener = (response: Response) => {
      if (response.url() === "http://127.0.0.1:8080/api/checkout" && response.request().method() === "POST") {
        browserResponses.push(response.json().then(body => ({ input: response.request().postDataJSON() as CheckoutInput,
          response: { status: response.status(), body, sourceHash: response.headers()["x-candidate-sha256"] ?? "" } })));
      }
    };
    this.app.on("response", listener);
    try { for (const action of attack.actions) {
      signal?.throwIfAborted();
      const clicks = action.kind === "double-click" ? 2 : action.kind === "click" ? 1 : 0;
      consume(1, clicks);
      let expected: CheckoutInput | undefined;
      if (clicks) {
        const requestId = await this.app.locator("#request-id").inputValue();
        const quantity = Number(await this.app.locator("#quantity").inputValue());
        expected = { requestId, quantity: Number.isFinite(quantity) ? quantity : null };
      }
      await this.action(action);
      if (clicks) {
        const deadline = Date.now() + 20000;
        while (browserResponses.length < eventCount + clicks && Date.now() < deadline) await pause(250);
        assert.equal(browserResponses.length, eventCount + clicks, "Native Anchor action did not produce the expected actual HTTP responses.");
        const observed = await Promise.all(browserResponses.slice(eventCount));
        assert.ok(observed.every(event => JSON.stringify(event.input) === JSON.stringify(expected)), "The actual browser request differed from the action's input.");
        const events = (await candidate.events()).slice(eventCount);
        assert.deepEqual(events.map(event => JSON.stringify(event)).sort(), observed.map(event => JSON.stringify(event)).sort(), "Browser observations differ from the fixed server's actual request log.");
        batches.push({ requests: observed }); eventCount += clicks;
      }
    } } finally { this.app.off("response", listener); }
    await pause(1100);
    const ledger = await candidate.observe();
    const check = verifyCheckout({ id: `browser-${attack.id}`, contract, sourceHash: candidate.candidate.sourceHash, runtimeHash: candidate.runtimeHash, batches, ledger });
    const screenshotPath = join(directory, `${candidate.candidate.id}-${attack.id}-${Date.now()}.png`);
    const shot = await this.lab.computer.sandbox.computerUse.screenshot.takeFullScreen(true);
    await writeFile(screenshotPath, Buffer.from(shot.screenshot!, "base64"));
    return { attack, batches, ledger, check, screenshotPath };
  }

  async close(directory: string): Promise<void> {
    await this.native.close().catch(() => {});
    await this.anchor.close().catch(() => {});
    await endAnchorSession(this.session.id);
    await writeFile(join(directory, "anchor-session-ended.json"), JSON.stringify({ sessionId: this.session.id, endedAt: Date.now() }), { mode: 0o600 });
  }
}
