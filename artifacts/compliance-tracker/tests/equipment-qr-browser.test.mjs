// Equipment QR labels in a real browser, against the real API and a
// disposable production-style database:
//   - an owner prints a label sheet from Equipment & QR labels;
//   - staff scanning a mower's label see today's pre-use check is due and the
//     button opens GreenTrack's pre-use form with that mower chosen;
//   - a cold water tank's label opens LegionellaTrack's form recording for it;
//   - "Report a fault" opens a FixTrack report naming the item;
//   - a site's opening checks label shows they are not done and opens
//     DailyTrack AM for that site; the accident label opens a new report;
//   - a made-up code says the label isn't available;
//   - scanning while signed out goes to sign-in, and signing in comes back.
//
// Run: pnpm --filter @workspace/api-server run test:equipment-qr-browser
import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { createServer as createViteServer } from "vite";
import { base as apiBase, createTenant, createUser } from "../../api-server/tests/approval-workflow-fixtures.mjs";

if (process.env.FRESH_SCHEMA_BROWSER_POLICY !== "1") {
  throw new Error("Run through `pnpm --filter @workspace/api-server run test:equipment-qr-browser`.");
}

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const apiOrigin = new URL(apiBase).origin;
let vite, viteCacheDir, browser, appOrigin, owner, staff, site, machine, tank, codes;

async function freePort() {
  const server = createNetServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

const ok = (result, status = 200) => {
  assert.equal(result.status, status, JSON.stringify(result.data));
  return result.data;
};

/** A browser context on the app origin, signed in as `session` (or signed out). */
async function contextFor(session) {
  const context = await browser.newContext({ viewport: { width: 400, height: 860 }, locale: "en-GB", acceptDownloads: true });
  // One origin for the browser, as in production; the proxy only rewrites the
  // app origin to the API's so the real CSRF same-origin check still applies.
  await context.route(`${appOrigin}/api/**`, async route => {
    const original = new URL(route.request().url());
    const headers = { ...route.request().headers() };
    if (headers.origin === appOrigin) headers.origin = apiOrigin;
    await route.fulfill({ response: await route.fetch({ url: `${apiOrigin}${original.pathname}${original.search}`, headers }) });
  });
  if (session) await signIn(context, session);
  return context;
}

async function signIn(context, session) {
  const cookie = session.request.cookie();
  const separator = cookie.indexOf("=");
  await context.addCookies([{ name: cookie.slice(0, separator), value: cookie.slice(separator + 1), url: appOrigin }]);
}

before(async () => {
  const port = await freePort();
  appOrigin = `http://127.0.0.1:${port}`;
  process.env.PORT = String(port);
  process.env.BASE_PATH = "/";
  viteCacheDir = await mkdtemp(path.join(tmpdir(), "equipment-qr-vite-"));
  vite = await createViteServer({
    configFile: path.join(appRoot, "vite.config.ts"), configLoader: "runner", cacheDir: viteCacheDir,
    logLevel: "error", server: { host: "127.0.0.1", port, strictPort: true, hmr: false },
  });
  await vite.listen();
  const executablePath = process.env.CHROMIUM_PATH
    ?? ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome"].find(candidate => existsSync(candidate));
  browser = await chromium.launch({ headless: true, executablePath });

  owner = await createTenant("equipment-qr", { browserPolicy: true });
  staff = await createUser(owner, { role: "client_staff" }, { browserPolicy: true });
  site = ok(await owner.request("POST", "/sites", { name: "Clubhouse", seedStarterChecks: false }), 201);
  machine = ok(await owner.request("POST", "/green-track/machines", { name: "Greens mower 1", type: "ride_on_cylinder", siteId: site.id }), 201);
  tank = ok(await owner.request("POST", "/equipment", { name: "Cold water tank 1", type: "cold_water_tank", siteId: site.id, location: "Plant room" }), 201);
});

after(async () => {
  await browser?.close();
  await vite?.close();
  if (viteCacheDir) await rm(viteCacheDir, { recursive: true, force: true });
});

test("an owner prints a sheet of labels", async () => {
  const context = await contextFor(owner);
  const page = await context.newPage();
  await page.goto(`${appOrigin}/equipment`);
  await page.getByRole("heading", { name: "Equipment & QR labels" }).first().waitFor({ timeout: 60_000 });
  await page.getByText("How to set up QR labels").waitFor();
  await page.getByLabel("Select Greens mower 1").click();
  await page.getByLabel("Select Cold water tank 1").click();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: /Download 2 labels/ }).click(),
  ]);
  const file = await download.path();
  const { readFile } = await import("node:fs/promises");
  assert.equal((await readFile(file)).subarray(0, 5).toString(), "%PDF-");
  const rows = ok(await owner.request("GET", `/equipment-labels?siteId=${site.id}`));
  codes = Object.fromEntries(rows.filter(r => r.code).map(r => [r.name, r.code]));
  assert.ok(codes["Greens mower 1"] && codes["Cold water tank 1"], JSON.stringify(rows));
  await page.getByText(codes["Greens mower 1"]).first().waitFor();
  await context.close();
});

test("staff scan the mower and land in today's pre-use check", async () => {
  const context = await contextFor(staff);
  const page = await context.newPage();
  await page.goto(`${appOrigin}/q/${codes["Greens mower 1"]}`);
  await page.getByRole("heading", { name: "Greens mower 1" }).waitFor({ timeout: 60_000 });
  await page.getByText("Not done yet today").waitFor();
  assert.equal(await page.getByRole("link", { name: "Record an inspection" }).count(), 0, "staff are not offered manager records");
  await page.getByRole("link", { name: "Start today's pre-use check" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor();
  await dialog.getByText("Greens mower 1").first().waitFor();
  assert.equal(new URL(page.url()).search, "", "the label's settings leave the address bar");
  await context.close();
});

test("the tank's label records its check against it", async () => {
  const context = await contextFor(staff);
  const page = await context.newPage();
  await page.goto(`${appOrigin}/q/${codes["Cold water tank 1"]}`);
  await page.getByRole("heading", { name: "Cold water tank 1" }).waitFor({ timeout: 60_000 });
  await page.getByRole("link", { name: "Record temperature" }).click();
  const dialog = page.getByRole("dialog");
  // The tank is chosen under "Which tank?" (or named above the form when the
  // user's tank list doesn't show it).
  await dialog.getByText(/^Cold water tank 1\b/).first().waitFor({ timeout: 30_000 });

  await page.goto(`${appOrigin}/q/${codes["Cold water tank 1"]}`);
  await page.getByRole("link", { name: "Report a fault" }).click();
  const report = page.getByRole("dialog");
  await report.waitFor({ timeout: 30_000 });
  assert.equal(await report.locator("input").first().inputValue(), "Fault: Cold water tank 1");
  await context.close();
});

/** Saves a screenshot when SCREENSHOT_DIR is set (for showing a change). */
async function screenshot(page, name) {
  if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, name), fullPage: true });
}

test("track labels open the site's checks and the accident report", async () => {
  const points = ok(await owner.request("GET", `/equipment-labels?siteId=${site.id}`)).filter(r => r.kind === "track_point");
  const items = ["opening_checks", "report_incident"].map(key => ({ kind: "track_point", ref: `${key}:${site.id}` }));
  assert.equal(items.every(item => points.some(p => p.ref === item.ref)), true, JSON.stringify(points));
  assert.equal((await owner.request("POST", "/equipment-labels/sheet", { items }, "buffer")).status, 200);
  const printed = ok(await owner.request("GET", `/equipment-labels?siteId=${site.id}`));
  const codeOf = key => printed.find(r => r.ref === `${key}:${site.id}`).code;

  const ownerContext = await contextFor(owner);
  const list = await ownerContext.newPage();
  await list.goto(`${appOrigin}/equipment`);
  await list.getByLabel("Select Opening checks").waitFor({ timeout: 60_000 });
  await screenshot(list, "1-print-labels-list.png");
  await ownerContext.close();

  const context = await contextFor(staff);
  const page = await context.newPage();
  await page.goto(`${appOrigin}/q/${codeOf("opening_checks")}`);
  await page.getByRole("heading", { name: "Opening checks" }).waitFor({ timeout: 60_000 });
  await page.getByText("Not done yet today").waitFor();
  await screenshot(page, "2-scan-opening-checks.png");
  await page.getByRole("link", { name: "Open today's opening checks" }).click();
  await page.waitForURL(url => new URL(url).pathname === "/daily-track-am", { timeout: 30_000 });
  assert.equal(new URL(page.url()).searchParams.get("siteId"), String(site.id));

  await page.goto(`${appOrigin}/q/${codeOf("report_incident")}`);
  await page.getByRole("heading", { name: "Report an accident or incident" }).waitFor({ timeout: 60_000 });
  await screenshot(page, "3-scan-accident-label.png");
  await page.getByRole("link", { name: "Report an accident or incident" }).click();
  await page.getByRole("dialog").waitFor({ timeout: 30_000 });
  await screenshot(page, "4-accident-report-opens.png");
  assert.equal(new URL(page.url()).search, "", "the label's settings leave the address bar");
  await context.close();
});

test("a made-up code reveals nothing", async () => {
  const context = await contextFor(staff);
  const page = await context.newPage();
  await page.goto(`${appOrigin}/q/ZZZZZZ`);
  await page.getByText("This label isn't available to you").waitFor({ timeout: 60_000 });
  await context.close();
});

test("scanning while signed out signs in, then comes back to the item", async () => {
  const context = await contextFor(null);
  const page = await context.newPage();
  await page.goto(`${appOrigin}/q/${codes["Greens mower 1"]}`);
  await page.waitForURL(`${appOrigin}/login`, { timeout: 60_000 });
  // Signing in sets the session; the app then leaves /login for the label.
  await signIn(context, staff);
  await page.goto(`${appOrigin}/login`);
  await page.waitForURL(`${appOrigin}/q/${codes["Greens mower 1"]}`, { timeout: 60_000 });
  await page.getByRole("heading", { name: "Greens mower 1" }).waitFor();
  // Only once: the next sign-in goes to the dashboard as usual.
  await page.goto(`${appOrigin}/login`);
  await page.waitForURL(`${appOrigin}/dashboard`, { timeout: 60_000 });
  await context.close();
});
