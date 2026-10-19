import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { chromium } from "@playwright/test";
import { parseKitchenTemperatureRules } from "../../../lib/api-zod/src/kitchen-temperature.ts";

// Browser regression for the country guidance in Numeric temperature controls
// (src/components/kitchen-temperature-controls.tsx):
//   - the scope's saved country is shown with its source; UK guidance carries
//     no "starting point" warning, other countries do;
//   - choosing a country fills in its values, which stay editable, and saving
//     stores the country with the edited rules;
//   - saving a site's rules without changing the country does not pin the
//     site to the organisation's country;
//   - "Reset to <country> values" puts the preset back after edits.
// The /api/food-safety/config fixture mirrors GET/PUT in
// artifacts/api-server/src/routes/food-safety.ts for these two keys.
const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const freePort = async () => {
  const server = createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
};
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
const vite = spawn("pnpm", ["exec", "vite", "--config", "vite.config.ts", "--host", "127.0.0.1"], {
  cwd: root,
  env: { ...process.env, PORT: String(port), BASE_PATH: "/", NODE_ENV: "test" },
  stdio: ["ignore", "ignore", "pipe"],
});
let viteError = "";
vite.stderr.on("data", chunk => { viteError += chunk.toString(); });
let browser;

async function waitForVite() {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (vite.exitCode !== null) throw new Error(`Vite exited: ${viteError}`);
    try { if ((await fetch(baseUrl)).ok) return; } catch { /* still starting */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Vite did not start: ${viteError}`);
}
const chromiumPath = () => process.env.CHROMIUM_PATH
  ?? ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome"].find(path => existsSync(path));

const CLIENT_ID = 23;
const SITE = { id: 7, name: "Harbour Kitchen" };
// Saved values per scope (null = organisation), as app_settings holds them.
const stored = new Map([[null, {}], [SITE.id, {}]]);
const puts = [];
const unexpectedRequests = [];
const configFor = (siteId) => {
  const org = stored.get(null), site = siteId == null ? {} : stored.get(siteId);
  const jurisdiction = site.food_jurisdiction ?? org.food_jurisdiction ?? "england_wales";
  const rules = site.food_temperature_rules ?? org.food_temperature_rules ?? JSON.stringify(parseKitchenTemperatureRules(null, jurisdiction));
  return { food_jurisdiction: jurisdiction, food_temperature_rules: rules, ...(siteId == null ? {} : { _siteOverrides: Object.keys(site) }) };
};

const json = (route, data, code = 200) => route.fulfill({ status: code, contentType: "application/json", body: JSON.stringify(data) });
async function routeApi(route) {
  const request = route.request(), url = new URL(request.url()), method = request.method();
  const path = url.pathname;
  const siteParam = url.searchParams.get("siteId");
  const siteId = siteParam ? Number(siteParam) : null;
  if (method === "GET") {
    switch (path) {
      case "/api/auth/csrf-token": return json(route, { token: "kitchen-country-csrf" });
      case "/api/auth/me": return json(route, {
        user: { id: 7, email: "chef@example.test", name: "Head Chef", role: "client_admin", clientId: CLIENT_ID, departmentId: null, active: true, totpEnabled: true },
        billingLocked: false, client: { id: CLIENT_ID, name: "Harbour Hotel Group", slug: "harbour", logoUrl: null, primaryColor: "#2F7C8C", active: true },
        services: ["kitchentrack"],
      });
      case "/api/billing/cancellation-status": return json(route, { accessEndsAt: null });
      case "/api/managed-by": return json(route, null);
      case "/api/sites": return json(route, [SITE]);
      case "/api/food-safety/config": return json(route, configFor(siteId));
    }
  }
  if (method === "PUT" && path === "/api/food-safety/config") {
    const body = JSON.parse(request.postData() ?? "{}");
    puts.push({ siteId, body });
    const scope = stored.get(siteId);
    for (const [key, value] of Object.entries(body)) {
      if (value === null) delete scope[key]; else scope[key] = value;
    }
    return json(route, { ok: true });
  }
  if (method === "POST" && path === "/api/analytics/events") return route.fulfill({ status: 204 });
  unexpectedRequests.push(`${method} ${path}`);
  return method === "GET" ? json(route, []) : json(route, { error: "Not in the fixture" }, 404);
}

const country = page => page.getByLabel("Country guidance");
const bound = (page, label, which) => page.getByLabel(`${label} ${which} °C`);
const note = page => page.getByTestId("kitchen-guidance-note");
const coolingMinutes = page => page.getByLabel("Maximum cooling duration (minutes)");
const save = page => page.getByRole("button", { name: "Save numeric rules" });
async function expectValue(locator, expected, message) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await locator.inputValue() === expected) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(await locator.inputValue(), expected, message);
}

const checks = [];
try {
  await waitForVite();
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"], executablePath: chromiumPath() });
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, locale: "en-GB" });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.route("**/api/**", routeApi);
  await page.goto(`${baseUrl}/tests/kitchen-country-guidance-harness.html`, { waitUntil: "domcontentloaded" });
  await page.getByText("Numeric temperature controls").click();

  // ── The saved UK country, with its source and no warning ──
  await expectValue(country(page), "england_wales", "organisation starts on England/Wales");
  await expectValue(bound(page, "Reheating", "min"), "75");
  assert.match(await note(page).innerText(), /Food Standards Agency/);
  assert.doesNotMatch(await note(page).innerText(), /Starting point only/);
  checks.push("UK: saved country shown with its source, no starting-point warning");

  // ── Choosing Ireland fills in its values, flagged as a starting point ──
  await country(page).selectOption("ireland");
  await expectValue(bound(page, "Reheating", "min"), "70");
  await expectValue(bound(page, "Cooling", "max"), "10");
  await expectValue(bound(page, "Chilled deliveries", "max"), "5");
  await expectValue(coolingMinutes(page), "150");
  assert.match(await note(page).innerText(), /Starting point only/);
  assert.match(await note(page).locator("a").getAttribute("href"), /^https:\/\/www\.fsai\.ie\//);
  checks.push("Ireland: choosing it fills in its values and shows the warning and FSAI source");

  // ── Values stay editable; saving stores the country with the edits ──
  await bound(page, "Hot holding", "min").fill("65");
  await save(page).click();
  for (let attempt = 0; attempt < 100 && puts.length === 0; attempt++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(puts.length, 1, "one save");
  assert.equal(puts[0].siteId, null);
  assert.equal(puts[0].body.food_jurisdiction, "ireland");
  const savedRules = JSON.parse(puts[0].body.food_temperature_rules);
  assert.equal(savedRules.hotHolding.min, 65);
  assert.equal(savedRules.reheating.min, 70);
  assert.equal(savedRules.coolingMinutes, 150);
  await expectValue(country(page), "ireland");
  await expectValue(bound(page, "Hot holding", "min"), "65");
  assert.equal(await save(page).isDisabled(), true, "nothing left to save");
  checks.push("save: the organisation stores Ireland with the edited hot-holding limit");

  // ── A site inherits the country; saving its rules does not pin it ──
  await page.getByLabel("Rules for").selectOption(String(SITE.id));
  await expectValue(country(page), "ireland", "site inherits Ireland");
  await expectValue(bound(page, "Hot holding", "min"), "65");
  await bound(page, "Hot holding", "min").fill("66");
  await save(page).click();
  for (let attempt = 0; attempt < 100 && puts.length === 1; attempt++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(puts[1].siteId, SITE.id);
  assert.equal(Object.hasOwn(puts[1].body, "food_jurisdiction"), false, "site save leaves the country inherited");
  checks.push("site: saving rules without changing the country keeps it inherited");

  // ── Reset puts a country's preset back after edits ──
  await country(page).selectOption("united_states");
  await expectValue(bound(page, "Hot holding", "min"), "57");
  await bound(page, "Hot holding", "min").fill("58");
  await page.getByRole("button", { name: "Reset to United States values" }).click();
  await expectValue(bound(page, "Hot holding", "min"), "57");
  await expectValue(bound(page, "Cooking", "min"), "74");
  assert.match(await note(page).innerText(), /°F/);
  checks.push("reset: United States values come back after an edit");

  assert.deepEqual(pageErrors, [], "no page errors");
  assert.deepEqual(unexpectedRequests.filter(entry => !entry.startsWith("GET ")), [], "no writes outside the fixture");
  for (const check of checks) console.log(`ok - ${check}`);
  console.log(`KitchenTrack country guidance browser tests passed (${checks.length} checks).`);
} catch (error) {
  for (const check of checks) console.log(`ok - ${check}`);
  console.error(error);
  if (unexpectedRequests.length) console.error("Unexpected requests:", unexpectedRequests);
  process.exitCode = 1;
} finally {
  await browser?.close();
  vite.kill("SIGTERM");
}
