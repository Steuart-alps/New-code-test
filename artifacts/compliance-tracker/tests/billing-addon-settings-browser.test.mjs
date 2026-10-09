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
    activeAddons.add(body.service);
    return jsonResponse(route, { ok: true, entitled: true });
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