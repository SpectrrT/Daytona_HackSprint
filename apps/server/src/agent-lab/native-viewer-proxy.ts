import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import type { ClientRequest, IncomingMessage, RequestListener, Server, ServerResponse } from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import type { Duplex } from "node:stream";
import type { LabPreview, LabRun } from "@antibody/shared/agent-lab";

type Transport = (url: URL, options: RequestOptions, listener?: (response: IncomingMessage) => void) => ClientRequest;
interface ViewerSession { runId: string; key: string; sandboxId: string; prefix: string; token: string; upstream: URL; origin: URL; expiresAt: number }
interface ViewerProxyOptions { allowedOrigins: string[]; now?: () => number; request?: Transport }
type NativeViewerRun = Pick<LabRun, "id" | "desktopSandboxId" | "roleWorkspaces">;
const PREFIX = "/api/agent-lab/runs/";
const ROUTE = /^\/api\/agent-lab\/runs\/([a-zA-Z0-9_-]{1,100})\/sandboxes\/([a-zA-Z0-9_-]{1,100})\/viewer\/([a-zA-Z0-9_-]{43})\/(.*)$/;
const MAX_ASSET_BYTES = 8 * 1024 * 1024;
const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** No arbitrary upstreams: only SDK-issued, hosted Daytona native desktop port 6080. */
export function nativeViewerOrigin(value: string): URL {
  const url = new URL(value);
  assert.ok(url.protocol === "https:" && !url.username && !url.password && (!url.port || url.port === "443"), "Native viewer requires a private Daytona HTTPS preview.");
  assert.match(url.hostname, /^6080-[a-zA-Z0-9-]+\.(?:daytonaproxy[0-9]+\.net|proxy\.daytona\.work)$/);
  return new URL(url.origin);
}

/** Static noVNC files only. Directory traversal, encoded paths and arbitrary port services are rejected. */
export function nativeViewerAsset(path: string): string | undefined {
  if (!path || path.includes("%") || path.includes("\\") || path.includes("//") || path.split("/").some(part => part === "." || part === "..")) return undefined;
  if (["vnc.html", "package.json", "defaults.json", "mandatory.json", "favicon.ico"].includes(path)) return `/${path}`;
  if (/^(?:app|core|vendor)\/[a-zA-Z0-9_./-]+\.(?:js|mjs|json|css|svg|png|gif|jpe?g|ico|woff2?|ttf|wasm|map)$/.test(path)) return `/${path}`;
  return undefined;
}

/**
 * Narrow native noVNC proxy. LabSandboxAccess must have verified the run-owned resource first.
 * The browser receives an expiring local capability, never the upstream signed link or API key.
 * Official bypass: https://www.daytona.io/docs/en/preview/#warning-page
 */
export class NativeViewerProxy {
  private readonly sessions = new Map<string, ViewerSession>();
  private readonly sockets = new Set<Duplex>();
  private readonly now: () => number;
  private readonly request: Transport;
  private readonly origins: string[];

  constructor(options: ViewerProxyOptions) {
    assert.ok(options.allowedOrigins.length > 0 && options.allowedOrigins.length <= 16);
    this.origins = options.allowedOrigins.map(value => {
      const url = new URL(value);
      assert.ok(["http:", "https:"].includes(url.protocol) && !url.username && !url.password && url.origin === value, "Use exact viewer origins.");
      return url.origin;
    });
    this.now = options.now ?? Date.now;
    this.request = options.request ?? httpsRequest;
  }

  /** Call only after sandboxAccess.preview(run,key,resume); this never provisions or resumes resources. */
  issue(run: NativeViewerRun, key: string, preview: LabPreview, viewerOrigin = this.origins[0]!): LabPreview {
    assert.match(run.id, /^[a-zA-Z0-9_-]{1,100}$/); assert.match(key, /^[a-zA-Z0-9_-]{1,100}$/);
    const ownedId = key === "desktop" ? run.desktopSandboxId : ["blue", "red"].includes(key) ? run.roleWorkspaces?.find(row => row.role === key)?.sandboxId : undefined;
    assert.ok(ownedId && preview.kind === "desktop" && ownedId === preview.sandboxId, "Native viewer must match a retained run-owned desktop.");
    assert.ok(this.origins.includes(viewerOrigin), "Unrecognized viewer origin.");
    const upstream = nativeViewerOrigin(preview.url), now = this.now();
    assert.ok(preview.expiresAt > now + 5000, "Native preview has expired.");
    for (const [token, entry] of this.sessions) if (entry.expiresAt <= now) this.sessions.delete(token);
    let session = [...this.sessions.values()].find(row => row.runId === run.id && row.key === key && row.upstream.origin === upstream.origin && row.origin.origin === viewerOrigin && row.expiresAt > now + 60000);
    if (!session) {
      assert.ok(this.sessions.size < 128, "Too many native viewers are open.");
      const token = randomBytes(32).toString("base64url"), prefix = `${PREFIX}${run.id}/sandboxes/${key}/viewer/${token}`;
      session = { token, prefix, runId: run.id, key, sandboxId: preview.sandboxId, upstream, origin: new URL(viewerOrigin), expiresAt: Math.min(preview.expiresAt - 2000, now + 30 * 60 * 1000) };
      this.sessions.set(token, session);
    }
    // Explicit host/port also supports older packaged noVNC versions that prepend '/' to path.
    const query = new URLSearchParams({ autoconnect: "true", resize: "scale", view_only: "true", host: session.origin.hostname, port: session.origin.port || (session.origin.protocol === "https:" ? "443" : "80"), encrypt: String(session.origin.protocol === "https:"), path: `${session.prefix.slice(1)}/websockify` });
    return { ...preview, url: `${session.prefix}/vnc.html?${query}`, expiresAt: session.expiresAt };
  }

  private lookup(rawUrl: string | undefined): { session: ViewerSession; path: string } | undefined {
    const path = rawUrl?.split("?", 1)[0] ?? "", match = ROUTE.exec(path);
    if (!match) return undefined;
    const session = this.sessions.get(match[3]!);
    if (!session || session.expiresAt <= this.now() || session.runId !== match[1] || session.key !== match[2]) return undefined;
    return { session, path: match[4]! };
  }

  private headers(session?: ViewerSession): Record<string, string> {
    const ancestors = this.origins.join(" ");
    const source = session ? this.origins.map(value => `${value}${session.prefix}/`).join(" ") : "'none'";
    const sockets = session ? this.origins.map(value => `${value.replace(/^http/, "ws")}${session.prefix}/`).join(" ") : "";
    return {
      "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "Access-Control-Allow-Origin": "*",
      // Opaque origin prevents sandbox HTML/scripts from obtaining controller cookies or calling its APIs.
      "Content-Security-Policy": `sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' ${source}; style-src 'unsafe-inline' ${source}; img-src data: blob: ${source}; font-src ${source}; connect-src ${source} ${sockets}; worker-src blob: ${source}; frame-ancestors ${ancestors}; form-action 'none'; base-uri 'none'`,
      "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    };
  }

  /** True means this request belongs to the viewer namespace and was handled, including denial. */
  handleHttp(req: IncomingMessage, res: ServerResponse): boolean {
    if (!req.url?.startsWith(PREFIX) || !req.url.includes("/viewer/")) return false;
    const match = this.lookup(req.url);
    const reject = (status: number, message: string) => { res.writeHead(status, { ...this.headers(match?.session), "Content-Type": "text/plain; charset=utf-8" }); res.end(message); };
    if (!match) { reject(404, "Native viewer expired or unavailable. Reopen this sandbox."); return true; }
    if (!["GET", "HEAD"].includes(req.method ?? "")) { reject(405, "Native viewer accepts read requests only."); return true; }
    const asset = nativeViewerAsset(match.path);
    if (!asset) { reject(404, "Native viewer asset not found."); return true; }
    const { session } = match;
    if (asset === "/mandatory.json") {
      res.writeHead(200, { ...this.headers(session), "Content-Type": "application/json" });
      res.end(req.method === "HEAD" ? undefined : JSON.stringify({ view_only: true, autoconnect: true, resize: "scale", host: session.origin.hostname, port: session.origin.port || (session.origin.protocol === "https:" ? 443 : 80), encrypt: session.origin.protocol === "https:", path: `${session.prefix.slice(1)}/websockify` }));
      return true;
    }
    let completed = false;
    const fail = () => { if (!completed && !res.writableEnded && !res.destroyed) { completed = true; reject(502, "Daytona native viewer could not load. Reopen this sandbox."); } };
    // Deliberately do not forward browser cookies, Authorization, referrers, custom headers or queries.
    const upstream = this.request(new URL(asset, session.upstream), { method: req.method, headers: { "X-Daytona-Skip-Preview-Warning": "true", "Accept-Encoding": "identity" }, timeout: 15000 }, response => {
      if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) { response.resume(); fail(); return; }
      const chunks: Buffer[] = []; let total = 0;
      response.on("data", (chunk: Buffer) => { total += chunk.length; if (total > MAX_ASSET_BYTES) { response.destroy(); fail(); } else chunks.push(chunk); });
      response.once("error", fail);
      response.once("end", () => {
        if (completed || res.writableEnded) return; completed = true;
        const contentType = response.headers["content-type"] ?? "application/octet-stream";
        res.writeHead(200, { ...this.headers(session), "Content-Type": contentType });
        res.end(req.method === "HEAD" ? undefined : Buffer.concat(chunks));
      });
    });
    upstream.once("timeout", () => { upstream.destroy(); fail(); }); upstream.once("error", fail);
    res.once("close", () => { if (!completed) upstream.destroy(); }); upstream.end();
    return true;
  }

  /** Fixed native /websockify only; raw RFC6455 bytes are tunneled without a new dependency. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    if (!req.url?.startsWith(PREFIX) || !req.url.includes("/viewer/")) return false;
    const match = this.lookup(req.url), key = req.headers["sec-websocket-key"], origin = req.headers.origin;
    const deny = () => { socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); };
    if (!match || match.path !== "websockify" || req.method !== "GET" || req.headers.upgrade?.toLowerCase() !== "websocket" || req.headers["sec-websocket-version"] !== "13" || typeof key !== "string" || !/^[a-zA-Z0-9+/]{22}==$/.test(key) || origin !== "null" && !this.origins.includes(origin ?? "")) { deny(); return true; }
    const offered = String(req.headers["sec-websocket-protocol"] ?? "").split(",").map(value => value.trim()).filter(Boolean);
    if (offered.some(value => !["binary", "base64"].includes(value))) { deny(); return true; }
    const { session } = match;
    const upstream = this.request(new URL("/websockify", session.upstream), { method: "GET", headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": key, "X-Daytona-Skip-Preview-Warning": "true", Origin: session.upstream.origin, ...(offered.length ? { "Sec-WebSocket-Protocol": offered.join(", ") } : {}) }, timeout: 15000 });
    let upgraded = false;
    upstream.once("upgrade", (response: IncomingMessage, native: Duplex, nativeHead: Buffer) => {
      const accept = createHash("sha1").update(key + WEBSOCKET_GUID).digest("base64"), protocol = response.headers["sec-websocket-protocol"];
      if (response.statusCode !== 101 || response.headers["sec-websocket-accept"] !== accept || protocol && (typeof protocol !== "string" || !offered.includes(protocol))) { native.destroy(); deny(); return; }
      upgraded = true; upstream.setTimeout(0);
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n${protocol ? `Sec-WebSocket-Protocol: ${protocol}\r\n` : ""}\r\n`);
      this.sockets.add(socket); this.sockets.add(native);
      const timer = setTimeout(() => { socket.destroy(); native.destroy(); }, Math.max(1, session.expiresAt - this.now())); timer.unref();
      const close = () => { clearTimeout(timer); this.sockets.delete(socket); this.sockets.delete(native); socket.destroy(); native.destroy(); };
      socket.once("close", close); native.once("close", close); socket.once("error", close); native.once("error", close);
      if (head.length) native.write(head); if (nativeHead.length) socket.write(nativeHead);
      socket.pipe(native); native.pipe(socket);
    });
    upstream.once("response", response => { response.resume(); deny(); });
    upstream.once("timeout", () => { upstream.destroy(); if (!upgraded) deny(); });
    upstream.once("error", () => { if (!upgraded) deny(); });
    socket.once("close", () => { if (!upgraded) upstream.destroy(); }); upstream.end();
    return true;
  }

  /** Install immediately after Hono serve(). Existing non-viewer HTTP listeners are preserved. */
  attach(server: Server): () => void {
    const listeners = server.listeners("request") as RequestListener[];
    for (const listener of listeners) server.removeListener("request", listener);
    const request: RequestListener = (req, res) => { if (!this.handleHttp(req, res)) for (const listener of listeners) listener.call(server, req, res); };
    const otherUpgrades = server.listenerCount("upgrade") > 0;
    const upgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      if (!this.handleUpgrade(req, socket, head) && !otherUpgrades) socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    };
    server.on("request", request); server.on("upgrade", upgrade);
    return () => { server.removeListener("request", request); server.removeListener("upgrade", upgrade); for (const listener of listeners) server.on("request", listener); this.close(); };
  }

  close(): void { this.sessions.clear(); for (const socket of this.sockets) socket.destroy(); this.sockets.clear(); }
}
