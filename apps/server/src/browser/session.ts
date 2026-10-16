import type { BrowserAudit } from "@hollow-purple/shared/evolution";
import { chromium, type Browser, type Page } from "playwright-core";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.js";
import { createAnchorSession, endAnchorSession } from "./anchor.js";

/** Only the explicitly configured public dashboard may be audited by Anchor. */
export function dashboardUrl(input: string): URL {
  if (!config.PUBLIC_DASHBOARD_URL) throw new Error("Set PUBLIC_DASHBOARD_URL to a publicly reachable HTTPS dashboard before running an Anchor audit.");
  const allowed = new URL(config.PUBLIC_DASHBOARD_URL);
  const url = new URL(input);
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.origin !== allowed.origin || url.username || url.password ||
      host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") ||
      host.startsWith("[") || /^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    throw new Error("Anchor audit URL must use the configured public HTTPS dashboard origin.");
  }
  return url;
}

/** Read-only product audit. Navigation failures cannot expose the secret CDP URL. */
export async function runAnchorAudit(input: string): Promise<BrowserAudit> {
  const url = dashboardUrl(input);
  const session = await createAnchorSession(["hollow-purple", "dashboard-audit"]);
  let browser: Browser | undefined;
  let page: Page | undefined;
  const checks: BrowserAudit["checks"] = [];
  let operationError: unknown;
  try {
    try { browser = await chromium.connectOverCDP(session.cdpUrl, { timeout: 30_000 }); }
    catch { throw new Error("Anchor browser connection failed. Inspect the session in the Anchor dashboard."); }
    const context = browser.contexts()[0] ?? await browser.newContext();
    page = context.pages()[0] ?? await context.newPage();
    // Daytona documents this header for automated preview clients. It carries no credential.
    await page.setExtraHTTPHeaders({ "X-Daytona-Skip-Preview-Warning": "true" });
    const pageErrors: string[] = [];
    page.on("pageerror", () => pageErrors.push("uncaught error"));
    let response;
    try { response = await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: 30_000 }); }
    catch { throw new Error("Anchor could not load the public dashboard. Confirm PUBLIC_DASHBOARD_URL is reachable from the internet."); }
    checks.push({ name: "Dashboard returns successful HTTP response", passed: Boolean(response?.ok()) });
    await page.getByTestId("app-shell").waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
    checks.push({ name: "Application renders", passed: await page.getByTestId("app-shell").isVisible() });
    // The shell renders before the requested run has loaded from the controller.
    await page.getByTestId("lineage-graph").waitFor({ state: "visible", timeout: 30_000 }).catch(() => {});
    const runId = url.searchParams.get("run");
    if (runId) checks.push({ name: "Requested run is loaded", passed: await page.getByTestId("app-shell").getAttribute("data-run-id") === runId });
    checks.push({ name: "Prompt launch control is present", passed: await page.getByTestId("run-button").isVisible() });
    if (await page.getByTestId("readonly-snapshot").isVisible()) {
      checks.push({ name: "Published snapshot cannot launch another experiment", passed: await page.getByTestId("run-button").isDisabled() });
    }
    checks.push({ name: "Lineage graph is inspectable", passed: await page.getByTestId("lineage-graph").isVisible() });
    checks.push({ name: "Reproducible failure evidence is inspectable", passed: await page.getByTestId("evidence-panel").isVisible() });
    await page.getByRole("button", { name: "View source", exact: true }).click();
    const sourceDialog = page.getByRole("dialog");
    await sourceDialog.waitFor({ state: "visible", timeout: 10_000 });
    checks.push({ name: "Candidate RTL source opens", passed: await sourceDialog.isVisible() && /module\s+fifo\s*\(/.test(await sourceDialog.locator("code").last().innerText()) });
    checks.push({ name: "Executed source SHA-256 is displayed", passed: await sourceDialog.getByText(/^[a-f0-9]{64}$/).isVisible() });
    await page.getByRole("button", { name: "Close source", exact: true }).click();
    const navigate = async (name: string) => {
      await page!.locator(".app-examples > summary").click();
      await page!.getByRole("navigation", { name: "Examples", exact: true }).getByRole("button", { name, exact: true }).click();
    };
    await navigate("Requirements");
    await page.getByTestId("contract-panel").waitFor({ state: "visible", timeout: 10_000 });
    checks.push({ name: "Frozen contract view opens", passed: await page.getByTestId("contract-panel").isVisible() });
    checks.push({ name: "Contract SHA-256 is displayed", passed: await page.getByText(/^[a-f0-9]{64}$/).isVisible() });
    await navigate("Design lineage");
    checks.push({ name: "Navigation returns to the lineage", passed: await page.getByTestId("lineage-graph").isVisible() });
    await navigate("Failure evidence");
    checks.push({ name: "Evidence navigation opens the failure inspector", passed: await page.getByTestId("evidence-panel").isVisible() });
    const replay = page.getByRole("button", { name: "Play trace replay", exact: true });
    if (await replay.isVisible()) {
      await replay.click();
      const pause = page.getByRole("button", { name: "Pause replay", exact: true });
      const interactive = await pause.isVisible();
      checks.push({ name: "Failure trace replay responds to browser input", passed: interactive });
      if (interactive) await pause.click();
    }
    await navigate("Hardware buffer");
    checks.push({ name: "No uncaught page errors", passed: pageErrors.length === 0 });
    let screenshotPath: string | undefined;
    if (runId && /^[a-zA-Z0-9_-]{1,100}$/.test(runId)) {
      const directory = join(config.DATA_DIR, "runs", runId);
      await mkdir(directory, { recursive: true });
      screenshotPath = join(directory, "anchor-audit.png");
      await writeFile(screenshotPath, await page.screenshot({ fullPage: true }), { mode: 0o600 });
    }
    const passed = checks.every((check) => check.passed);
    return { sessionId: session.id, passed, checks, screenshotPath, verifiedAt: Date.now(),
      summary: `${checks.filter((check) => check.passed).length}/${checks.length} Anchor dashboard checks passed. Browser session ended after audit.` };
  } catch (error) {
    operationError = error;
    const runId = url.searchParams.get("run");
    if (page && runId && /^[a-zA-Z0-9_-]{1,100}$/.test(runId)) {
      const directory = join(config.DATA_DIR, "runs", runId);
      await mkdir(directory, { recursive: true });
      const screenshot = await page.screenshot({ fullPage: true, timeout: 10_000 }).catch(() => undefined);
      if (screenshot) await writeFile(join(directory, "anchor-audit-failed.png"), screenshot, { mode: 0o600 });
    }
    throw error;
  } finally {
    await browser?.close().catch(() => {});
    try { await endAnchorSession(session.id); }
    catch {
      const message = `Anchor cleanup failed for session ${session.id}. End it in the Anchor dashboard.`;
      if (!operationError) throw new Error(message);
      console.error(message);
    }
  }
}
