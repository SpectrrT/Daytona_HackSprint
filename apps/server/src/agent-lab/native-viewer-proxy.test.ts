import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage, ServerResponse } from "node:http";
import type { RequestOptions } from "node:https";
import { Duplex, PassThrough } from "node:stream";
import test from "node:test";
import type { LabPreview, LabRun } from "@antibody/shared/agent-lab";
import { labContract } from "./contract.js";
import { NativeViewerProxy, nativeViewerAsset, nativeViewerOrigin } from "./native-viewer-proxy.js";

const ORIGIN = "http://127.0.0.1:5173";
const run: LabRun = { id: "our-run", status: "running", createdAt: 1, contract: labContract(), desktopSandboxId: "our-desktop-vm", candidates: [], failures: [], lessons: [], events: [], budget: { maxCandidates: 3, maxModelCalls: 36, usedModelCalls: 0, usedBrowserActions: 0 } };
const preview: LabPreview = { url: "https://6080-private-signed-token.daytonaproxy01.net/vnc.html?autoconnect=true", sandboxId: run.desktopSandboxId!, kind: "desktop", expiresAt: 3600000 };
const request = (url: string, method = "GET", headers: IncomingMessage["headers"] = {}) => Object.assign(new EventEmitter(), { url, method, headers }) as IncomingMessage;
const response = () => {
  let done!: () => void;
  const finished = new Promise<void>(resolve => { done = resolve; });
  const state = { status: 0, headers: {} as Record<string, string>, body: "" };
  const res = Object.assign(new EventEmitter(), { writableEnded: false,
    writeHead(status: number, headers: Record<string, string>) { state.status = status; state.headers = headers; return this; },
    end(body?: Buffer | string) { state.body = body?.toString() ?? ""; this.writableEnded = true; done(); return this; },
  }) as unknown as ServerResponse;
  return { res, state, finished };
};
class MemorySocket extends Duplex {
  writes: Buffer[] = [];
  _read() {}
  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) { this.writes.push(Buffer.from(chunk)); callback(); }
}

test("native viewer accepts only hosted HTTPS port 6080 and known noVNC assets", () => {
  assert.equal(nativeViewerOrigin(preview.url).origin, "https://6080-private-signed-token.daytonaproxy01.net");
  for (const invalid of ["http://6080-token.daytonaproxy01.net", "https://8000-token.daytonaproxy01.net", "https://6080-token.daytonaproxy01.net.attacker.example", "https://6080-token.daytonaproxy01.net:4443", "https://secret@6080-token.daytonaproxy01.net"]) assert.throws(() => nativeViewerOrigin(invalid));
  assert.equal(nativeViewerAsset("core/decoders/rre.js"), "/core/decoders/rre.js");
  assert.equal(nativeViewerAsset("app/locale/pt_BR.json"), "/app/locale/pt_BR.json");
  for (const invalid of ["../server.py", "app/../../api/key.js", "%2e%2e/key.js", "app//ui.js", "app\\ui.js", "api/health", "websockify"]) assert.equal(nativeViewerAsset(invalid), undefined);
});

test("expiring capabilities bind exact retained run/resource and never reveal upstream signed URL", async () => {
  let now = 1000;
  const proxy = new NativeViewerProxy({ allowedOrigins: [ORIGIN], now: () => now, request: () => { throw new Error("No upstream should be called."); } });
  const issued = proxy.issue(run, "desktop", preview);
  assert.ok(issued.url.startsWith("/api/agent-lab/runs/our-run/sandboxes/desktop/viewer/"));
  assert.ok(!issued.url.includes("private-signed-token"));
  assert.throws(() => proxy.issue(run, "desktop", { ...preview, sandboxId: "someone-elses-vm" }));
  assert.throws(() => proxy.issue(run, "arbitrary-key", preview));
  const forged = response(); proxy.handleHttp(request(issued.url.replace("our-run", "other-run")), forged.res); await forged.finished;
  assert.equal(forged.state.status, 404);
  now = issued.expiresAt + 1;
  const expired = response(); proxy.handleHttp(request(issued.url), expired.res); await expired.finished;
  assert.equal(expired.state.status, 404);
  proxy.close();
});

test("HTTP proxy adds official bypass header, ignores client credentials/queries, and isolates sandbox scripts", async () => {
  let sent: { url: URL; options: RequestOptions } | undefined;
  const proxy = new NativeViewerProxy({ allowedOrigins: [ORIGIN], now: () => 1000, request: (url, options, listener) => {
    sent = { url, options };
    return Object.assign(new EventEmitter(), { destroy() {}, end() { queueMicrotask(() => { const remote = Object.assign(new PassThrough(), { statusCode: 200, headers: { "content-type": "text/html", "set-cookie": ["private-provider-cookie"], location: "https://do-not-forward.example" } }); listener?.(remote as unknown as IncomingMessage); remote.end("<html>Actual noVNC</html>"); }); } }) as unknown as ClientRequest;
  } });
  const issued = proxy.issue(run, "desktop", preview), captured = response();
  proxy.handleHttp(request(`${issued.url}&upstream=https://arbitrary.example`, "GET", { authorization: "Bearer private-user-key", cookie: "private-controller-cookie", "x-daytona-preview-token": "private-other-key" }), captured.res); await captured.finished;
  assert.equal(sent?.url.toString(), "https://6080-private-signed-token.daytonaproxy01.net/vnc.html");
  assert.deepEqual(sent?.options.headers, { "X-Daytona-Skip-Preview-Warning": "true", "Accept-Encoding": "identity" });
  assert.equal(captured.state.status, 200); assert.match(captured.state.body, /Actual noVNC/);
  assert.match(captured.state.headers["Content-Security-Policy"]!, /sandbox allow-scripts;/);
  assert.ok(!captured.state.headers["Content-Security-Policy"]!.includes("allow-same-origin"));
  assert.match(captured.state.headers["Content-Security-Policy"]!, /connect-src http:\/\/127\.0\.0\.1:5173\/api\/agent-lab\/runs\/our-run\/sandboxes\/desktop\/viewer\//);
  assert.equal(captured.state.headers["Referrer-Policy"], "no-referrer");
  assert.ok(!JSON.stringify(captured.state.headers).includes("private-provider-cookie"));
  const refused = response(); proxy.handleHttp(request(issued.url, "POST"), refused.res); await refused.finished; assert.equal(refused.state.status, 405);
  proxy.close();
});

test("upstream redirects are not followed or exposed", async () => {
  const proxy = new NativeViewerProxy({ allowedOrigins: [ORIGIN], now: () => 1000, request: (_url, _options, listener) => Object.assign(new EventEmitter(), { destroy() {}, end() { queueMicrotask(() => { const remote = Object.assign(new PassThrough(), { statusCode: 302, headers: { location: "https://private-provider-location.example" } }); listener?.(remote as unknown as IncomingMessage); remote.end(); }); } }) as unknown as ClientRequest });
  const captured = response(); proxy.handleHttp(request(proxy.issue(run, "desktop", preview).url), captured.res); await captured.finished;
  assert.equal(captured.state.status, 502); assert.ok(!JSON.stringify(captured.state).includes("private-provider-location")); proxy.close();
});

test("WebSocket tunnel preserves native bytes only for the scoped websockify path with official header", async () => {
  const native = new MemorySocket(), browser = new MemorySocket(); let sent: RequestOptions | undefined;
  const websocketKey = "dGhlIHNhbXBsZSBub25jZQ==";
  const proxy = new NativeViewerProxy({ allowedOrigins: [ORIGIN], now: () => 1000, request: (_url, options) => {
    sent = options;
    const emitter = Object.assign(new EventEmitter(), { destroy() {}, setTimeout() {}, end() { queueMicrotask(() => emitter.emit("upgrade", { statusCode: 101, headers: { "sec-websocket-accept": createHash("sha1").update(websocketKey + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64"), "sec-websocket-protocol": "binary", "set-cookie": "private" } }, native, Buffer.from("initial-screen-bytes"))); } });
    return emitter as unknown as ClientRequest;
  } });
  const issued = proxy.issue(run, "desktop", preview), url = issued.url.split("/vnc.html")[0] + "/websockify";
  assert.equal(proxy.handleUpgrade(request(url, "GET", { upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": websocketKey, "sec-websocket-protocol": "binary", origin: "null", cookie: "private-controller-cookie" }), browser, Buffer.from("initial-client-bytes")), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((sent?.headers as Record<string, string>)["X-Daytona-Skip-Preview-Warning"], "true");
  assert.ok(!JSON.stringify(sent?.headers).includes("private-controller-cookie"));
  assert.match(Buffer.concat(browser.writes).toString(), /101 Switching Protocols/);
  assert.match(Buffer.concat(browser.writes).toString(), /initial-screen-bytes/);
  assert.equal(Buffer.concat(native.writes).toString(), "initial-client-bytes");
  assert.ok(!Buffer.concat(browser.writes).toString().includes("set-cookie"));
  const denied = new MemorySocket();
  proxy.handleUpgrade(request(url, "GET", { upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": websocketKey, origin: "https://attacker.example" }), denied, Buffer.alloc(0));
  assert.match(Buffer.concat(denied.writes).toString(), /403 Forbidden/);
  denied.destroy(); proxy.close();
});
