import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { chromium } from "@playwright/test";

// Browser regression for unsaved KitchenTrack diary edits (DailyDiaryTab in
// src/pages/kitchen.tsx):
//   - a date change or an organisation-to-site switch with unsaved edits asks
//     to discard them; "Keep editing" keeps the day, site and values;
//   - a clean form switches without asking;
//   - a refetch that brings a newer server version (another device created or
//     changed the day) never overwrites unsaved edits, and the save is checked
//     against the version the edits were made on;
//   - a clean form shows the newer version, and a saved form is clean again.
// The /api/food-safety fixture is stateful and mirrors
// artifacts/api-server/src/routes/food-safety.ts.
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

const localDate = (offsetDays = 0) => {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};
const TODAY = localDate(0);
const YESTERDAY = localDate(-1);
const TWO_DAYS_AGO = localDate(-2);
const CLIENT_ID = 23;
const SITE = { id: 7, name: "Harbour Kitchen" };

// ─── Stateful /api/food-safety fixture ───────────────────────────────────────

const configFor = siteId => ({
  food_jurisdiction: "england_wales",
  food_reheating_limit: "Above 75°C",
  food_cold_units: JSON.stringify([{ name: siteId == null ? "Org Fridge" : "Site Fridge", type: "fridge" }]),
  food_default_hot_items: "[]",
  food_default_holding_items: "[]",
  food_default_sv_items: "[]",
});
/** Diary records keyed by "<siteId|all>:<date>". */
const records = new Map();
let nextId = 100;
let clock = Date.parse("2026-10-15T09:00:00Z");
const stamp = () => new Date(clock += 60_000).toISOString();
const scopeKey = (siteId, date) => `${siteId ?? "all"}:${date}`;
const posts = [];
const puts = [];
const unexpectedRequests = [];

/** Another device creates or changes a diary day. */
function serverWrite(siteId, date, fields) {
  const key = scopeKey(siteId, date);
  const current = records.get(key);
  const record = {
    deliveries: [], coldFood: [], hotTemperature: [], cooling: [], reheating: [], hotHolding: [], sousVide: [],
    correctives: null, managerSignature: null, submittedAt: null, reheatingLimit: "Above 75°C",
    ...current,
    ...fields,
    id: current?.id ?? nextId++,
    clientId: CLIENT_ID,
    siteId,
    recordDate: date,
    updatedAt: stamp(),
  };
  records.set(key, record);
  return record;
}

const json = (route, data, code = 200) => route.fulfill({ status: code, contentType: "application/json", body: JSON.stringify(data) });
async function routeApi(route) {
  const request = route.request(), url = new URL(request.url()), method = request.method();
  const path = url.pathname;
  const siteParam = url.searchParams.get("siteId");
  const siteId = siteParam ? Number(siteParam) : null;
  if (method === "GET") {
    switch (path) {
      case "/api/auth/csrf-token": return json(route, { token: "kitchen-diary-csrf" });
      case "/api/auth/me": return json(route, {
        user: { id: 7, email: "chef@example.test", name: "Head Chef", role: "client_admin", clientId: CLIENT_ID, departmentId: null, active: true, totpEnabled: true },
        billingLocked: false, client: { id: CLIENT_ID, name: "Harbour Hotel Group", slug: "harbour", logoUrl: null, primaryColor: "#2F7C8C", active: true },
        services: ["kitchentrack"],
      });
      case "/api/billing/cancellation-status": return json(route, { accessEndsAt: null });
      case "/api/managed-by": return json(route, null);
      case "/api/sites": return json(route, [SITE]);
      case "/api/food-safety/config": return json(route, configFor(siteId));
      case "/api/food-safety": return json(route, [...records.values()].filter(r => r.siteId === siteId));
      case "/api/food-safety/summary": return json(route, { days: [] });
    }
    const byDate = path.match(/^\/api\/food-safety\/by-date\/(\d{4}-\d{2}-\d{2})$/);
    if (byDate) {
      const record = records.get(scopeKey(siteId, byDate[1]));
      return record ? json(route, record) : json(route, { error: "No record for this date" }, 404);
    }
    if (path.startsWith("/api/photos") || path.startsWith("/api/kitchen")) return json(route, []);
  }
  if (method === "POST" && path === "/api/food-safety") {
    const body = JSON.parse(request.postData() ?? "{}");
    posts.push({ siteId, body });
    const existing = records.get(scopeKey(siteId, body.recordDate));
    if (existing) return json(route, { error: "Record already exists for this date", id: existing.id }, 409);
    const { recordDate, ...fields } = body;
    return json(route, serverWrite(siteId, recordDate, fields), 201);
  }
  const put = path.match(/^\/api\/food-safety\/(\d+)$/);
  if (method === "PUT" && put) {
    const body = JSON.parse(request.postData() ?? "{}");
    puts.push(body);
    const current = [...records.values()].find(r => r.id === Number(put[1]));
    if (!current) return json(route, { error: "Not found" }, 404);
    // The real route merges identifiable mobile appends and otherwise refuses
    // a save made against an older version.
    if (body.expectedUpdatedAt && body.expectedUpdatedAt !== current.updatedAt) {
      return json(route, { error: "Diary changed", record: current }, 409);
    }
    const { expectedUpdatedAt, expectedRecord, recordDate, ...fields } = body;
    return json(route, serverWrite(current.siteId, current.recordDate, fields));
  }
  if (method === "POST" && path === "/api/analytics/events") return route.fulfill({ status: 204 });
  unexpectedRequests.push(`${method} ${path}`);
  return method === "GET" ? json(route, []) : json(route, { error: "Not in the kitchen diary fixture" }, 404);
}

function captureToasts() {
  window.__toasts = [];
  const seen = new WeakSet();
  new MutationObserver(() => {
    for (const toast of document.querySelectorAll("[role='region'] ol > li")) {
      if (seen.has(toast)) continue;
      seen.add(toast);
      window.__toasts.push(toast.textContent.replace(/\s+/g, " ").trim());
    }
  }).observe(document, { childList: true, subtree: true });
}

// ─── Page helpers ────────────────────────────────────────────────────────────

const correctivesBox = page => page.getByPlaceholder(/Fridge 2 running warm/);
const dateInput = page => page.locator("input[type='date']");
const siteSelect = page => page.locator("select").filter({ has: page.locator("option", { hasText: "Organisation diary" }) });
const discardDialog = page => page.getByRole("alertdialog", { name: "Discard unsaved changes?" });

async function waitForDiary(page, { date, unit, correctives }) {
  await page.waitForFunction(({ date, unit, correctives }) => {
    const input = document.querySelector("input[type='date']");
    const box = [...document.querySelectorAll("textarea")].find(t => /Fridge 2 running warm/.test(t.placeholder));
    const units = [...document.querySelectorAll("input")].map(i => i.value);
    return input?.value === date && box && box.value === correctives && (!unit || units.includes(unit));
  }, { date, unit, correctives });
}
const diaryState = page => page.evaluate(() => ({
  date: document.querySelector("input[type='date']")?.value,
  site: [...document.querySelectorAll("select")].find(s => [...s.options].some(o => o.text === "Organisation diary"))?.value,
  correctives: [...document.querySelectorAll("textarea")].find(t => /Fridge 2 running warm/.test(t.placeholder))?.value,
  units: [...document.querySelectorAll("input")].map(i => i.value),
}));
async function refetchDiary(page) {
  await page.evaluate(() => window.__queryClient.invalidateQueries());
  // Let the refetch land and any hydration effect run.
  await page.waitForTimeout(400);
}
async function expectToast(page, before, title) {
  await page.waitForFunction(count => window.__toasts.length > count, before);
  const toasts = await page.evaluate(() => window.__toasts);
  assert.ok(toasts.slice(before).some(t => t.includes(title)), `expected a "${title}" toast, got ${JSON.stringify(toasts.slice(before))}`);
}
const toastCount = page => page.evaluate(() => window.__toasts.length);

const checks = [];
try {
  await waitForVite();
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"], executablePath: chromiumPath() });
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, locale: "en-GB" });
  await context.addInitScript(captureToasts);
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.route("**/api/**", routeApi);

  await page.goto(`${baseUrl}/tests/kitchen-diary-harness.html`, { waitUntil: "domcontentloaded" });
  await waitForDiary(page, { date: TODAY, unit: "Org Fridge", correctives: "" });

  // ── Date change with unsaved edits: Keep editing, then Discard ──
  await correctivesBox(page).fill("Org fridge door reseated");
  await dateInput(page).fill(YESTERDAY);
  await discardDialog(page).waitFor();
  await discardDialog(page).getByRole("button", { name: "Keep editing" }).click();
  await discardDialog(page).waitFor({ state: "detached" });
  let state = await diaryState(page);
  assert.equal(state.date, TODAY, "Keep editing stays on the same day");
  assert.equal(state.correctives, "Org fridge door reseated", "Keep editing keeps the unsaved value");
  checks.push("date change: Keep editing keeps the day and the edits");

  await dateInput(page).fill(YESTERDAY);
  await discardDialog(page).getByRole("button", { name: "Discard" }).click();
  await discardDialog(page).waitFor({ state: "detached" });
  await waitForDiary(page, { date: YESTERDAY, unit: "Org Fridge", correctives: "" });
  checks.push("date change: Discard loads the chosen day without the old edits");

  // A clean form changes date without asking.
  await dateInput(page).fill(TODAY);
  await waitForDiary(page, { date: TODAY, unit: "Org Fridge", correctives: "" });
  assert.equal(await discardDialog(page).count(), 0, "a clean form switches without a prompt");
  checks.push("date change: a clean form switches straight away");

  // ── Organisation-to-site switch with unsaved edits ──
  await correctivesBox(page).fill("Org probe recalibrated");
  await siteSelect(page).selectOption(String(SITE.id));
  await discardDialog(page).waitFor();
  await discardDialog(page).getByRole("button", { name: "Keep editing" }).click();
  await discardDialog(page).waitFor({ state: "detached" });
  state = await diaryState(page);
  assert.equal(state.site, "", "Keep editing stays on the organisation diary");
  assert.equal(state.correctives, "Org probe recalibrated");
  assert.ok(state.units.includes("Org Fridge"), "the organisation template is still shown");

  await siteSelect(page).selectOption(String(SITE.id));
  await discardDialog(page).getByRole("button", { name: "Discard" }).click();
  await discardDialog(page).waitFor({ state: "detached" });
  await waitForDiary(page, { date: TODAY, unit: "Site Fridge", correctives: "" });
  state = await diaryState(page);
  assert.equal(state.site, String(SITE.id));
  assert.ok(!state.units.includes("Org Fridge"), "the site diary does not carry the organisation's rows");
  assert.equal(posts.length + puts.length, 0, "discarded edits were never saved to either diary");
  checks.push("organisation-to-site switch: Keep editing and Discard both behave");

  // ── A late response (another device creates the day) keeps unsaved edits ──
  await correctivesBox(page).fill("Site walk-in fan cleaned");
  serverWrite(SITE.id, TODAY, { correctives: "Entered on the phone" });
  await refetchDiary(page);
  state = await diaryState(page);
  assert.equal(state.correctives, "Site walk-in fan cleaned", "a refetched record does not overwrite unsaved edits");
  // The edits were made on a new day, so saving asks the server to create it;
  // the server refuses and the diary reloads with a clear message instead of
  // silently overwriting the phone's entry.
  let before = await toastCount(page);
  await page.getByRole("button", { name: "Save Draft" }).click();
  await expectToast(page, before, "Diary changed elsewhere");
  assert.equal(posts.at(-1)?.siteId, SITE.id);
  assert.equal(puts.length, 0, "the newer record was not overwritten by a PUT built on it");
  await waitForDiary(page, { date: TODAY, unit: null, correctives: "Entered on the phone" });
  checks.push("late record: unsaved edits stay; the save is refused, not applied over the other entry");

  // ── A clean form shows newer server data; a dirty one keeps its edits ──
  serverWrite(SITE.id, TODAY, { correctives: "Updated on the phone" });
  await refetchDiary(page);
  await waitForDiary(page, { date: TODAY, unit: null, correctives: "Updated on the phone" });
  checks.push("refetch: a clean form shows the newer version");

  const baseVersion = records.get(scopeKey(SITE.id, TODAY)).updatedAt;
  await correctivesBox(page).fill("Chef's own note");
  serverWrite(SITE.id, TODAY, { correctives: "Phone again" });
  await refetchDiary(page);
  state = await diaryState(page);
  assert.equal(state.correctives, "Chef's own note", "a refetched update does not overwrite unsaved edits");
  before = await toastCount(page);
  await page.getByRole("button", { name: "Save Draft" }).click();
  await expectToast(page, before, "Diary changed elsewhere");
  assert.equal(puts.at(-1)?.expectedUpdatedAt, baseVersion,
    "the save is checked against the version the edits were made on");
  await waitForDiary(page, { date: TODAY, unit: null, correctives: "Phone again" });
  checks.push("late update: unsaved edits stay; the save is checked against their base version");

  // ── Saving makes the form clean, so the next date change does not ask ──
  await correctivesBox(page).fill("Saved note");
  before = await toastCount(page);
  await page.getByRole("button", { name: "Save Draft" }).click();
  await expectToast(page, before, "Draft saved");
  assert.equal(records.get(scopeKey(SITE.id, TODAY)).correctives, "Saved note");
  await waitForDiary(page, { date: TODAY, unit: null, correctives: "Saved note" });
  await dateInput(page).fill(TWO_DAYS_AGO);
  await waitForDiary(page, { date: TWO_DAYS_AGO, unit: "Site Fridge", correctives: "" });
  assert.equal(await discardDialog(page).count(), 0, "a saved form switches without a prompt");
  checks.push("save: the form is clean afterwards");

  assert.deepEqual(pageErrors, [], "no page errors");
  const unexpected = unexpectedRequests.filter(entry => !entry.startsWith("GET "));
  assert.deepEqual(unexpected, [], "no writes outside the fixture");
  for (const check of checks) console.log(`ok - ${check}`);
  console.log(`KitchenTrack diary unsaved-edit browser tests passed (${checks.length} checks).`);
} catch (error) {
  for (const check of checks) console.log(`ok - ${check}`);
  console.error(error);
  if (unexpectedRequests.length) console.error("Unexpected requests:", unexpectedRequests);
  process.exitCode = 1;
} finally {
  await browser?.close();
  vite.kill("SIGTERM");
}
