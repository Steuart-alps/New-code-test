import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDir = await mkdtemp(path.join(tmpdir(), "contractor-approvals-browser-"));
const helperBundle = path.join(tempDir, "contractor-approval-refresh-state.mjs");
const chromiumPath = process.env.CHROMIUM_PATH ?? "/repl/tools/bin/chromium";

async function waitForPort(server) {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}

async function waitForDevTools(port, timeoutMs = 15000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return await response.json();
    } catch {
      // Chromium is still starting.
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("Chromium remote debugging endpoint did not start");
}

class CdpConnection {
  constructor(url) {
    this.nextId = 0;
    this.pending = new Map();
    this.socket = new WebSocket(url);
    this.opened = new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve);
      this.socket.addEventListener("error", reject);
    });
    this.socket.addEventListener("message", event => {
      const message = JSON.parse(String(event.data));
      if (message.id !== undefined) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
      }
    });
  }

  async send(method, params = {}, sessionId) {
    await this.opened;
    const id = ++this.nextId;
    const message = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify(message));
    });
  }

  close() {
    this.socket.close();
  }
}

async function evaluate(cdp, sessionId, expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  }, sessionId);
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? "Browser evaluation failed");
  }
  return result.result?.value;
}

async function openTab(cdp, url) {
  const { targetId } = await cdp.send("Target.createTarget", { url });
  const { sessionId } = await cdp.send("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  return { targetId, sessionId };
}

let httpServer;
let chromium;
let cdp;
const chromeErrors = [];
const tabs = [];

try {
  await build({
    entryPoints: [path.join(root, "src/lib/contractor-approval-refresh-state.ts")],
    outfile: helperBundle,
    bundle: true,
    format: "esm",
    platform: "browser",
  });
  const helperContents = await readFile(helperBundle, "utf8");
  httpServer = createServer((request, response) => {
    if (request.url?.startsWith("/contractor-approval-refresh-state.mjs")) {
      response.writeHead(200, { "content-type": "text/javascript" });
      response.end(helperContents);
      return;
    }
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<!doctype html><title>approval refresh browser test</title>");
  });
  const httpPort = await waitForPort(httpServer);
  const helperUrl = `http://127.0.0.1:${httpPort}/contractor-approval-refresh-state.mjs`;
  const helperResponse = await fetch(helperUrl);
  assert.equal(helperResponse.status, 200, "the browser fixture server must expose the helper bundle");
  const debugPort = 9200 + Math.floor(Math.random() * 500);
  chromium = spawn(chromiumPath, [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--incognito",
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${path.join(tempDir, "profile")}`,
    "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  chromium.stderr.on("data", chunk => chromeErrors.push(String(chunk)));
  const devTools = await waitForDevTools(debugPort);
  cdp = new CdpConnection(devTools.webSocketDebuggerUrl);
  const testUrl = `http://127.0.0.1:${httpPort}/`;
  const firstTab = await openTab(cdp, testUrl);
  const secondTab = await openTab(cdp, testUrl);
  const otherClientTab = await openTab(cdp, testUrl);
  tabs.push(firstTab, secondTab, otherClientTab);

  const sharedKey = "complytrack:contractor-approvals:7:42";
  const otherClientKey = "complytrack:contractor-approvals:7:43";
  await evaluate(cdp, secondTab.sessionId, `
    (async () => {
      const mod = await import(${JSON.stringify(helperUrl)});
      window.__approvalState = null;
      window.__unsubscribe = mod.subscribeToApprovalRefreshStorage(
        window,
        ${JSON.stringify(sharedKey)},
        state => { window.__approvalState = state; },
      );
    })()
  `);
  await evaluate(cdp, otherClientTab.sessionId, `
    (async () => {
      const mod = await import(${JSON.stringify(helperUrl)});
      window.__otherClientState = null;
      window.__unsubscribe = mod.subscribeToApprovalRefreshStorage(
        window,
        ${JSON.stringify(otherClientKey)},
        state => { window.__otherClientState = state; },
      );
    })()
  `);
  await evaluate(cdp, firstTab.sessionId, `
    (async () => {
      const mod = await import(${JSON.stringify(helperUrl)});
      mod.persistApprovalRefreshState(window, ${JSON.stringify(sharedKey)}, new Set([101, 202]), [202]);
    })()
  `);
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.deepEqual(
    await evaluate(cdp, secondTab.sessionId, "window.__approvalState"),
    { knownQueueIds: [101, 202], newRequestIds: [202] },
    "real Chromium tabs receive the same-user approval update",
  );
  assert.equal(
    await evaluate(cdp, otherClientTab.sessionId, "window.__otherClientState"),
    null,
    "real Chromium tabs do not receive another client's approval update",
  );

  const blockedKey = "complytrack:contractor-approvals:7:44";
  await evaluate(cdp, secondTab.sessionId, `
    (async () => {
      const mod = await import(${JSON.stringify(helperUrl)});
      const blockedWindow = Object.create(window);
      Object.defineProperty(blockedWindow, "localStorage", {
        get() { throw new DOMException("Access denied", "SecurityError"); },
      });
      window.__blockedState = null;
      window.__blockedUnsubscribe = mod.subscribeToApprovalRefreshStorage(
        blockedWindow,
        ${JSON.stringify(blockedKey)},
        state => { window.__blockedState = state; },
      );
    })()
  `);
  await evaluate(cdp, firstTab.sessionId, `
    (async () => {
      const mod = await import(${JSON.stringify(helperUrl)});
      const blockedWindow = Object.create(window);
      Object.defineProperty(blockedWindow, "localStorage", {
        get() { throw new DOMException("Access denied", "SecurityError"); },
      });
      mod.persistApprovalRefreshState(blockedWindow, ${JSON.stringify(blockedKey)}, new Set([303]), [303]);
      window.__blockedBaseline = mod.readPersistedApprovalRefreshState(blockedWindow, ${JSON.stringify(blockedKey)});
    })()
  `);
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.deepEqual(
    await evaluate(cdp, secondTab.sessionId, "window.__blockedState"),
    { knownQueueIds: [303], newRequestIds: [303] },
    "real Chromium BroadcastChannel works when localStorage access is denied",
  );
  assert.deepEqual(
    await evaluate(cdp, firstTab.sessionId, "window.__blockedBaseline"),
    { knownQueueIds: [303], newRequestIds: [303] },
    "real Chromium keeps the denied-storage baseline in memory",
  );

  const unsupportedKey = "complytrack:contractor-approvals:7:45";
  await evaluate(cdp, secondTab.sessionId, `
    (async () => {
      const mod = await import(${JSON.stringify(helperUrl)});
      const unsupportedWindow = Object.create(window);
      Object.defineProperty(unsupportedWindow, "localStorage", {
        get() { throw new DOMException("Access denied", "SecurityError"); },
      });
      Object.defineProperty(unsupportedWindow, "BroadcastChannel", { value: undefined });
      window.__unsupportedState = null;
      window.__unsupportedUnsubscribe = mod.subscribeToApprovalRefreshStorage(
        unsupportedWindow,
        ${JSON.stringify(unsupportedKey)},
        state => { window.__unsupportedState = state; },
      );
    })()
  `);
  await evaluate(cdp, firstTab.sessionId, `
    (async () => {
      const mod = await import(${JSON.stringify(helperUrl)});
      const unsupportedWindow = Object.create(window);
      Object.defineProperty(unsupportedWindow, "localStorage", {
        get() { throw new DOMException("Access denied", "SecurityError"); },
      });
      Object.defineProperty(unsupportedWindow, "BroadcastChannel", { value: undefined });
      mod.persistApprovalRefreshState(unsupportedWindow, ${JSON.stringify(unsupportedKey)}, new Set([404]), [404]);
      window.__unsupportedBaseline = mod.readPersistedApprovalRefreshState(
        unsupportedWindow,
        ${JSON.stringify(unsupportedKey)},
      );
    })()
  `);
  assert.deepEqual(
    await evaluate(cdp, firstTab.sessionId, "window.__unsupportedBaseline"),
    { knownQueueIds: [404], newRequestIds: [404] },
    "unsupported browser APIs retain a predictable same-tab baseline",
  );
  assert.equal(
    await evaluate(cdp, secondTab.sessionId, "window.__unsupportedState"),
    null,
    "unsupported browser APIs do not invent cross-tab delivery",
  );

  console.log("Contractor approval Chromium privacy checks passed (incognito, denied storage, unsupported APIs).");
  console.log("Firefox private-mode check skipped: Firefox is not installed in this runtime.");
  console.log("Safari private-mode check skipped: Safari is unavailable on this Linux runtime.");
} catch (error) {
  if (chromium && !chromium.killed) {
    const details = chromeErrors?.join("") ?? "";
    if (details) error.message += `\nChromium stderr: ${details}`;
  }
  throw error;
} finally {
  for (const tab of tabs) {
    try {
      await cdp?.send("Target.closeTarget", { targetId: tab.targetId });
    } catch {
      // Browser shutdown below is sufficient if a tab already disappeared.
    }
  }
  cdp?.close();
  if (chromium && chromium.exitCode === null) {
    const exited = new Promise(resolve => chromium.once("exit", resolve));
    chromium.kill("SIGTERM");
    await exited;
  }
  await new Promise(resolve => httpServer?.close(() => resolve()));
  await rm(tempDir, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 250,
  });
}