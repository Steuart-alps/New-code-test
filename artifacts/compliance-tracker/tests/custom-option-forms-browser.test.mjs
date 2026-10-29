import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { chromium } from "@playwright/test";
import { sortByLabel } from "../src/lib/sort-options.ts";

// Browser regression for the record forms that use per-client dropdown lists:
// the FixTrack contractor trades (src/components/contractor-form-dialog.tsx,
// opened from src/pages/contractors.tsx for new contractors and
// src/pages/contractor-detail.tsx for edits) and the PremisesTrack inspection
// type (src/pages/premises-track.tsx). The API offers active values for new
// records and keeps disabled ones so existing records stay valid; it rejects a
// disabled value on a new record but accepts it on an edit while unchanged.
// For a consultant working in each of two businesses this checks:
//   - new-record selectors offer exactly the selected business's active values
//     (never its disabled values, never another business's values),
//   - edit forms still show and keep a record's disabled value, marked as
//     disabled, and Save goes through without changing it,
//   - form-options and record requests all carry that business's clientId.
// The API fixture is stateful and applies the rules in
// artifacts/api-server/src/routes/contractors.ts and premises-track.ts.
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

// ─── Fixtures ────────────────────────────────────────────────────────────────

// Labels the forms show: TRADE_OPTIONS in contractor-form-dialog.tsx (custom
// values are humanised) and TYPE_LABELS in premises-track.tsx (custom values
// shown as typed).
const TRADE_LABELS = {
  electrical: "Electrical", plumbing: "Plumbing", gas_fireplace: "Gas — Fireplace / Fires",
  hvac: "HVAC (ventilation, air handling)", general: "General",
};
const TYPE_LABELS = {
  routine: "Routine inspection", hazard: "Hazard / slip-trip-fall", signage: "Signage",
  housekeeping: "Housekeeping",
};
const humanize = value => value.split("_").map(w => w ? w[0].toUpperCase() + w.slice(1) : w).join(" ");
const tradeLabel = value => TRADE_LABELS[value] ?? humanize(value);
const typeLabel = value => TYPE_LABELS[value] ?? value;
const DISABLED_SUFFIX = " (disabled)";

const CONSULTANT = { id: 9, email: "consultant@example.test", name: "Alps Consultant", role: "consultant", clientId: 5, departmentId: null, active: true, totpEnabled: true };
const client = (id, name) => ({ id, name, slug: name.toLowerCase().replace(/\W+/g, "-"), logoUrl: null, primaryColor: "#2F7C8C", active: true });
const contractor = (id, clientId, name, trades) => ({
  id, clientId, name, company: `${name} Ltd`, email: `${name.toLowerCase().replace(/\W+/g, ".")}@example.test`,
  phone: "01632 960000", address: null, notes: null, gasSafeNumber: null, gasSafeRegistration: null,
  publicLiabilityExpiry: null, dbsIssueDate: null, dbsType: null, dbsExpiryDate: null, trades,
  createdAt: "2026-01-10T09:00:00.000Z", updatedAt: "2026-01-10T09:00:00.000Z",
});
const inspection = (id, clientId, inspectionType, area) => ({
  id, clientId, siteId: null, inspectionDate: "2026-09-01", nextInspectionDate: null, inspectionType, area,
  findings: null, hazardDetails: null, actionRequired: null, actionTaken: null, status: "open",
  inspectedBy: "Duty Manager", staffRosterId: null, createdAt: "2026-09-01T09:00:00.000Z",
});

// Two businesses the consultant can open, each with its own vocabulary, plus
// the consultant's home business, which the server falls back to when a
// request carries no clientId. Each business's custom values are unknown to
// the other one.
const BUSINESSES = {
  5: {
    client: client(5, "Alps Consultancy"),
    trades: { active: ["electrical", "general"], disabled: [] },
    types: { active: ["routine"], disabled: [] },
    contractors: [], inspections: [],
  },
  41: {
    client: client(41, "Riverside Leisure"),
    trades: { active: ["electrical", "plumbing", "general", "Pool Plant Engineer"], disabled: ["gas_fireplace", "Rope Access"] },
    types: { active: ["routine", "hazard", "Poolside walk"], disabled: ["signage", "Fire door survey"] },
    contractors: [contractor(501, 41, "Riverside Rope Team", ["electrical", "Rope Access", "gas_fireplace"])],
    inspections: [inspection(701, 41, "Fire door survey", "Plant room fire doors"), inspection(702, 41, "routine", "Changing rooms")],
    newTrades: ["Pool Plant Engineer", "electrical"],
    newType: "Poolside walk",
  },
  23: {
    client: client(23, "Harbour Hotel Group"),
    trades: { active: ["electrical", "hvac", "Kitchen Extraction"], disabled: ["plumbing"] },
    types: { active: ["routine", "housekeeping", "Bedroom audit"], disabled: ["hazard"] },
    contractors: [contractor(601, 23, "Harbour Air Services", ["hvac", "plumbing"])],
    inspections: [inspection(801, 23, "hazard", "Kitchen back door"), inspection(802, 23, "routine", "Lobby")],
    newTrades: ["Kitchen Extraction"],
    newType: "Bedroom audit",
  },
};
const SELECTABLE = [41, 23];
const foreignValues = (clientId, key) => SELECTABLE.filter(id => id !== clientId)
  .flatMap(id => [...BUSINESSES[id][key].active, ...BUSINESSES[id][key].disabled])
  .filter(value => ![...BUSINESSES[clientId][key].active, ...BUSINESSES[clientId][key].disabled].includes(value));

// ─── API fixture ─────────────────────────────────────────────────────────────

let nextId = 9000;
const requests = [];          // { method, path, clientId }
const writes = [];            // { method, path, clientId, body, status, error }
const unexpectedRequests = [];
const csrfMissing = [];

const json = (route, data, code = 200) => route.fulfill({ status: code, contentType: "application/json", body: JSON.stringify(data) });

// contractors.ts parseTrades / validateTrades.
function validTrades(business, raw, existing = []) {
  if (!Array.isArray(raw)) return [];
  if (raw.length > 20 || raw.some(t => typeof t !== "string")) return null;
  const trades = raw.map(t => t.trim());
  if (trades.some(t => !t || t.length > 60)) return null;
  if (new Set(trades.map(t => t.toLowerCase())).size !== trades.length) return null;
  return trades.every(t => existing.includes(t) || business.trades.active.includes(t)) ? trades : null;
}

async function routeApi(route) {
  const request = route.request(), url = new URL(request.url()), method = request.method();
  const path = url.pathname;
  const queryClientId = url.searchParams.get("clientId");
  // The server uses the caller's home business when no clientId is sent.
  const clientId = queryClientId === null ? CONSULTANT.clientId : Number(queryClientId);
  const business = BUSINESSES[clientId];
  const exempt = path.startsWith("/api/auth/") || path.startsWith("/api/analytics/")
    // AuthProvider re-checks the remembered business before selecting it.
    || (method === "GET" && /^\/api\/clients\/\d+$/.test(path));
  if (!exempt) requests.push({ method, path, clientId: queryClientId === null ? null : clientId });
  if (method !== "GET" && request.headers()["x-csrf-token"] !== "custom-options-csrf") csrfMissing.push(`${method} ${path}`);
  if (!business && !exempt) return json(route, { error: "Forbidden" }, 403);

  const body = method === "POST" || method === "PUT" ? JSON.parse(request.postData() ?? "{}") : undefined;
  const write = (status, data) => {
    writes.push({ method, path, clientId, body, status, error: status >= 400 ? data.error : null });
    return json(route, data, status);
  };

  if (method === "GET") {
    switch (path) {
      case "/api/auth/csrf-token": return json(route, { token: "custom-options-csrf" });
      case "/api/auth/me": return json(route, {
        user: CONSULTANT, client: BUSINESSES[CONSULTANT.clientId].client, billingLocked: false, services: "all",
      });
      case "/api/billing/cancellation-status": return json(route, { accessEndsAt: null });
      // The header's notification bell (#92) and a contractor's calendar
      // cancellation history (#99) load alongside the forms under test.
      case "/api/notifications": return json(route, { notifications: [], unreadCount: 0 });
      case "/api/fix-track/calendar-cancellations": return json(route, []);
      case "/api/managed-by": return json(route, null);
      // Setup is finished, so the "Add your team first" gate stays out of the way.
      case "/api/setup/state": return json(route, { needsSetup: false, canManage: true, team: { recorders: 2, aloneAt: null, ready: true } });
      case "/api/sites": return json(route, []);
      case "/api/staff-roster": return json(route, []);
      case "/api/assignees": return json(route, []);
      case "/api/compliance-items":
      case "/api/categories":
      case "/api/track-actions":
      case "/api/track-actions/templates/matching":
      case "/api/track-evidence":
      case "/api/track-evidence/requirements": return json(route, []);
      case "/api/form-options": return json(route, {
        options: { fixtrack_trades: business.trades.active, premises_inspection_types: business.types.active },
        defaults: { fixtrack_trades: [], premises_inspection_types: [] },
        disabled: { fixtrack_trades: business.trades.disabled, premises_inspection_types: business.types.disabled },
        customised: { fixtrack_trades: true, premises_inspection_types: true },
      });
      case "/api/contractors": return json(route, business.contractors);
      case "/api/premises-track/": return json(route, business.inspections);
      case "/api/premises-track/summary": {
        const count = status => business.inspections.filter(r => r.status === status).length;
        return json(route, { open: count("open"), actioned: count("actioned"), closed: count("closed"), overdue: 0, total: business.inspections.length });
      }
    }
    const clientMatch = path.match(/^\/api\/clients\/(\d+)$/);
    if (clientMatch) {
      const id = Number(clientMatch[1]);
      return SELECTABLE.includes(id) ? json(route, BUSINESSES[id].client) : json(route, { error: "Not found" }, 404);
    }
    const contractorMatch = path.match(/^\/api\/contractors\/(\d+)(\/certificates)?$/);
    if (contractorMatch) {
      const found = business.contractors.find(c => c.id === Number(contractorMatch[1]));
      if (!found) return json(route, { error: "Contractor not found" }, 404);
      return json(route, contractorMatch[2] ? [] : found);
    }
  }

  if (method === "POST" && path === "/api/contractors") {
    const trades = validTrades(business, body.trades);
    if (!trades) return write(400, { error: "Trades must use active client trade options" });
    const created = { ...contractor(nextId++, clientId, body.name, trades), ...body, trades };
    business.contractors.push(created);
    return write(201, created);
  }
  const contractorPut = method === "PUT" && path.match(/^\/api\/contractors\/(\d+)$/);
  if (contractorPut) {
    const existing = business.contractors.find(c => c.id === Number(contractorPut[1]));
    if (!existing) return write(404, { error: "Contractor not found" });
    const trades = "trades" in body ? validTrades(business, body.trades, existing.trades) : existing.trades;
    if (!trades) return write(400, { error: "Trades must use active client trade options" });
    Object.assign(existing, body, { trades });
    return write(200, existing);
  }
  if (method === "POST" && path === "/api/premises-track/") {
    if (!business.types.active.includes(body.inspectionType)) return write(400, { error: "Invalid inspection type" });
    const created = { ...inspection(nextId++, clientId, body.inspectionType, body.area), ...body };
    business.inspections.unshift(created);
    return write(201, created);
  }
  const inspectionPut = method === "PUT" && path.match(/^\/api\/premises-track\/(\d+)$/);
  if (inspectionPut) {
    const current = business.inspections.find(r => r.id === Number(inspectionPut[1]));
    if (!current) return write(404, { error: "Not found" });
    if (body.inspectionType !== current.inspectionType && !business.types.active.includes(body.inspectionType)) {
      return write(400, { error: "Invalid inspection type" });
    }
    Object.assign(current, body);
    return write(200, { ok: true });
  }
  if (method === "POST" && path === "/api/analytics/events") return route.fulfill({ status: 204 });
  // The Contractors page's "Contractor visits" card (#155).
  if (method === "GET" && path === "/api/contractor-visits") return json(route, { types: [], visits: [] });
  // The Contractors page's "Certificates outstanding" card and the red check badge.
  if (method === "GET" && path === "/api/certificates-outstanding") return json(route, { followUpAfterDays: 14, chaseStopsAfterDays: 90, certificates: [] });
  // The app-wide storage limit banner (#156).
  if (method === "GET" && path === "/api/storage/status") {
    return json(route, { state: "not_limited", canManage: true, autoTopUp: false, usedBytes: 0, capacityBytes: null });
  }
  unexpectedRequests.push(`${method} ${path}${url.search}`);
  return json(route, { error: "Not in the custom option forms fixture" }, 404);
}

// ─── Page helpers ────────────────────────────────────────────────────────────

async function openRoute(page, route, ready) {
  await page.goto(`${baseUrl}/tests/custom-option-forms-harness.html?route=${encodeURIComponent(route)}`, { waitUntil: "domcontentloaded" });
  await ready.waitFor();
}

const lastWrite = (method, path) => writes.filter(w => w.method === method && w.path === path).at(-1);
async function expectWrite(action, method, path) {
  const before = writes.length;
  await action();
  for (let i = 0; i < 200 && !writes.slice(before).some(w => w.method === method && w.path === path); i++) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const write = writes.slice(before).find(w => w.method === method && w.path === path);
  assert.ok(write, `expected ${method} ${path}`);
  return write;
}

/** The contractor dialog's trade toggles: label and whether each is ticked. */
const tradeToggles = dialog => dialog.locator("button[aria-pressed]").evaluateAll(buttons =>
  buttons.map(button => ({ label: button.textContent.trim(), pressed: button.getAttribute("aria-pressed") === "true" })));

async function waitForToggles(page, dialog, count) {
  await page.waitForFunction(({ selector, count }) =>
    document.querySelector(selector)?.querySelectorAll("button[aria-pressed]").length === count,
  { selector: "[role='dialog']", count });
  return tradeToggles(dialog);
}

/** Opens the inspection type select and returns its option labels. */
async function typeOptions(page, dialog) {
  await dialog.getByRole("combobox", { name: "Type", exact: true }).click();
  const listbox = page.getByRole("listbox");
  await listbox.waitFor();
  return listbox.getByRole("option").evaluateAll(options => options.map(option => option.textContent.trim()));
}
async function chooseType(page, label) {
  await page.getByRole("listbox").getByRole("option", { name: label, exact: true }).click();
  await page.getByRole("listbox").waitFor({ state: "detached" });
}

// ─── Scenarios ───────────────────────────────────────────────────────────────

async function newContractor(page, clientId) {
  const business = BUSINESSES[clientId];
  await openRoute(page, "/contractors", page.getByText(business.contractors[0].name, { exact: true }));
  await page.getByRole("button", { name: "Add Contractor" }).click();
  const dialog = page.getByRole("dialog", { name: "Add Contractor" });
  await dialog.waitFor();
  const toggles = await waitForToggles(page, dialog, business.trades.active.length);
  assert.deepEqual(toggles.map(t => t.label), business.trades.active.map(tradeLabel),
    `${clientId}: a new contractor is offered exactly the active trades`);
  assert.ok(toggles.every(t => !t.pressed), `${clientId}: nothing is ticked for a new contractor`);
  for (const value of [...business.trades.disabled, ...foreignValues(clientId, "trades")]) {
    assert.ok(!toggles.some(t => t.label.startsWith(tradeLabel(value))), `${clientId}: "${value}" is not offered for a new contractor`);
  }

  for (const value of business.newTrades) await dialog.getByRole("button", { name: tradeLabel(value), exact: true }).click();
  await dialog.locator("#name").fill(`New ${business.client.name} contractor`);
  await dialog.locator("#email").fill(`new.${clientId}@example.test`);
  const write = await expectWrite(() => dialog.getByRole("button", { name: "Save Contractor" }).click(), "POST", "/api/contractors");
  assert.equal(write.status, 201, `${clientId}: the new contractor is accepted (${write.error})`);
  assert.deepEqual(write.body.trades, business.newTrades, `${clientId}: the new contractor carries the chosen active trades`);
  await dialog.waitFor({ state: "detached" });
}

async function editContractor(page, clientId) {
  const business = BUSINESSES[clientId];
  const record = business.contractors[0];
  const stored = [...record.trades];
  const retired = stored.filter(t => !business.trades.active.includes(t));
  assert.ok(retired.length > 0 && retired.every(t => business.trades.disabled.includes(t)), "fixture: the contractor has disabled trades");
  const path = `/api/contractors/${record.id}`;
  const openEdit = async () => {
    await openRoute(page, `/contractors/${record.id}`, page.getByRole("heading", { name: record.name }));
    await page.locator("button:has(svg.lucide-pencil)").first().click();
    const dialog = page.getByRole("dialog", { name: "Edit Contractor" });
    await dialog.waitFor();
    return dialog;
  };

  // The stored disabled trades are listed after the active ones, marked, and
  // still ticked; an unrelated edit saves them unchanged.
  let dialog = await openEdit();
  const expectedLabels = [...business.trades.active.map(tradeLabel), ...retired.map(t => tradeLabel(t) + DISABLED_SUFFIX)];
  let toggles = await waitForToggles(page, dialog, expectedLabels.length);
  assert.deepEqual(toggles.map(t => t.label), expectedLabels, `${clientId}: edit lists active trades then the contractor's disabled ones`);
  assert.deepEqual(toggles.filter(t => t.pressed).map(t => t.label).sort(),
    stored.map(t => tradeLabel(t) + (retired.includes(t) ? DISABLED_SUFFIX : "")).sort(),
    `${clientId}: every stored trade is ticked, disabled ones included`);
  for (const value of [...business.trades.disabled.filter(t => !stored.includes(t)), ...foreignValues(clientId, "trades")]) {
    assert.ok(!toggles.some(t => t.label.startsWith(tradeLabel(value))), `${clientId}: "${value}" is not offered when editing`);
  }
  await dialog.locator("#phone").fill("01632 960999");
  let write = await expectWrite(() => dialog.getByRole("button", { name: "Save Contractor" }).click(), "PUT", path);
  assert.equal(write.status, 200, `${clientId}: an unrelated edit is accepted (${write.error})`);
  assert.deepEqual(write.body.trades, stored, `${clientId}: the disabled trades are saved unchanged`);
  assert.equal(write.body.phone, "01632 960999");
  await dialog.waitFor({ state: "detached" });

  // Unticking a disabled trade keeps it listed so it can be ticked again;
  // removing one for good is saved, and it is then no longer offered.
  dialog = await openEdit();
  await waitForToggles(page, dialog, expectedLabels.length);
  const keep = retired[0], drop = retired.at(-1);
  const toggle = value => dialog.getByRole("button", { name: tradeLabel(value) + DISABLED_SUFFIX, exact: true });
  await toggle(keep).click();
  assert.ok((await tradeToggles(dialog)).some(t => t.label === tradeLabel(keep) + DISABLED_SUFFIX && !t.pressed),
    `${clientId}: an unticked disabled trade stays listed, so the untick can be undone`);
  await toggle(keep).click();
  assert.equal(await toggle(keep).getAttribute("aria-pressed"), "true", `${clientId}: and ticked again in the same edit`);
  if (drop !== keep) await toggle(drop).click();
  toggles = await tradeToggles(dialog);
  assert.equal(toggles.length, expectedLabels.length, `${clientId}: unticked disabled trades stay listed until saved`);
  write = await expectWrite(() => dialog.getByRole("button", { name: "Save Contractor" }).click(), "PUT", path);
  const expectedTrades = drop === keep ? stored : stored.filter(t => t !== drop);
  assert.equal(write.status, 200, `${clientId}: removing a disabled trade is accepted (${write.error})`);
  assert.deepEqual(write.body.trades, expectedTrades);
  await dialog.waitFor({ state: "detached" });
  if (drop !== keep) {
    dialog = await openEdit();
    toggles = await waitForToggles(page, dialog, expectedLabels.length - 1);
    assert.ok(!toggles.some(t => t.label.startsWith(tradeLabel(drop))), `${clientId}: a removed disabled trade is no longer offered`);
    await dialog.getByRole("button", { name: "Cancel" }).click();
  }
}

async function newInspection(page, clientId) {
  const business = BUSINESSES[clientId];
  await openRoute(page, "/premises-track", page.getByRole("cell", { name: business.inspections[0].area }));
  await page.getByRole("button", { name: "Log inspection" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Log premises inspection" });
  await dialog.waitFor();
  const trigger = dialog.getByRole("combobox", { name: "Type", exact: true });
  assert.equal((await trigger.textContent()).trim(), typeLabel(business.types.active[0]),
    `${clientId}: a new inspection starts on the first active type`);
  const options = await typeOptions(page, dialog);
  assert.deepEqual(options, sortByLabel(business.types.active.map(typeLabel), label => label), `${clientId}: a new inspection is offered exactly the active types, A to Z`);
  for (const value of [...business.types.disabled, ...foreignValues(clientId, "types")]) {
    assert.ok(!options.some(label => label.startsWith(typeLabel(value))), `${clientId}: "${value}" is not offered for a new inspection`);
  }
  await chooseType(page, typeLabel(business.newType));
  await dialog.getByPlaceholder("e.g. Reception, stairwell, car park").fill("New inspection area");
  const write = await expectWrite(() => dialog.getByRole("button", { name: "Log inspection" }).click(), "POST", "/api/premises-track/");
  assert.equal(write.status, 201, `${clientId}: the new inspection is accepted (${write.error})`);
  assert.equal(write.body.inspectionType, business.newType);
  await dialog.waitFor({ state: "detached" });
}

async function editInspection(page, clientId) {
  const business = BUSINESSES[clientId];
  const record = business.inspections.find(r => business.types.disabled.includes(r.inspectionType));
  const retiredLabel = typeLabel(record.inspectionType) + DISABLED_SUFFIX;
  const path = `/api/premises-track/${record.id}`;
  const openEdit = async () => {
    await openRoute(page, "/premises-track", page.getByRole("cell", { name: record.area }));
    const row = page.getByRole("row").filter({ has: page.getByRole("cell", { name: record.area }) });
    await row.hover();
    await row.locator("button:has(svg.lucide-pencil)").click();
    const dialog = page.getByRole("dialog", { name: "Edit inspection" });
    await dialog.waitFor();
    return dialog;
  };

  // The disabled type stays selected and is listed (marked) beside the active
  // ones; an unrelated edit saves it unchanged.
  let dialog = await openEdit();
  await page.waitForFunction(label => [...document.querySelectorAll("[role='dialog'] [role='combobox']")]
    .some(el => el.textContent.trim() === label), retiredLabel);
  const options = await typeOptions(page, dialog);
  assert.deepEqual(options, sortByLabel([...business.types.active.map(typeLabel), retiredLabel], label => label),
    `${clientId}: edit lists the active types plus the record's disabled type, A to Z`);
  for (const value of [...business.types.disabled.filter(t => t !== record.inspectionType), ...foreignValues(clientId, "types")]) {
    assert.ok(!options.some(label => label.startsWith(typeLabel(value))), `${clientId}: "${value}" is not offered when editing`);
  }
  await chooseType(page, retiredLabel);
  await dialog.getByPlaceholder("What was observed during the inspection").fill("Two closers need adjusting");
  let write = await expectWrite(() => dialog.getByRole("button", { name: "Save changes" }).click(), "PUT", path);
  assert.equal(write.status, 200, `${clientId}: an unrelated edit is accepted (${write.error})`);
  assert.equal(write.body.inspectionType, record.inspectionType, `${clientId}: the disabled type is saved unchanged`);
  assert.equal(write.body.findings, "Two closers need adjusting");
  await dialog.waitFor({ state: "detached" });

  // Switching away and back within one edit keeps the disabled type available.
  dialog = await openEdit();
  await typeOptions(page, dialog);
  await chooseType(page, typeLabel(business.types.active[0]));
  assert.equal((await dialog.getByRole("combobox", { name: "Type", exact: true }).textContent()).trim(), typeLabel(business.types.active[0]));
  await typeOptions(page, dialog);
  await chooseType(page, retiredLabel);
  write = await expectWrite(() => dialog.getByRole("button", { name: "Save changes" }).click(), "PUT", path);
  assert.equal(write.status, 200, `${clientId}: re-choosing the stored disabled type is accepted (${write.error})`);
  assert.equal(write.body.inspectionType, record.inspectionType);
  await dialog.waitFor({ state: "detached" });

  // The row's quick status action is an edit too and keeps the type.
  await openRoute(page, "/premises-track", page.getByRole("cell", { name: record.area }));
  const row = page.getByRole("row").filter({ has: page.getByRole("cell", { name: record.area }) });
  await row.hover();
  write = await expectWrite(() => row.getByTitle("Mark actioned").click(), "PUT", path);
  assert.equal(write.status, 200, `${clientId}: marking actioned is accepted (${write.error})`);
  assert.equal(write.body.inspectionType, record.inspectionType);
  assert.equal(write.body.status, "actioned");
}

// ─── Run ─────────────────────────────────────────────────────────────────────

const checks = [];
let activePage;
try {
  await waitForVite();
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"], executablePath: chromiumPath() });
  const pageErrors = [];

  for (const clientId of SELECTABLE) {
    const requestsBefore = requests.length, writesBefore = writes.length;
    const context = await browser.newContext({ viewport: { width: 1400, height: 1000 }, locale: "en-GB" });
    // The consultant has this business selected (AuthProvider restores it
    // from this tab's session storage after checking /api/clients/:id).
    await context.addInitScript(({ userId, clientId }) => {
      window.sessionStorage.setItem("complytrack:activeClient", JSON.stringify({ userId, clientId }));
    }, { userId: CONSULTANT.id, clientId });
    const page = await context.newPage();
    activePage = page;
    page.setDefaultTimeout(20000);
    page.on("pageerror", error => pageErrors.push(`${clientId}: ${error.message}`));
    await page.route(url => new URL(url).pathname.startsWith("/api/"), routeApi);

    const name = BUSINESSES[clientId].client.name;
    await newContractor(page, clientId);
    checks.push(`${name}: new contractor offers only active trades`);
    await editContractor(page, clientId);
    checks.push(`${name}: contractor edit keeps disabled trades`);
    await newInspection(page, clientId);
    checks.push(`${name}: new inspection offers only active types`);
    await editInspection(page, clientId);
    checks.push(`${name}: inspection edit keeps a disabled type`);

    // Every form-options and record request went to the selected business.
    const scoped = requests.slice(requestsBefore);
    const wrong = scoped.filter(r => r.clientId !== clientId).map(r => `${r.method} ${r.path} -> ${r.clientId}`);
    assert.deepEqual(wrong, [], `${name}: every request carries clientId=${clientId}`);
    for (const [method, path] of [
      ["GET", "/api/form-options"], ["GET", "/api/contractors"], ["GET", `/api/contractors/${BUSINESSES[clientId].contractors[0].id}`],
      ["GET", "/api/premises-track/"], ["POST", "/api/contractors"], ["POST", "/api/premises-track/"],
    ]) {
      assert.ok(scoped.some(r => r.method === method && r.path === path), `${name}: ${method} ${path} was requested`);
    }
    const rejected = writes.slice(writesBefore).filter(w => w.status >= 400);
    assert.deepEqual(rejected.map(w => `${w.method} ${w.path}: ${w.error}`), [], `${name}: the API rules accepted every save`);
    checks.push(`${name}: form options and record requests scoped to the selected business`);
    await context.close();
  }

  // Nothing leaked into the consultant's home business.
  assert.equal(BUSINESSES[5].contractors.length, 0);
  assert.equal(BUSINESSES[5].inspections.length, 0);
  assert.deepEqual(csrfMissing, [], "every write carries the CSRF token");
  assert.deepEqual(unexpectedRequests, []);
  assert.deepEqual(pageErrors, []);
  console.log(`Custom option forms browser checks passed (${checks.length}/${checks.length}):\n${checks.map(c => `  ✓ ${c}`).join("\n")}`);
} catch (error) {
  console.error("Custom option forms page:", activePage ? await activePage.locator("body").innerText().catch(() => "") : "");
  console.error("Unexpected requests:", unexpectedRequests);
  throw error;
} finally {
  await browser?.close();
  vite.kill("SIGTERM");
}
