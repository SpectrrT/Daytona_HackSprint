import { config, requireConfig } from "../config.js";

// Session lifecycle stays in the controller; CDP credentials never reach clients.

export interface AnchorSession {
  id: string;
  /** CDP websocket URL. Contains the API key: never log it or send it to a sandbox. */
  cdpUrl: string;
  liveViewUrl?: string;
}

export class AnchorError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function apiKey(): string {
  return requireConfig("ANCHOR_API_KEY", "Get a key at https://app.anchorbrowser.io and add it to .env.");
}

async function anchorFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${config.ANCHOR_API_URL}${path}`, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(60_000),
    headers: { "anchor-api-key": apiKey(), "content-type": "application/json", ...init.headers },
  });
  const text = await res.text();
  // Provider bodies may contain session credentials. Keep errors safe for events/UI.
  if (!res.ok) throw new AnchorError(res.status, `Anchor ${init.method ?? "GET"} request failed (${res.status}). Check the API key, account limits, and Anchor dashboard.`);
  try { return (text ? JSON.parse(text) : {}) as T; }
  catch { throw new AnchorError(502, "Anchor returned invalid JSON."); }
}

interface CreateSessionResponse {
  data: { id: string; cdp_url: string; live_view_url?: string };
}

/** Starts one headful cloud browser. Not retried: Anchor has no idempotency keys. */
export async function createAnchorSession(tags: string[]): Promise<AnchorSession> {
  const body = {
    session: {
      tags,
      recording: { active: false },
      timeout: {
        max_duration: config.ANCHOR_SESSION_MAX_MINUTES,
        idle_timeout: config.ANCHOR_SESSION_IDLE_MINUTES,
      },
      live_view: { read_only: true },
      ...(config.ANCHOR_PROXY ? { proxy: { active: true, type: "anchor_proxy", country_code: "us" } } : {}),
    },
    browser: {
      headless: { active: false },
      viewport: { width: 1280, height: 800 },
    },
  };
  const { data } = await anchorFetch<CreateSessionResponse>("/v1/sessions", {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!data?.id || !data.cdp_url) throw new AnchorError(502, "Anchor session response was incomplete.");
  return { id: data.id, cdpUrl: data.cdp_url, liveViewUrl: data.live_view_url };
}

export async function endAnchorSession(sessionId: string): Promise<void> {
  try {
    await anchorFetch(`/v1/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
  } catch (err) {
    // Already ended (timeout or manual) is fine.
    if (err instanceof AnchorError && err.status === 404) return;
    throw err;
  }
}

export function anchorConfigured(): boolean {
  return Boolean(config.ANCHOR_API_KEY);
}

/** Lightweight credential check for the doctor and System page. */
export async function checkAnchorKey(): Promise<void> {
  await anchorFetch("/v1/sessions/all/status");
}
