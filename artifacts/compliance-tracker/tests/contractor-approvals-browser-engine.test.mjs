import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, firefox, webkit } from "@playwright/test";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const browserName = process.env.APPROVAL_BROWSER ?? "chromium";
const browserTypes = { chromium, firefox, webkit };
const browserType = browserTypes[browserName];

if (!browserType) {
  throw new Error(`Unsupported APPROVAL_BROWSER=${browserName}; expected chromium, firefox, or webkit`);
}

const tempDir = await mkdtemp(path.join(tmpdir(), "contractor-approvals-browser-engine-"));
const helperBundle = path.join(tempDir, "contractor-approval-refresh-state.mjs");
let httpServer;
let browser;

async function startFixtureServer(helperContents) {
  httpServer = createServer((request, response) => {
    if (request.url?.startsWith("/contractor-approval-refresh-state.mjs")) {
      response.writeHead(200, { "content-type": "text/javascript" });
      response.end(helperContents);
      return;
    }
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<!doctype html><title>approval refresh browser engine test</title>");
  });
  await new Promise(resolve => httpServer.listen(0, "127.0.0.1", resolve));
  return httpServer.address().port;
}

try {
  await build({
    entryPoints: [path.join(root, "src/lib/contractor-approval-refresh-state.ts")],
    outfile: helperBundle,
    bundle: true,
    format: "esm",
    platform: "browser",
  });
  const helperContents = await readFile(helperBundle, "utf8");
  const httpPort = await startFixtureServer(helperContents);
  const helperUrl = `http://127.0.0.1:${httpPort}/contractor-approval-refresh-state.mjs`;
  const fixtureUrl = `http://127.0.0.1:${httpPort}/`;

  // Playwright browser contexts are private/incognito profiles by design.
  browser = await browserType.launch({
    headless: true,
    executablePath: process.env.APPROVAL_BROWSER_EXECUTABLE_PATH || undefined,
  });
  const context = await browser.newContext();
  const firstTab = await context.newPage();
  const secondTab = await context.newPage();
  const otherClientTab = await context.newPage();
  await Promise.all([firstTab, secondTab, otherClientTab].map(page => page.goto(fixtureUrl)));

  const sharedKey = "complytrack:contractor-approvals:7:42";
  const otherClientKey = "complytrack:contractor-approvals:7:43";
  await secondTab.evaluate(async ({ helperUrl, key }) => {
    const mod = await import(helperUrl);
    window.__approvalState = null;
    window.__unsubscribe = mod.subscribeToApprovalRefreshStorage(
      window,
      key,
      state => {
        window.__approvalState = state;
      },
    );
  }, { helperUrl, key: sharedKey });
  await otherClientTab.evaluate(async ({ helperUrl, key }) => {
    const mod = await import(helperUrl);
    window.__otherClientState = null;
    window.__unsubscribe = mod.subscribeToApprovalRefreshStorage(
      window,
      key,
      state => {
        window.__otherClientState = state;
      },
    );
  }, { helperUrl, key: otherClientKey });
  await firstTab.evaluate(async ({ helperUrl, key }) => {
    const mod = await import(helperUrl);
    mod.persistApprovalRefreshState(window, key, new Set([101, 202]), [202]);
  }, { helperUrl, key: sharedKey });
  await secondTab.waitForFunction(() => window.__approvalState !== null);
  assert.deepEqual(
    await secondTab.evaluate(() => window.__approvalState),
    { knownQueueIds: [101, 202], newRequestIds: [202] },
    `${browserName} private tabs receive the same-user approval update`,
  );
  assert.equal(
    await otherClientTab.evaluate(() => window.__otherClientState),
    null,
    `${browserName} private tabs do not receive another client's approval update`,
  );

  const blockedKey = "complytrack:contractor-approvals:7:44";
  await secondTab.evaluate(async ({ helperUrl, key }) => {
    const mod = await import(helperUrl);
    const blockedWindow = Object.create(window);
    Object.defineProperty(blockedWindow, "localStorage", {
      get() {
        throw new DOMException("Access denied", "SecurityError");
      },
    });
    window.__blockedState = null;
    window.__blockedUnsubscribe = mod.subscribeToApprovalRefreshStorage(
      blockedWindow,
      key,
      state => {
        window.__blockedState = state;
      },
    );
  }, { helperUrl, key: blockedKey });
  await firstTab.evaluate(async ({ helperUrl, key }) => {
    const mod = await import(helperUrl);
    const blockedWindow = Object.create(window);
    Object.defineProperty(blockedWindow, "localStorage", {
      get() {
        throw new DOMException("Access denied", "SecurityError");
      },
    });
    mod.persistApprovalRefreshState(blockedWindow, key, new Set([303]), [303]);
    window.__blockedBaseline = mod.readPersistedApprovalRefreshState(blockedWindow, key);
  }, { helperUrl, key: blockedKey });
  await secondTab.waitForFunction(() => window.__blockedState !== null);
  assert.deepEqual(
    await secondTab.evaluate(() => window.__blockedState),
    { knownQueueIds: [303], newRequestIds: [303] },
    `${browserName} BroadcastChannel works when localStorage access is denied`,
  );
  assert.deepEqual(
    await firstTab.evaluate(() => window.__blockedBaseline),
    { knownQueueIds: [303], newRequestIds: [303] },
    `${browserName} keeps the denied-storage baseline in memory`,
  );

  const unsupportedKey = "complytrack:contractor-approvals:7:45";
  await secondTab.evaluate(async ({ helperUrl, key }) => {
    const mod = await import(helperUrl);
    const unsupportedWindow = Object.create(window);
    Object.defineProperty(unsupportedWindow, "localStorage", {
      get() {
        throw new DOMException("Access denied", "SecurityError");
      },
    });
    Object.defineProperty(unsupportedWindow, "BroadcastChannel", { value: undefined });
    window.__unsupportedState = null;
    window.__unsupportedUnsubscribe = mod.subscribeToApprovalRefreshStorage(
      unsupportedWindow,
      key,
      state => {
        window.__unsupportedState = state;
      },
    );
  }, { helperUrl, key: unsupportedKey });
  const unsupportedBaseline = await firstTab.evaluate(async ({ helperUrl, key }) => {
    const mod = await import(helperUrl);
    const unsupportedWindow = Object.create(window);
    Object.defineProperty(unsupportedWindow, "localStorage", {
      get() {
        throw new DOMException("Access denied", "SecurityError");
      },
    });
    Object.defineProperty(unsupportedWindow, "BroadcastChannel", { value: undefined });
    mod.persistApprovalRefreshState(unsupportedWindow, key, new Set([404]), [404]);
    return mod.readPersistedApprovalRefreshState(unsupportedWindow, key);
  }, { helperUrl, key: unsupportedKey });
  assert.deepEqual(
    unsupportedBaseline,
    { knownQueueIds: [404], newRequestIds: [404] },
    `${browserName} keeps a same-tab baseline when both APIs are unavailable`,
  );
  assert.equal(
    await secondTab.evaluate(() => window.__unsupportedState),
    null,
    `${browserName} does not invent cross-tab delivery without supported APIs`,
  );

  console.log(`Contractor approval ${browserName} private-browser checks passed.`);
} catch (error) {
  if (/Executable doesn't exist|browserType\.launch:.*executable/i.test(String(error))) {
    console.log(`Contractor approval ${browserName} browser check skipped: browser binary is unavailable.`);
  } else {
    throw error;
  }
} finally {
  await browser?.close();
  await new Promise(resolve => httpServer?.close(() => resolve()));
  await rm(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
}