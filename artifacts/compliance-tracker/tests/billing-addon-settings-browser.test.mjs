import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { chromium } from "@playwright/test";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const addonFixtureUrl = new URL("../../api-server/tests/fixtures/billable-addons.json", import.meta.url);
const fixtureText = await readFile(addonFixtureUrl, "utf8").catch(error => {
  throw new Error(`Required independent billable add-on fixture is unavailable at ${addonFixtureUrl.pathname}: ${error.message}`);
});
const addons = JSON.parse(fixtureText);
assert.ok(Array.isArray(addons) && addons.length > 0, "billable-addons.json must contain a non-empty array");
for (const addon of addons) {
  assert.equal(typeof addon.key, "string", "every fixture add-on must have a key");
  assert.equal(typeof addon.label, "string", `${addon.key} must have a label`);
  assert.ok(Number.isSafeInteger(addon.amountPence) && addon.amountPence >= 0, `${addon.key} must have a non-negative amountPence`);
}
assert.equal(new Set(addons.map(addon => addon.key)).size, addons.length, "fixture add-on keys must be unique");
assert.ok(!addons.some(addon => addon.key === "core" || addon.key === "bundle"), "the independent fixture must contain add-ons only");
for (const key of ["pooltrack", "biketrack", "hottubtrack"]) {
  assert.ok(addons.some(addon => addon.key === key), `the independent fixture must include ${key}`);
}

const coreService = { key: "core", label: "ComplyTrack", amountPence: 1000 };
const bundleService = { key: "bundle", label: "ComplyTrack Complete", amountPence: 5000 };
const catalog = [coreService, ...addons, bundleService];
const activeAddons = new Set();
const billingConfigReads = [];
const serviceMutationRequests = [];
const csrfHeaders = [];
const unexpectedApiRequests = [];
const failedApiResponses = [];
let csrfTokenRequests = 0;
// Per-service queue of mocked add outcomes. An empty queue means the mocked
// billing boundary activates the service, mirroring the real API's response
// shape ({ ok: true, entitled: [...service keys] }). Nothing reaches Stripe.
const serviceBehaviors = new Map();
// Mirrors the server's add-on price readiness exposed on /billing/config.
const unavailablePrices = new Set();
let availabilityChecked = true;
// When set, service POSTs wait until the test releases them, so the busy state
// can be observed and double clicks attempted while the request is in flight.
let serviceGate = null;
const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};

const freePort = async () => {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
};

const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
const vite = spawn("pnpm", ["exec", "vite", "--config", "vite.config.ts", "--host", "127.0.0.1"], {
  cwd: root,
  env: { ...process.env, PORT: String(port), BASE_PATH: "/", NODE_ENV: "test", REPL_ID: undefined },
  stdio: ["ignore", "pipe", "pipe"],
});
let viteLogs = "";
let viteSpawnError = null;
vite.stdout.on("data", chunk => { viteLogs += chunk.toString(); });
vite.stderr.on("data", chunk => { viteLogs += chunk.toString(); });
vite.on("error", error => { viteSpawnError = error; });
let browser;
let page;

const jsonResponse = (route, data, status = 200) => route.fulfill({
  status,
  contentType: "application/json",
  body: JSON.stringify(data),
});

const authFixture = () => ({
  user: {
    id: 166,
    email: "billing-settings@example.test",
    name: "Billing Settings Browser Test",
    role: "client_admin",
    clientId: 42,
    departmentId: null,
    active: true,
    totpEnabled: false,
    recoveryCodesRemaining: 10,
  },
  client: {
    id: 42,
    name: "Billing Fixture Client",
    slug: "billing-fixture-client",
    logoUrl: null,
    primaryColor: "#2F7C8C",
    active: true,
  },
  services: ["core", ...activeAddons],
  billingLocked: false,
});

const currentBillingConfig = () => ({
  subscription: { status: "active" },
  siteCount: 1,
  perSite: { priceId: "price_core_fixture", unitAmount: 1000, currency: "gbp" },
  billableQuantity: 1,
  monthlyTotal: 1000 + [...activeAddons].reduce((sum, key) => sum + addons.find(addon => addon.key === key).amountPence, 0),
  services: {
    entitled: ["core", ...activeAddons],
    addons: [...activeAddons],
    bundle: false,
    subscribed: true,
    perSiteRate: 1000,
    capPence: 5000,
    addonAvailability: { checked: availabilityChecked, unavailable: [...unavailablePrices] },
    catalog,
  },
});

async function waitForVite() {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (viteSpawnError) throw new Error(`Could not start Vite: ${viteSpawnError.message}`);
    if (vite.exitCode !== null) throw new Error(`Vite exited before startup:\n${viteLogs}`);
    try {
      const response = await fetch(`${baseUrl}/tests/billing-addon-settings-harness.html`);
      if (response.ok) return;
    } catch {
      // Vite is still starting.
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Vite did not start:\n${viteLogs}`);
}

async function routeApi(route, url) {
  const request = route.request();
  const { pathname } = url;
  const method = request.method();

  if (pathname === "/api/auth/csrf-token" && method === "GET") {
    csrfTokenRequests += 1;
    return jsonResponse(route, { token: "billing-settings-test-csrf" });
  }
  if (pathname === "/api/auth/me" && method === "GET") return jsonResponse(route, authFixture());
  if (pathname === "/api/billing/config" && method === "GET") {
    const config = currentBillingConfig();
    billingConfigReads.push(config);
    return jsonResponse(route, config);
  }
  if (pathname === "/api/billing/services" && method === "POST") {
    const body = request.postDataJSON();
    const csrfHeader = request.headers()["x-csrf-token"] ?? null;
    serviceMutationRequests.push({ body, csrfHeader });
    csrfHeaders.push(csrfHeader);
    if (csrfHeader !== "billing-settings-test-csrf") {
      return jsonResponse(route, { error: "Missing or invalid billing session CSRF token" }, 403);
    }
    if (body.action !== "add" || !addons.some(addon => addon.key === body.service)) {
      return jsonResponse(route, { error: "Unexpected billing service action" }, 400);
    }
    const behavior = serviceBehaviors.get(body.service)?.shift();
    if (serviceGate) await serviceGate.promise;
    if (behavior?.abort) return route.abort("failed");
    if (behavior) {
      if (behavior.activate) activeAddons.add(body.service);
      behavior.after?.();
      return jsonResponse(route, behavior.body, behavior.status ?? 200);
    }
    activeAddons.add(body.service);
    return jsonResponse(route, { ok: true, entitled: ["core", ...activeAddons] });
  }
  if (pathname === "/api/billing/refresh-access" && method === "POST") {
    return jsonResponse(route, { billingLocked: false });
  }
  if (pathname === "/api/billing/cancellation-status" && method === "GET") {
    return jsonResponse(route, { accessEndsAt: null });
  }
  if (pathname === "/api/billing/invoices" && method === "GET") {
    return jsonResponse(route, { invoices: [] });
  }
  if (pathname === "/api/storage/usage" && method === "GET") {
    return jsonResponse(route, {
      usedBytes: 0,
      objectCount: 0,
      warningThresholdBytes: 5 * 1024 ** 3,
      warning: false,
      monthlyDownloadBytes: 0,
      monthlyDownloadTrackingAvailable: true,
      month: "2026-09",
      estimatedCost: {
        currency: "gbp",
        excessStorageBytes: 0,
        includedStorageBytes: 5 * 1024 ** 3,
        totalMinorUnits: 0,
        providerMinorUnits: 0,
        markupMinorUnits: 0,
        markupPercent: 20,
      },
    });
  }
  if (pathname === "/api/settings" && method === "GET") {
    return jsonResponse(route, {
      companyName: "Billing Fixture Client",
      defaultLeadTimeDays: "30",
      contractorComplianceLeadTimeDays: "30",
      notificationEmail: "",
      trackSummaryRouting: "{}",
      smtpFrom: "accounts@example.test",
      smtpFromName: "Billing Fixture Client",
      accountTimezone: "Europe/London",
    });
  }
  if (pathname === "/api/data-deletion/request" && method === "GET") {
    return jsonResponse(route, { eligible: false, request: null });
  }
  if (pathname === "/api/departments" && method === "GET") return jsonResponse(route, []);
  if (pathname === "/api/users" && method === "GET") return jsonResponse(route, []);
  if (pathname === "/api/sites" && method === "GET") return jsonResponse(route, []);
  if (pathname === "/api/track-actions/templates" && method === "GET") return jsonResponse(route, []);
  if (pathname === "/api/photos/requirements" && method === "GET") return jsonResponse(route, []);
  if (pathname === "/api/email-domain" && method === "GET") {
    return jsonResponse(route, {
      configured: true,
      domainName: "example.test",
      status: "verified",
      records: [],
    });
  }
  if (pathname === "/api/billing/modules" && method === "GET") {
    return jsonResponse(route, {
      safetrack: { enabled: false },
      dailytrack: { enabled: false },
    });
  }
  if (pathname === "/api/auth/passkeys" && method === "GET") return jsonResponse(route, { passkeys: [] });

  unexpectedApiRequests.push({
    method,
    url: url.toString(),
    body: request.postData() ?? null,
  });
  return jsonResponse(route, { error: `Unexpected test API request: ${method} ${pathname}` }, 501);
}

try {
  await waitForVite();
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_PATH ?? "/repl/tools/bin/chromium",
  });
  page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  page.setDefaultTimeout(15000);

  const pageErrors = [];
  const consoleErrors = [];
  const dialogMessages = [];
  page.on("console", message => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
      console.error(`[browser:error] ${message.text()}`);
    }
  });
  page.on("pageerror", error => {
    pageErrors.push(error.message);
    console.error(`[browser:pageerror] ${error.message}`);
  });
  page.on("response", response => {
    const url = new URL(response.url());
    if (url.pathname.startsWith("/api/") && response.status() >= 400) {
      failedApiResponses.push({ method: response.request().method(), url: url.toString(), status: response.status() });
    }
  });
  page.on("dialog", async dialog => {
    dialogMessages.push(dialog.message());
    await dialog.accept();
  });
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith("/api/")) return routeApi(route, url);
    return route.continue();
  });

  const response = await page.goto(`${baseUrl}/tests/billing-addon-settings-harness.html`, {
    waitUntil: "domcontentloaded",
  });
  assert.ok(response?.ok(), `Settings harness navigation failed: ${response?.status() ?? "no response"}`);

  const servicesCard = page.locator("main").getByText("Services", { exact: true }).locator("xpath=../..");
  await servicesCard.getByText(addons[0].label, { exact: true }).waitFor({ state: "visible" });

  for (const addon of addons) {
    const row = servicesCard.getByText(addon.label, { exact: true }).locator("xpath=../..");
    await row.waitFor({ state: "visible" });
    assert.equal(
      await row.getByText(`£${(addon.amountPence / 100).toFixed(0)}/site/month`, { exact: true }).count(),
      1,
      `${addon.key} should show its fixture price`,
    );
    assert.equal(await row.getByRole("button", { name: "Add", exact: true }).count(), 1, `${addon.key} should offer Add on the subscribed base-core account`);
    assert.equal(await row.getByText("Not enabled", { exact: true }).count(), 1, `${addon.key} should start inactive`);
  }

  for (const baseService of [coreService, bundleService]) {
    assert.equal(
      await servicesCard.getByText(baseService.label, { exact: true }).count(),
      0,
      `${baseService.key} must not render as an add-on row`,
    );
  }

  for (const addon of addons) {
    const row = servicesCard.getByText(addon.label, { exact: true }).locator("xpath=../..");
    const addButton = row.getByRole("button", { name: "Add", exact: true });
    const postResponse = page.waitForResponse(response => {
      const request = response.request();
      if (request.method() !== "POST" || new URL(response.url()).pathname !== "/api/billing/services") return false;
      try {
        return request.postDataJSON().service === addon.key;
      } catch {
        return false;
      }
    });
    await addButton.click();
    const serviceResponse = await postResponse;
    assert.equal(serviceResponse.status(), 200, `${addon.key} add request should succeed through the mocked billing boundary`);
    await row.getByText("Active", { exact: true }).waitFor({ state: "visible" });
    await row.getByRole("button", { name: "Remove", exact: true }).waitFor({ state: "visible" });
    assert.equal(await row.getByRole("button", { name: "Add", exact: true }).count(), 0, `${addon.key} should replace Add with Remove`);
    assert.ok(
      billingConfigReads.at(-1)?.services.addons.includes(addon.key),
      `${addon.key} should appear in the updated billing config returned to Settings`,
    );
  }

  assert.equal(dialogMessages.length, addons.length, "each Add action should confirm the full-month charge before posting");
  for (const addon of addons) {
    const expectedConfirmation = `You'll be charged a full month for 1 site(s) now (£${addon.amountPence / 100}); renews monthly with your subscription.`;
    assert.ok(dialogMessages.includes(expectedConfirmation), `${addon.key} should confirm its fixture amount before adding`);
  }
  assert.equal(serviceMutationRequests.length, addons.length, "Settings should make exactly one services POST for every fixture add-on");
  for (const addon of addons) {
    assert.ok(
      serviceMutationRequests.some(({ body }) => JSON.stringify(body) === JSON.stringify({ service: addon.key, action: "add" })),
      `Settings should POST the exact add action for ${addon.key}`,
    );
  }
  assert.ok(csrfTokenRequests > 0, "service mutations should obtain the shared session CSRF token");
  assert.deepEqual(csrfHeaders, Array(addons.length).fill("billing-settings-test-csrf"), "every service mutation should carry the session CSRF header");
  assert.deepEqual(unexpectedApiRequests, [], `unexpected API requests must fail the browser test: ${JSON.stringify(unexpectedApiRequests)}`);
  assert.deepEqual(failedApiResponses, [], `API requests must not fail: ${JSON.stringify(failedApiResponses)}`);
  assert.deepEqual(pageErrors, [], `Settings must not throw browser errors: ${pageErrors.join("; ")}`);
  assert.deepEqual(consoleErrors, [], `Settings must not log browser errors: ${consoleErrors.join("; ")}`);

  // ---------------------------------------------------------------------------
  // Failed, pending and unconfirmed adds must never make a row look Active.
  // ---------------------------------------------------------------------------
  const rowFor = label => servicesCard.getByText(label, { exact: true }).locator("xpath=../..");
  const addonByKey = key => {
    const addon = addons.find(candidate => candidate.key === key);
    assert.ok(addon, `fixture must include ${key}`);
    return addon;
  };
  const postsFor = key => serviceMutationRequests.filter(({ body }) => body.service === key);
  const expectedFailureStatuses = new Set();
  const resetObservations = () => {
    serviceMutationRequests.length = 0;
    csrfHeaders.length = 0;
    dialogMessages.length = 0;
    failedApiResponses.length = 0;
    consoleErrors.length = 0;
    pageErrors.length = 0;
    expectedFailureStatuses.clear();
  };
  const reloadSettings = async () => {
    await page.reload({ waitUntil: "domcontentloaded" });
    await servicesCard.getByText(addons[0].label, { exact: true }).waitFor({ state: "visible" });
  };
  const assertNotActive = async (row, key, context) => {
    assert.equal(await row.getByText("Active", { exact: true }).count(), 0, `${key} must not show Active after ${context}`);
  };
  const waitForPosts = async (key, count) => {
    for (let attempt = 0; attempt < 100 && postsFor(key).length < count; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(postsFor(key).length, count, `${key} should have exactly ${count} service POST(s)`);
  };

  // Clicks Add with the request held open, double-clicks while busy, then
  // releases it. Proves the busy control blocks duplicate mutations.
  const addWhileHeld = async (key) => {
    const addon = addonByKey(key);
    const row = rowFor(addon.label);
    const before = postsFor(key).length;
    serviceGate = deferred();
    await row.getByRole("button", { name: "Add", exact: true }).dblclick();
    await waitForPosts(key, before + 1);
    const busyButton = row.getByRole("button", { name: "Adding...", exact: true });
    await busyButton.waitFor({ state: "visible" });
    assert.equal(await busyButton.isDisabled(), true, `${key} Add must be disabled while its request is in flight`);
    await busyButton.click({ force: true }).catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(postsFor(key).length, before + 1, `${key} busy clicks must not send duplicate mutation requests`);
    const gate = serviceGate;
    serviceGate = null;
    gate.resolve();
    await row.getByRole("button", { name: "Adding...", exact: true }).waitFor({ state: "detached" });
    return row;
  };

  const assertRetryable = async (row, key, notice) => {
    await row.getByText(notice, { exact: true }).waitFor({ state: "visible" });
    await assertNotActive(row, key, "an unconfirmed add");
    const addButton = row.getByRole("button", { name: "Add", exact: true });
    await addButton.waitFor({ state: "visible" });
    assert.equal(await addButton.isEnabled(), true, `${key} Add must recover after the request settles`);
    assert.equal(await row.getByRole("button", { name: "Remove", exact: true }).count(), 0, `${key} must not offer Remove when not on the subscription`);
  };

  const retrySucceeds = async (row, key) => {
    const firstBody = JSON.stringify(postsFor(key)[0].body);
    await addWhileHeld(key);
    await row.getByText("Active", { exact: true }).waitFor({ state: "visible" });
    await row.getByRole("button", { name: "Remove", exact: true }).waitFor({ state: "visible" });
    assert.equal(await row.getByTestId("addon-action-notice").count(), 0, `${key} failure notice should clear after a confirmed retry`);
    const posts = postsFor(key);
    assert.equal(posts.length, 2, `${key} should send exactly one POST per attempt`);
    assert.equal(JSON.stringify(posts[1].body), firstBody, `${key} retry must send the same request so the server reuses its idempotency key`);
    assert.deepEqual(posts[1].body, { service: key, action: "add" }, `${key} retry must carry no client-generated key that could vary`);
  };

  activeAddons.clear();
  resetObservations();
  await reloadSettings();

  // 1. Declined payment: the existing backend charge_failed semantics (502).
  {
    const key = "fixtrack";
    const declined = "We couldn't complete the charge, so the service wasn't enabled. Please try again.";
    serviceBehaviors.set(key, [{ status: 502, body: { error: declined } }]);
    expectedFailureStatuses.add(502);
    const row = await addWhileHeld(key);
    await assertRetryable(row, key, declined);
    assert.equal(await row.getByText("Not enabled", { exact: true }).count(), 1, "declined add stays Not enabled");
    await retrySucceeds(row, key);
  }

  // 2a. API failure: server error.
  {
    const key = "firetrack";
    serviceBehaviors.set(key, [{ status: 500, body: { error: "Internal billing error" } }]);
    expectedFailureStatuses.add(500);
    const row = await addWhileHeld(key);
    await assertRetryable(row, key, "Internal billing error");
    await retrySucceeds(row, key);
  }

  // 2b. API failure: the request never reaches the server.
  {
    const key = "treetrack";
    serviceBehaviors.set(key, [{ abort: true }]);
    const row = await addWhileHeld(key);
    await assertRetryable(
      row,
      key,
      "We couldn't reach the billing service, so we can't confirm whether TreeTrack changed. Refresh to check before trying again.",
    );
    await retrySucceeds(row, key);
  }

  // 3a. paymentPending: the service is not on the subscription yet.
  {
    const key = "kitchentrack";
    serviceBehaviors.set(key, [{ body: { ok: true, entitled: ["core"], paymentPending: true } }]);
    const row = await addWhileHeld(key);
    await assertRetryable(row, key, "Payment for KitchenTrack needs attention in the billing portal before it can be used.");
    await row.getByText("Awaiting confirmation", { exact: true }).waitFor({ state: "visible" });
    await retrySucceeds(row, key);
  }

  // 3b. paymentPending while the item already appears on the subscription: the
  // row must still not claim Active.
  {
    const key = "hottubtrack";
    serviceBehaviors.set(key, [{ activate: true, body: { ok: true, entitled: ["core", key], paymentPending: true } }]);
    const row = await addWhileHeld(key);
    await row.getByText("Payment for HotTubTrack needs attention in the billing portal before it can be used.", { exact: true }).waitFor({ state: "visible" });
    await row.getByText("Awaiting confirmation", { exact: true }).waitFor({ state: "visible" });
    await assertNotActive(row, key, "a pending payment that is already on the subscription");
    assert.ok(billingConfigReads.at(-1).services.addons.includes(key), "the mocked config lists the pending item");
    assert.equal(postsFor(key).length, 1, "pending add sent one mutation");
  }

  // 4. Unconfirmed entitlement: ok but the returned entitlements omit it.
  {
    const key = "legionellatrack";
    serviceBehaviors.set(key, [{ body: { ok: true, entitled: ["core"] } }]);
    const row = await addWhileHeld(key);
    await assertRetryable(row, key, "We couldn't confirm LegionellaTrack is active yet. Refresh in a moment; contact support if it doesn't appear.");
    await row.getByText("Awaiting confirmation", { exact: true }).waitFor({ state: "visible" });
    await retrySucceeds(row, key);
  }

  const isExpectedResourceError = text => /Failed to load resource/.test(text);
  assert.deepEqual(unexpectedApiRequests, [], `unexpected API requests: ${JSON.stringify(unexpectedApiRequests)}`);
  assert.deepEqual(
    failedApiResponses.filter(({ status }) => !expectedFailureStatuses.has(status)),
    [],
    `only the mocked failures may fail: ${JSON.stringify(failedApiResponses)}`,
  );
  assert.deepEqual(pageErrors, [], `Settings must not throw on failed adds: ${pageErrors.join("; ")}`);
  assert.deepEqual(consoleErrors.filter(text => !isExpectedResourceError(text)), [], `unexpected console errors: ${consoleErrors.join("; ")}`);
  assert.ok(csrfHeaders.every(header => header === "billing-settings-test-csrf"), "every attempt carries the session CSRF header");
  assert.equal(serviceBehaviors.size > 0 && [...serviceBehaviors.values()].every(queue => queue.length === 0), true, "every mocked failure was exercised");
  console.log("Settings add-on failure, pending, unconfirmed and retry checks passed.");

  // ---------------------------------------------------------------------------
  // Price availability: explain unavailable add-ons instead of a broken Add.
  // ---------------------------------------------------------------------------
  activeAddons.clear();
  serviceBehaviors.clear();
  resetObservations();
  activeAddons.add("firetrack");
  unavailablePrices.add("pooltrack");
  unavailablePrices.add("firetrack");
  await reloadSettings();
  {
    const pool = rowFor("PoolTrack");
    await pool.waitFor({ state: "visible" });
    await pool.getByText("Temporarily unavailable", { exact: true }).waitFor({ state: "visible" });
    await pool.getByText(
      "PoolTrack can't be added online right now because its price is temporarily unavailable. Nothing has been charged — please try again later or contact support.",
      { exact: true },
    ).waitFor({ state: "visible" });
    assert.equal(await pool.getByRole("button", { name: "Add", exact: true }).count(), 0, "unavailable PoolTrack must not offer Add");
    const unavailableButton = pool.getByRole("button", { name: "PoolTrack unavailable", exact: true });
    assert.equal(await unavailableButton.isDisabled(), true, "the unavailable control must be inert");

    const paid = rowFor("FireTrack");
    await paid.getByText("Active", { exact: true }).waitFor({ state: "visible" });
    await paid.getByRole("button", { name: "Remove", exact: true }).waitFor({ state: "visible" });
    assert.equal(await paid.getByText("Temporarily unavailable", { exact: true }).count(), 0, "already-paid access is preserved when its price is unavailable");

    const bike = rowFor("BikeTrack");
    assert.equal(await bike.getByRole("button", { name: "Add", exact: true }).count(), 1, "available add-ons still offer Add");
  }

  // Price lost between loading Settings and clicking Add: the server's 503
  // preflight rejection is explained and the row flips to unavailable.
  {
    const key = "biketrack";
    serviceBehaviors.set(key, [{
      status: 503,
      body: {
        error: "Service price is missing or ambiguous",
        missingServicePrices: [key],
        duplicateServicePrices: [],
        servicePriceIssues: [{ key, label: "BikeTrack", reason: "missing" }],
      },
      after: () => unavailablePrices.add(key),
    }]);
    expectedFailureStatuses.add(503);
    const row = await addWhileHeld(key);
    await row.getByText(
      "BikeTrack can't be added online right now because its price is temporarily unavailable. You have not been charged.",
      { exact: true },
    ).waitFor({ state: "visible" });
    await row.getByText("Temporarily unavailable", { exact: true }).waitFor({ state: "visible" });
    assert.equal(await row.getByRole("button", { name: "Add", exact: true }).count(), 0, "Add is withdrawn once the price is known to be unavailable");
    await assertNotActive(row, key, "a price-unavailable rejection");
  }

  // Availability could not be checked: pause Add everywhere, keep paid access.
  availabilityChecked = false;
  await reloadSettings();
  {
    const row = rowFor("SwimTrack");
    await row.getByText(
      "We couldn't check add-on availability just now, so adding is paused. Nothing has been charged — please refresh or try again shortly.",
      { exact: true },
    ).waitFor({ state: "visible" });
    assert.equal(await servicesCard.getByRole("button", { name: "Add", exact: true }).count(), 0, "no Add is offered while availability is unknown");
    await rowFor("FireTrack").getByText("Active", { exact: true }).waitFor({ state: "visible" });
  }

  // Prices recovered: Add returns and works, including legacy PoolTrack.
  availabilityChecked = true;
  unavailablePrices.clear();
  await reloadSettings();
  {
    for (const label of ["PoolTrack", "BikeTrack"]) {
      const row = rowFor(label);
      await row.getByRole("button", { name: "Add", exact: true }).waitFor({ state: "visible" });
      assert.equal(await row.getByText("Temporarily unavailable", { exact: true }).count(), 0, `${label} is purchasable again`);
    }
    const row = await addWhileHeld("pooltrack");
    await row.getByText("Active", { exact: true }).waitFor({ state: "visible" });
  }
  assert.deepEqual(
    serviceMutationRequests.map(({ body }) => body),
    [{ service: "biketrack", action: "add" }, { service: "pooltrack", action: "add" }],
    "no add is sent for an unavailable add-on",
  );
  assert.deepEqual(unexpectedApiRequests, [], `unexpected API requests: ${JSON.stringify(unexpectedApiRequests)}`);
  assert.deepEqual(failedApiResponses.filter(({ status }) => !expectedFailureStatuses.has(status)), []);
  assert.deepEqual(pageErrors, [], `Settings must not throw: ${pageErrors.join("; ")}`);
  assert.deepEqual(consoleErrors.filter(text => !isExpectedResourceError(text)), [], `unexpected console errors: ${consoleErrors.join("; ")}`);
  console.log("Settings add-on price availability checks passed.");

  console.log(`Settings add-on browser checks passed for all ${addons.length} billable add-ons.`);
} catch (error) {
  console.error("Billing add-on Settings browser test failed:", error);
  if (page) {
    console.error("Billing Settings browser page:", page.url());
    console.error("Visible page text:", (await page.locator("body").innerText().catch(() => "")).slice(0, 6000));
  }
  if (viteLogs) console.error("Vite server logs:\n", viteLogs.slice(-16000));
  throw error;
} finally {
  try {
    await browser?.close();
  } finally {
    if (vite.exitCode === null) {
      vite.kill("SIGTERM");
      await new Promise(resolve => {
        if (vite.exitCode !== null) return resolve();
        const forceKill = setTimeout(() => {
          if (vite.exitCode === null) vite.kill("SIGKILL");
          resolve();
        }, 3000);
        vite.once("exit", () => {
          clearTimeout(forceKill);
          resolve();
        });
      });
    }
  }
}