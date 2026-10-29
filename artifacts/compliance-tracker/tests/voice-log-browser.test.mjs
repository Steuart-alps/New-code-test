import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { chromium } from "@playwright/test";

// Browser regression for "Say it" voice logging (src/components/say-it-button.tsx,
// src/components/voice-log-dialog.tsx, src/lib/voice-log.ts). The browser's
// speech recognition is replaced by a fake the test speaks into, and the API
// by a fixture that records what is posted.
//   - one spoken reading becomes a card (track, item, reading, pass/fail);
//     nothing is saved until Save is tapped;
//   - fridge/freezer readings go to /food-safety/cold-reading, core
//     temperatures to /food-safety/append, alarm tests to /fire-safety and
//     outlet temperatures to /legionella, each with the words heard;
//   - a failed kitchen reading needs the action taken; an alarm test needs
//     Pass or Fail tapped; several matching outlets are shown to tap;
//   - a refused save says why and keeps the card; viewers never see the button;
//   - on any track page a spoken problem becomes an action on that track
//     (POST /track-actions), or opens a filled-in FixTrack report;
//   - words Safari heard but never finalised are kept when listening stops;
//   - on a track page, what was said opens that track's own form filled in
//     (pool test, GreenTrack machine), going to the track's page if needed.
// VOICE_LOG_SCREENSHOTS=<dir> saves screenshots.
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
const screenshotDir = process.env.VOICE_LOG_SCREENSHOTS;
if (screenshotDir) mkdirSync(screenshotDir, { recursive: true });
const shot = async (page, name) => { if (screenshotDir) await page.screenshot({ path: `${screenshotDir}/${name}.png`, fullPage: true }); };

// Stands in for Chrome's webkitSpeechRecognition (see dictation-browser.test.mjs).
function installFakeRecognition() {
  window.__recognisers = [];
  class FakeRecognition {
    constructor() { this.lang = ""; this.continuous = false; this.interimResults = false; this.active = false; this.results = []; window.__recognisers.push(this); }
    start() { if (this.active) throw new Error("already started"); this.active = true; }
    stop() { if (!this.active) return; this.active = false; setTimeout(() => this.onend?.(), 0); }
    abort() { this.stop(); }
  }
  window.SpeechRecognition = FakeRecognition;
  window.webkitSpeechRecognition = FakeRecognition;
  window.__listeningCount = () => window.__recognisers.filter(r => r.active).length;
  window.__speak = (text) => {
    const recogniser = window.__recognisers.filter(r => r.active).at(-1);
    if (!recogniser) throw new Error("nothing is listening");
    recogniser.results.push(Object.assign([{ transcript: text }], { isFinal: true }));
    recogniser.onresult?.({ resultIndex: recogniser.results.length - 1, results: recogniser.results });
  };
  // Safari can stop listening without ever marking the words final.
  window.__speakInterim = (text) => {
    const recogniser = window.__recognisers.filter(r => r.active).at(-1);
    if (!recogniser) throw new Error("nothing is listening");
    recogniser.results.push(Object.assign([{ transcript: text }], { isFinal: false }));
    recogniser.onresult?.({ resultIndex: recogniser.results.length - 1, results: recogniser.results });
  };
}

const json = (route, data, code = 200) => route.fulfill({ status: code, contentType: "application/json", body: JSON.stringify(data) });
const SITES = [{ id: 1, name: "Harbour Hotel" }, { id: 2, name: "Lakeside Lodge" }];
const KITCHEN_RULES = {
  fridge: { min: 0, max: 5 }, freezer: { min: null, max: -18 }, chilledDelivery: { min: null, max: 8 }, frozenDelivery: { min: null, max: -15 },
  cooking: { min: 75, max: null }, cooling: { min: null, max: 8 }, reheating: { min: 82, max: null }, hotHolding: { min: 63, max: null },
  sousVide: { min: 75, max: null }, coolingMinutes: 90, cookingHoldSeconds: null, sousVideHoldMinutes: null, items: { cooking: [], sousVide: [] },
};

function apiFixture({ role = "client_staff", coldReadingRefusal = null, services = ["kitchentrack", "firetrack", "legionellatrack"] } = {}) {
  const posts = [];
  const handler = async (route) => {
    const request = route.request(), url = new URL(request.url()), method = request.method(), path = url.pathname;
    if (method === "GET") {
      switch (path) {
        case "/api/auth/csrf-token": return json(route, { token: "voice-csrf" });
        case "/api/auth/me": return json(route, {
          user: { id: 7, email: "chef@example.test", name: "Sam Chef", role, clientId: 23, departmentId: null, active: true, totpEnabled: true },
          billingLocked: false, client: { id: 23, name: "Harbour Hotel Group", slug: "harbour", logoUrl: null, primaryColor: "#2F7C8C", active: true },
          services,
        });
        case "/api/sites": return json(route, SITES);
        case "/api/food-safety/config":
          assert.equal(url.searchParams.get("siteId"), "1");
          return json(route, {
            food_cold_units: JSON.stringify([{ name: "Fridge 1", type: "fridge" }, { name: "Fridge 2", type: "fridge" }, { name: "Freezer 1", type: "freezer" }]),
            food_default_hot_items: JSON.stringify(["Chicken breast"]), food_default_holding_items: "[]",
            food_temperature_rules: JSON.stringify(KITCHEN_RULES),
          });
        case "/api/fire-safety/call-points":
          assert.equal(url.searchParams.get("siteId"), "1");
          return json(route, [
            { id: 11, siteId: 1, name: "CP1 – Reception", archivedAt: null, lastTestedDate: null },
            { id: 12, siteId: 1, name: "CP2 – Kitchen", archivedAt: null, lastTestedDate: null },
            { id: 13, siteId: 1, name: "CP3 – Old wing", archivedAt: "2026-09-01T09:00:00.000Z", lastTestedDate: null },
          ]);
        case "/api/legionella/outlet-status": return json(route, [
          { id: 31, siteId: 1, name: "Ladies toilet basin", location: "Ground floor", type: "hot", checkTypeForOutlet: "hot_sentinel_temp" },
          { id: 32, siteId: 1, name: "Ladies toilet basin", location: "Ground floor", type: "cold", checkTypeForOutlet: "cold_sentinel_temp" },
          { id: 33, siteId: 2, name: "Ladies toilet basin", location: "Lodge", type: "hot", checkTypeForOutlet: "hot_sentinel_temp" },
        ]);
        case "/api/legionella/config": return json(route, {
          effectiveTemperatureLimits: { hot_sentinel_temp: { min: 50 }, cold_sentinel_temp: { max: 20 }, calorifier_temp: { min: 60 } },
        });
        default: return json(route, []);
      }
    }
    const body = request.postDataJSON();
    // The web app adds the business (clientId) to every request.
    url.searchParams.delete("clientId");
    posts.push({ path: `${path}${url.search}`, body });
    if (path === "/api/food-safety/cold-reading" && coldReadingRefusal) return json(route, coldReadingRefusal, 409);
    return json(route, { id: posts.length }, 201);
  };
  return { posts, handler };
}

const speak = (page, text) => page.evaluate(t => window.__speak(t), text);

async function openSayIt(page) {
  await page.getByTestId("say-it-button").click();
  const dialog = page.getByTestId("voice-log-dialog");
  await dialog.waitFor();
  // Two sites: the site is chosen first.
  assert.equal(await dialog.getByTestId("voice-log-mic").isDisabled(), true, "choose the site before speaking");
  await dialog.locator("#voice-log-site").click();
  await page.getByRole("option", { name: "Harbour Hotel" }).click();
  return dialog;
}

async function sayAndWaitForCard(page, dialog, text) {
  await dialog.getByTestId("voice-log-mic").click();
  await page.waitForFunction(() => window.__listeningCount() === 1);
  await speak(page, text);
  await page.waitForFunction(() => window.__listeningCount() === 0);
  // The recogniser stops at once; React shows the words on its next render.
  await page.waitForFunction(t => document.getElementById("voice-log-heard")?.value === t, text, { timeout: 5000 })
    .catch(async () => assert.equal(await dialog.locator("#voice-log-heard").inputValue(), text));
}

async function checkSayIt() {
  const context = await browser.newContext({ locale: "en-GB", viewport: { width: 390, height: 844 } });
  const api = apiFixture();
  await context.route("**/api/**", api.handler);
  await context.addInitScript(installFakeRecognition);
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.goto(`${baseUrl}/tests/voice-log-harness.html`, { waitUntil: "domcontentloaded" });
  const dialog = await openSayIt(page);
  const save = dialog.getByTestId("voice-log-save");
  const card = dialog.getByTestId("voice-log-card");

  // KitchenTrack fridge reading.
  await sayAndWaitForCard(page, dialog, "fridge one is showing four degrees");
  await card.getByText("KitchenTrack · fridge and freezer reading").waitFor();
  assert.equal(await card.getByTestId("voice-log-item").textContent(), "Fridge 1");
  assert.equal(await card.getByTestId("voice-log-temperature").inputValue(), "4");
  assert.match(await card.getByTestId("voice-log-result").textContent(), /Pass · limit ≥ 0°C and ≤ 5°C/);
  await shot(page, "1-fridge-card");
  assert.equal(api.posts.length, 0, "nothing is saved from voice alone");
  await save.click();
  await dialog.getByTestId("voice-log-saved").getByText("KitchenTrack: Fridge 1").waitFor();
  const fridge = api.posts.at(-1);
  assert.equal(fridge.path, "/api/food-safety/cold-reading?siteId=1");
  assert.equal(fridge.body.unit, "Fridge 1");
  assert.equal(fridge.body.temperature, 4);
  assert.ok(["am", "pm"].includes(fridge.body.slot));
  assert.equal(fridge.body.spoken, "fridge one is showing four degrees");
  assert.equal(fridge.body.recordedAt.slice(0, 10), fridge.body.recordDate, "the reading time is on the diary day");
  assert.equal(await dialog.locator("#voice-log-heard").inputValue(), "", "ready for the next reading");

  // A failed freezer reading needs the action taken.
  await sayAndWaitForCard(page, dialog, "freezer one is minus ten in the afternoon");
  assert.match(await card.getByTestId("voice-log-result").textContent(), /Fail · limit ≤ -18°C/);
  assert.equal(await save.isDisabled(), true);
  assert.match(await dialog.getByTestId("voice-log-missing").textContent(), /action was taken/);
  await card.locator("#voice-log-action").fill("Moved stock to freezer 2 and called the engineer");
  await shot(page, "2-freezer-fail");
  await save.click();
  await dialog.getByTestId("voice-log-saved").getByText("KitchenTrack: Freezer 1 PM -10°C (fail)").waitFor();
  assert.deepEqual(
    [api.posts.at(-1).body.slot, api.posts.at(-1).body.temperature, api.posts.at(-1).body.correctiveAction],
    ["pm", -10, "Moved stock to freezer 2 and called the engineer"],
  );

  // KitchenTrack core temperature.
  await sayAndWaitForCard(page, dialog, "chicken core temp 78");
  await card.getByText("KitchenTrack · cooking").waitFor();
  assert.equal(await card.locator("#voice-log-item").inputValue(), "Chicken");
  assert.match(await card.getByTestId("voice-log-result").textContent(), /Pass · limit ≥ 75°C/);
  await save.click();
  await dialog.getByTestId("voice-log-saved").getByText("KitchenTrack cooking: Chicken 78°C (pass)").waitFor();
  const core = api.posts.at(-1);
  assert.equal(core.path, "/api/food-safety/append?siteId=1");
  assert.equal(core.body.section, "hotTemperature");
  assert.deepEqual([core.body.row.item, core.body.row.coreTemp, core.body.spoken], ["Chicken", "78", "chicken core temp 78"]);
  assert.match(core.body.row.timeFinish, /^\d\d:\d\d$/);
  assert.match(core.body.entryId, /^voice-[0-9a-f-]{36}$/);

  // FireTrack: the call point is matched, Pass or Fail must be tapped.
  await sayAndWaitForCard(page, dialog, "testing call point 1");
  await card.getByText("FireTrack · weekly alarm test").waitFor();
  assert.equal(await card.getByTestId("voice-log-item").textContent(), "CP1 – Reception");
  assert.equal(await save.isDisabled(), true, "pass or fail is never assumed");
  await card.getByTestId("voice-log-pass").click();
  await shot(page, "3-call-point");
  await save.click();
  await dialog.getByTestId("voice-log-saved").getByText("FireTrack: alarm test at CP1 – Reception (pass)").waitFor();
  const alarm = api.posts.at(-1);
  assert.equal(alarm.path, "/api/fire-safety");
  assert.deepEqual([alarm.body.checkType, alarm.body.callPointId, alarm.body.result, alarm.body.siteId, alarm.body.performedBy],
    ["alarm", 11, "pass", 1, "Sam Chef"]);
  assert.equal(alarm.body.notes, 'Logged by voice: "testing call point 1"');

  // Legionella: hot tap matched to the hot outlet at this site.
  await sayAndWaitForCard(page, dialog, "hot tap, ladies toilet, 55 degrees");
  await card.getByText("Legionella · outlet temperature").waitFor();
  assert.equal(await card.getByTestId("voice-log-item").textContent(), "Ladies toilet basin — Ground floor (hot)");
  assert.match(await card.getByTestId("voice-log-result").textContent(), /Pass · limit 50°C or above/);
  await save.click();
  await dialog.getByTestId("voice-log-saved").getByText("Legionella: Ladies toilet basin 55°C (pass)").waitFor();
  const water = api.posts.at(-1);
  assert.equal(water.path, "/api/legionella");
  assert.deepEqual([water.body.checkType, water.body.outletId, water.body.temperature, water.body.result, water.body.siteId],
    ["hot_sentinel_temp", 31, 55, "pass", 1]);
  assert.equal(water.body.location, "Ladies toilet basin — Ground floor");

  // Hot or cold not said: both outlets are offered to tap.
  await sayAndWaitForCard(page, dialog, "ladies toilet tap 30 degrees");
  const choices = card.getByTestId("voice-log-choices");
  await choices.waitFor();
  assert.equal(await save.isDisabled(), true);
  await choices.getByRole("button", { name: "Ladies toilet basin — Ground floor (hot)" }).click();
  assert.match(await card.getByTestId("voice-log-result").textContent(), /Fail · limit 50°C or above/);
  await shot(page, "4-outlet-choice");
  await save.click();
  await dialog.getByTestId("voice-log-saved").getByText("Legionella: Ladies toilet basin 30°C (fail)").waitFor();
  assert.equal(api.posts.at(-1).body.result, "fail");

  // A phrase nobody can place.
  await dialog.locator("#voice-log-heard").fill("the weather is lovely");
  await dialog.getByTestId("voice-log-unknown").getByText("couldn't tell which check").waitFor();
  assert.equal(await save.isDisabled(), true);

  assert.equal(api.posts.length, 6);
  assert.deepEqual(pageErrors, []);
  await context.close();
}

async function checkRefusedSave() {
  const context = await browser.newContext({ locale: "en-GB" });
  const api = apiFixture({ coldReadingRefusal: { error: "Fridge 1 already has an AM reading of 4°C today.", code: "READING_ALREADY_RECORDED" } });
  await context.route("**/api/**", api.handler);
  await context.addInitScript(installFakeRecognition);
  const page = await context.newPage();
  await page.goto(`${baseUrl}/tests/voice-log-harness.html`, { waitUntil: "domcontentloaded" });
  const dialog = await openSayIt(page);
  await sayAndWaitForCard(page, dialog, "fridge 1 is 6 degrees this morning");
  await dialog.locator("#voice-log-action").fill("Door was left open; closed it");
  await dialog.getByTestId("voice-log-save").click();
  await page.getByText("Fridge 1 already has an AM reading of 4°C today.", { exact: true }).waitFor();
  assert.equal(await dialog.locator("#voice-log-heard").inputValue(), "fridge 1 is 6 degrees this morning", "the card stays to fix");
  assert.equal(await dialog.getByTestId("voice-log-saved").count(), 0);
  await context.close();
}

async function checkActions() {
  const context = await browser.newContext({ locale: "en-GB", viewport: { width: 390, height: 844 } });
  const api = apiFixture({ services: ["kitchentrack", "firetrack", "legionellatrack", "aquatrack", "fixtrack"] });
  await context.route("**/api/**", api.handler);
  await context.addInitScript(installFakeRecognition);
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.goto(`${baseUrl}/tests/voice-log-harness.html`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("say-it-button").waitFor();
  // As if on AquaTrack's page.
  await page.evaluate(() => window.history.replaceState(null, "", "/aqua-track"));
  const dialog = await openSayIt(page);
  await dialog.getByText("pool gate latch is broken, urgent", { exact: false }).waitFor();
  const save = dialog.getByTestId("voice-log-save");
  const card = dialog.getByTestId("voice-log-card");

  // A spoken problem becomes an action on the page's track.
  await sayAndWaitForCard(page, dialog, "the gate latch on the pool fence is broken, urgent");
  await card.getByText("AquaTrack (water tests) · action to follow up").waitFor();
  assert.equal(await card.locator("#voice-log-action-title").inputValue(), "The gate latch on the pool fence is broken");
  assert.equal(await card.getByTestId("voice-log-severity-urgent").getAttribute("aria-pressed"), "true");
  await shot(page, "5-pool-action");
  assert.equal(api.posts.length, 0, "nothing is saved from voice alone");
  await save.click();
  await dialog.getByTestId("voice-log-saved").getByText("AquaTrack (water tests) action: The gate latch on the pool fence is broken (urgent)").waitFor();
  assert.deepEqual(api.posts.at(-1), {
    path: "/api/track-actions",
    body: {
      module: "pool", title: "The gate latch on the pool fence is broken", severity: "urgent", siteId: 1,
      instruction: 'Raised by voice: "the gate latch on the pool fence is broken, urgent"',
    },
  });

  // Readings still work on any page, and can be turned into an action.
  await sayAndWaitForCard(page, dialog, "fridge 2 is 4 degrees");
  await card.getByText("KitchenTrack · fridge and freezer reading").waitFor();
  await card.getByTestId("voice-log-raise-action").click();
  await card.getByText("AquaTrack (water tests) · action to follow up").waitFor();
  await card.getByTestId("voice-log-severity-monitor").click();
  await card.locator("#voice-log-action-track").click();
  await page.getByRole("option", { name: "FireTrack" }).click();
  await card.locator("#voice-log-action-title").fill("Fridge 2 runs warm in the afternoon");
  await save.click();
  await dialog.getByTestId("voice-log-saved").getByText("FireTrack action: Fridge 2 runs warm in the afternoon (monitor)").waitFor();
  assert.deepEqual([api.posts.at(-1).body.module, api.posts.at(-1).body.severity], ["fire", "monitor"]);

  // Words Safari never finalised are kept when listening is stopped.
  await dialog.getByTestId("voice-log-mic").click();
  await page.waitForFunction(() => window.__listeningCount() === 1);
  await page.evaluate(() => window.__speakInterim("the weather is lovely"));
  await dialog.getByTestId("voice-log-mic").click();
  await page.waitForFunction(() => document.getElementById("voice-log-heard")?.value === "the weather is lovely");

  // Not a reading and not a problem: the person chooses.
  await dialog.getByTestId("voice-log-unknown").waitFor();
  assert.equal(await save.isDisabled(), true);
  await dialog.getByTestId("voice-log-raise-action").waitFor();
  await dialog.getByTestId("voice-log-fixtrack").click();
  await dialog.waitFor({ state: "detached" });
  assert.equal(new URL(page.url()).pathname, "/fix-track");
  assert.deepEqual(Object.fromEntries(new URL(page.url()).searchParams), { report: "1", title: "The weather is lovely", siteId: "1" });

  assert.equal(api.posts.length, 2);
  assert.deepEqual(pageErrors, []);
  await context.close();
}

async function checkForms() {
  const context = await browser.newContext({ locale: "en-GB", viewport: { width: 390, height: 844 } });
  const api = apiFixture({ services: ["kitchentrack", "aquatrack", "greentrack", "fixtrack"] });
  await context.route("**/api/**", api.handler);
  await context.addInitScript(installFakeRecognition);
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.goto(`${baseUrl}/tests/voice-log-harness.html`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("say-it-button").waitFor();
  const filled = async () => JSON.parse(await page.getByTestId("say-it-fill").textContent());

  // On AquaTrack, readings open AquaTrack's water test form filled in.
  await page.evaluate(() => window.history.replaceState(null, "", "/aqua-track"));
  let dialog = await openSayIt(page);
  await sayAndWaitForCard(page, dialog, "pH 7.4, free chlorine 1.5, combined 0.2, water 29 degrees");
  const card = dialog.getByTestId("voice-log-card");
  await card.getByText("AquaTrack (water tests) · water test").waitFor();
  const fields = await card.getByTestId("voice-log-form-fields").textContent();
  for (const field of ["7.4", "1.5", "0.2", "29"]) assert.ok(fields.includes(field), `${field} in ${fields}`);
  await shot(page, "6-pool-test-form");
  const save = dialog.getByTestId("voice-log-save");
  assert.equal(await save.textContent(), "Fill in the form");
  await save.click();
  await dialog.waitFor({ state: "detached" });
  assert.equal(new URL(page.url()).pathname, "/aqua-track", "already on the page");
  assert.deepEqual(await filled(), {
    form: "pool-test", values: { ph: 7.4, combinedChlorine: 0.2, freeChlorine: 1.5, waterTemp: 29 }, siteId: 1,
    text: "pH 7.4, free chlorine 1.5, combined 0.2, water 29 degrees",
  });

  // From a page with no track, the words choose the track and Say it goes there.
  await page.evaluate(() => window.history.replaceState(null, "", "/tests/voice-log-harness.html"));
  dialog = await openSayIt(page);
  await sayAndWaitForCard(page, dialog, "greens mower 2 filled 20 litres of diesel");
  await dialog.getByTestId("voice-log-card").getByText("GreenTrack · fuel log").waitFor();
  await dialog.getByTestId("voice-log-save").click();
  await dialog.waitFor({ state: "detached" });
  assert.equal(new URL(page.url()).pathname, "/green-track");
  assert.deepEqual(await filled(), {
    form: "machine", item: "greens mower 2", values: { intent: "fuel", litres: 20 }, siteId: 1,
    text: "greens mower 2 filled 20 litres of diesel",
  });

  assert.equal(api.posts.length, 0, "the track's own form saves, not Say it");
  assert.deepEqual(pageErrors, []);
  await context.close();
}

async function checkViewer() {
  const context = await browser.newContext({ locale: "en-GB" });
  const api = apiFixture({ role: "client_viewer" });
  await context.route("**/api/**", api.handler);
  const page = await context.newPage();
  await page.goto(`${baseUrl}/tests/voice-log-harness.html`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Dashboard" }).waitFor();
  await page.waitForTimeout(500);
  assert.equal(await page.getByTestId("say-it-button").count(), 0, "viewers are read-only");
  await context.close();
}

try {
  await waitForVite();
  browser = await chromium.launch({ executablePath: chromiumPath() });
  await checkSayIt();
  await checkRefusedSave();
  await checkActions();
  await checkForms();
  await checkViewer();
  console.log("voice-log browser tests passed");
} finally {
  await browser?.close();
  vite.kill();
}
