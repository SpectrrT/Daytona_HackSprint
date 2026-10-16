// Playwright driver for an Anchor Browser session.
//
// This one file runs in two places:
//  - the CompanyOS server imports it to drive browsers for Claude-loop employees;
//  - CompanyOS uploads it into an OpenClaw employee's Daytona sandbox, where it is
//    the `browser` command (see USAGE below).
//
// It must stay plain JavaScript with `playwright-core` as its only dependency,
// because the sandbox copy runs without a build step.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

const MAX_TEXT = 6000;
const MAX_ELEMENTS = 120;

/**
 * @typedef {{ action: "goto", url: string }
 *   | { action: "read" }
 *   | { action: "click", id: number }
 *   | { action: "type", id: number, text: string, submit?: boolean }
 *   | { action: "press", key: string }
 *   | { action: "scroll", direction?: "up" | "down" }
 *   | { action: "back" }
 *   | { action: "screenshot" }} BrowserAction
 */

/** @typedef {{ url: string, title: string, text: string, elements: string[] }} PageView */

/** @typedef {{ view: PageView, image?: Buffer }} ActionResult */

/**
 * The page the agent is working in: the newest tab of the session's first context.
 * @param {import("playwright-core").Browser} browser
 * @returns {Promise<import("playwright-core").Page>}
 */
export async function activePage(browser) {
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const pages = context.pages();
  return pages[pages.length - 1] ?? (await context.newPage());
}

/** @param {import("playwright-core").Page} page */
async function settle(page) {
  await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(700);
}

/** @param {string} url */
function normalizeUrl(url) {
  return /^[a-z]+:\/\//i.test(url) ? url : `https://${url}`;
}

/**
 * Numbers every visible interactive element (data-cos-id) and returns the page text.
 * @param {import("playwright-core").Page} page
 * @returns {Promise<PageView>}
 */
export async function readPage(page) {
  const view = await page.evaluate(
    ({ maxText, maxElements }) => {
      document.querySelectorAll("[data-cos-id]").forEach((el) => el.removeAttribute("data-cos-id"));
      const selector = [
        "a[href]",
        "button",
        "input:not([type=hidden])",
        "textarea",
        "select",
        "summary",
        "[role=button]",
        "[role=link]",
        "[role=tab]",
        "[role=menuitem]",
        "[role=checkbox]",
        "[role=option]",
        "[contenteditable=''], [contenteditable=true]",
      ].join(", ");
      /** @type {string[]} */
      const elements = [];
      let n = 0;
      for (const node of document.querySelectorAll(selector)) {
        if (n >= maxElements) break;
        const el = /** @type {HTMLElement} */ (node);
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        if (rect.width < 2 || rect.height < 2 || style.visibility === "hidden" || style.display === "none") continue;
        n += 1;
        el.setAttribute("data-cos-id", String(n));
        const tag = el.tagName.toLowerCase();
        const input = /** @type {HTMLInputElement} */ (el);
        const label = (
          el.getAttribute("aria-label") ||
          el.innerText ||
          (tag === "input" || tag === "textarea" ? input.value : "") ||
          el.getAttribute("placeholder") ||
          el.getAttribute("title") ||
          el.getAttribute("name") ||
          ""
        )
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 80);
        const kind = tag === "input" ? `input[${input.type || "text"}]` : el.getAttribute("role") || tag;
        const href = tag === "a" ? el.getAttribute("href") : null;
        elements.push(`[${n}] ${kind} "${label}"${href ? ` -> ${href.slice(0, 120)}` : ""}`);
      }
      const raw = (document.body?.innerText ?? "").replace(/\n{3,}/g, "\n\n").trim();
      const text =
        raw.length > maxText
          ? `${raw.slice(0, maxText)}\n…(${raw.length - maxText} more characters below; scroll to see more)`
          : raw;
      return { title: document.title, text, elements };
    },
    { maxText: MAX_TEXT, maxElements: MAX_ELEMENTS },
  );
  return { url: page.url(), ...view };
}

/**
 * @param {import("playwright-core").Page} page
 * @param {number} id
 */
async function locate(page, id) {
  const locator = page.locator(`[data-cos-id="${Number(id)}"]`).first();
  if ((await locator.count()) === 0) {
    throw new Error(`There is no element [${id}] on the page now. Read the page again to get fresh numbers.`);
  }
  return locator;
}

/**
 * Performs one browser action and returns what the page looks like afterwards.
 * @param {import("playwright-core").Page} page
 * @param {BrowserAction} action
 * @returns {Promise<ActionResult>}
 */
export async function runAction(page, action) {
  switch (action.action) {
    case "goto":
      await page.goto(normalizeUrl(action.url), { waitUntil: "domcontentloaded", timeout: 45000 });
      break;
    case "read":
      break;
    case "click":
      await (await locate(page, action.id)).click({ timeout: 10000 });
      break;
    case "type": {
      const field = await locate(page, action.id);
      await field.fill(action.text, { timeout: 10000 });
      if (action.submit) await field.press("Enter");
      break;
    }
    case "press":
      await page.keyboard.press(action.key);
      break;
    case "scroll":
      await page.mouse.wheel(0, action.direction === "up" ? -800 : 800);
      break;
    case "back":
      await page.goBack({ timeout: 15000 }).catch(() => null);
      break;
    case "screenshot": {
      await settle(page);
      const image = await page.screenshot({ type: "jpeg", quality: 60 });
      return { view: await readPage(page), image };
    }
    default:
      throw new Error(`Unknown browser action: ${JSON.stringify(action)}`);
  }
  await settle(page);
  return { view: await readPage(page) };
}

/**
 * Renders a page view as text for an agent.
 * @param {PageView} view
 */
export function formatView(view) {
  return [
    `URL: ${view.url}`,
    `Title: ${view.title}`,
    "",
    "--- Page text ---",
    view.text || "(no visible text)",
    "",
    "--- Interactive elements (use the number to click or type) ---",
    view.elements.length ? view.elements.join("\n") : "(none found)",
  ].join("\n");
}

/**
 * Runs Anchor's own AI browser agent on an existing session and waits for its answer.
 * @param {{ apiUrl: string, apiKey: string, sessionId: string, prompt: string, url?: string, timeoutMs?: number }} opts
 * @returns {Promise<string>}
 */
export async function anchorTask({ apiUrl, apiKey, sessionId, prompt, url, timeoutMs = 10 * 60 * 1000 }) {
  const headers = { "anchor-api-key": apiKey, "content-type": "application/json" };
  const start = await fetch(`${apiUrl}/v1/tools/perform-web-task?sessionId=${encodeURIComponent(sessionId)}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ prompt, ...(url ? { url } : {}), async: true }),
  });
  const started = await start.json().catch(() => ({}));
  if (!start.ok) throw new Error(`Anchor task failed to start (${start.status}): ${JSON.stringify(started).slice(0, 300)}`);
  const first = started.data ?? started;
  if (first.result !== undefined && first.status !== "running") return stringify(first.result);
  const workflowId = first.workflow_id ?? first.workflowId;
  if (!workflowId) return stringify(first);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    const res = await fetch(`${apiUrl}/v1/tools/perform-web-task/${encodeURIComponent(workflowId)}/status`, { headers });
    const body = await res.json().catch(() => ({}));
    const status = body.data ?? body;
    if (status.status === "COMPLETED") return stringify(status.result);
    if (status.status === "FAILED") throw new Error(`Anchor task failed: ${stringify(status.error ?? status)}`);
  }
  throw new Error(`Anchor task did not finish within ${Math.round(timeoutMs / 60000)} minutes.`);
}

/** @param {unknown} value */
function stringify(value) {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

// ---------------------------------------------------------------------------
// CLI: the `browser` command inside an employee sandbox.
// CompanyOS writes ~/.companyos/browser.json ({ sessionId, connectUrl, apiUrl })
// and mounts ANCHOR_API_KEY (a Daytona secret placeholder, or the key itself).
// ---------------------------------------------------------------------------

const USAGE = `browser - your web browser (an Anchor cloud browser your manager can watch live)

  browser goto <url>             open a page; prints its text and numbered elements
  browser read                   print the current page again
  browser click <n>              click element [n]
  browser type <n> <text>        type into field [n]; add --submit to press Enter
  browser press <key>            press a key, e.g. Enter, Escape, PageDown
  browser scroll [up|down]       scroll the page
  browser back                   go back
  browser screenshot             save a screenshot; prints the file path
  browser task <instructions>    let Anchor's browser agent do a multi-step web task and report back

Element numbers change after every page change: read again before you click.`;

async function loadSandboxConfig() {
  const file = join(homedir(), ".companyos", "browser.json");
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    throw new Error("No browser is assigned to you (missing ~/.companyos/browser.json).");
  }
}

/** @param {{ sessionId: string, connectUrl?: string }} cfg */
async function connectFromSandbox(cfg) {
  const key = process.env.ANCHOR_API_KEY ?? "";
  if (!key) throw new Error("ANCHOR_API_KEY is not set in this sandbox.");
  const url = new URL(cfg.connectUrl ?? "wss://connect.anchorbrowser.io");
  url.searchParams.set("sessionId", cfg.sessionId);
  if (key.startsWith("dtn_secret_")) {
    // A Daytona secret placeholder: send it as a header so Daytona's egress proxy
    // swaps in the real key. The plaintext key never exists in this sandbox.
    return chromium.connectOverCDP(url.toString(), { headers: { "anchor-api-key": key }, timeout: 30000 });
  }
  url.searchParams.set("apiKey", key);
  return chromium.connectOverCDP(url.toString(), { timeout: 30000 });
}

/** @param {string[]} argv @returns {BrowserAction | { action: "task", prompt: string } | null} */
function parseArgs(argv) {
  const [command, ...rest] = argv;
  const submit = rest.includes("--submit");
  const args = rest.filter((a) => a !== "--submit");
  switch (command) {
    case "goto":
      if (!args[0]) throw new Error("Usage: browser goto <url>");
      return { action: "goto", url: args[0] };
    case "read":
      return { action: "read" };
    case "click":
      if (!args[0]) throw new Error("Usage: browser click <n>");
      return { action: "click", id: Number(args[0]) };
    case "type":
      if (!args[0] || args.length < 2) throw new Error("Usage: browser type <n> <text> [--submit]");
      return { action: "type", id: Number(args[0]), text: args.slice(1).join(" "), submit };
    case "press":
      if (!args[0]) throw new Error("Usage: browser press <key>");
      return { action: "press", key: args[0] };
    case "scroll":
      return { action: "scroll", direction: args[0] === "up" ? "up" : "down" };
    case "back":
      return { action: "back" };
    case "screenshot":
      return { action: "screenshot" };
    case "task":
      if (!args.length) throw new Error("Usage: browser task <instructions>");
      return { action: "task", prompt: args.join(" ") };
    default:
      return null;
  }
}

/** @param {string} text @param {number} code */
function finish(text, code) {
  const out = code === 0 ? process.stdout : process.stderr;
  out.write(`${text}\n`, () => process.exit(code));
}

async function cli() {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed) return finish(USAGE, process.argv[2] && !["help", "--help", "-h"].includes(process.argv[2]) ? 2 : 0);
  const cfg = await loadSandboxConfig();

  if (parsed.action === "task") {
    const result = await anchorTask({
      apiUrl: cfg.apiUrl ?? "https://api.anchorbrowser.io",
      apiKey: process.env.ANCHOR_API_KEY ?? "",
      sessionId: cfg.sessionId,
      prompt: parsed.prompt,
    });
    return finish(`Anchor browser agent result:\n${result}`, 0);
  }

  // Exiting without browser.close() only drops the CDP connection; the session,
  // its tabs and cookies stay alive for the next command.
  const browser = await connectFromSandbox(cfg);
  const page = await activePage(browser);
  const { view, image } = await runAction(page, parsed);
  if (image) {
    const dir = join(homedir(), ".companyos", "screenshots");
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${Date.now()}.jpg`);
    await writeFile(file, image);
    return finish(`Saved screenshot to ${file}\n\n${formatView(view)}`, 0);
  }
  return finish(formatView(view), 0);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  cli().catch((err) => finish(`browser: ${err instanceof Error ? err.message : String(err)}`, 1));
}
