import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Sandbox } from "@daytona/sdk";
import { chromium, type Browser } from "playwright-core";
import { createAnchorSession, endAnchorSession } from "./anchor.js";

/** Verify the actual noVNC desktop, using a scoped URL obtained directly from Daytona. */
export async function auditDaytonaDesktop(sandbox: Sandbox, directory: string) {
  const preview = await sandbox.getSignedPreviewUrl(6080, 3600);
  const url = new URL("/vnc.html", preview.url);
  url.searchParams.set("autoconnect", "true"); url.searchParams.set("resize", "scale");
  const session = await createAnchorSession(["antibody", "native-desktop-audit"]);
  let browser: Browser | undefined;
  try {
    try { browser = await chromium.connectOverCDP(session.cdpUrl, { timeout: 30_000 }); }
    catch { throw new Error("Anchor could not connect for the native desktop audit."); }
    const context = browser.contexts()[0] ?? await browser.newContext();
    const page = context.pages()[0] ?? await context.newPage();
    await page.setViewportSize({ width: 1640, height: 1060 });
    await page.setExtraHTTPHeaders({ "X-Daytona-Skip-Preview-Warning": "true" });
    let response;
    try { response = await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: 30_000 }); }
    catch { throw new Error("Anchor could not load the native Daytona desktop."); }
    // noVNC creates an unlabelled canvas after the VNC connection succeeds.
    await page.locator("canvas").waitFor({ state: "visible", timeout: 30_000 });
    await page.waitForFunction("document.querySelector('canvas')?.width === 1600 && document.querySelector('canvas')?.height === 1000", undefined, { timeout: 30_000 });
    const title = await page.title();
    const body = await page.locator("body").innerText();
    const canvas = await page.locator("canvas").evaluate(element => ({ width: element.width, height: element.height }));
    const checks = [
      { name: "Daytona noVNC responds successfully", passed: !!response?.ok() },
      { name: "Connected desktop identifies the requested sandbox", passed: title.includes(sandbox.id) },
      { name: "VNC connection is encrypted and active", passed: body.includes(`Connected (encrypted) to ${sandbox.id}`) },
      { name: "Native desktop canvas is 1600 by 1000", passed: canvas.width === 1600 && canvas.height === 1000 },
    ];
    const screenshotPath = join(directory, "anchor-actual-desktop.png");
    await page.screenshot({ path: screenshotPath });
    const audit = { passed: checks.every(check => check.passed), checks, sandboxId: sandbox.id, sessionId: session.id,
      screenshotPath, verifiedAt: new Date().toISOString(), target: "Actual Daytona XFCE desktop" };
    await writeFile(join(directory, "anchor-desktop-audit.json"), JSON.stringify(audit, null, 2), { mode: 0o600 });
    assert.ok(audit.passed, "The actual Daytona desktop did not pass all Anchor checks.");
    return audit;
  } finally {
    await browser?.close().catch(() => {});
    await endAnchorSession(session.id);
    await writeFile(join(directory, "anchor-session-ended.json"), JSON.stringify({ sessionId: session.id, endedAt: new Date().toISOString() }), { mode: 0o600 });
  }
}
