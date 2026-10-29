import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { chromium } from "@playwright/test";

// Browser regression for FireTrack's schedule wording, call points and drills
// (src/pages/fire-safety.tsx):
//   - status cards say Weekly / Monthly / At least every 6 months;
//   - a weekly alarm test picks the next call point in the site's order (after
//     the one tested last), sends the one chosen, and cannot be saved without
//     a call point; the page shows the next one and any not tested this round;
//   - the emergency lighting test explains the 5 minute flick test;
//   - the contractor services (fire alarm and extinguisher services, annual
//     3-hour emergency lighting test) show red/amber/green from their
//     compliance checks, each opening the check; they and the alarm panel
//     check are no longer offered or shown as due here, but an older alarm
//     panel record stays in the history and its type can still be filtered;
//   - "Performed by" offers everyone with a login (not the roster, which can
//     run to dozens), so a Manager can be chosen and roster staff typed in;
//   - a drill cannot be saved until it gives the time of the drill, the time
//     taken to evacuate, "Night staff included?" (Yes / No / N/A) and the
//     improvements required; it sends the roster staff ticked as present;
//   - history shows the call point and drill details, and a card lists roster
//     staff not in a drill in the last 12 months;
//   - managers add call points with a location under Template, Call points,
//     change their order with the arrows, and upload a list;
//   - a consultant whose own business has only core opens a free business
//     (every module included): FireTrack opens there instead of asking to
//     enable it, because the modules come from /auth/me?clientId=<open one>.
// The /api/fire-safety fixture mirrors artifacts/api-server/src/routes/fire-safety.ts.
// FIRE_TRACK_SCREENSHOTS=<dir> saves screenshots of each step.
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
const screenshotDir = process.env.FIRE_TRACK_SCREENSHOTS;
if (screenshotDir) mkdirSync(screenshotDir, { recursive: true });
const shot = async (page, name) => {
  if (screenshotDir) await page.screenshot({ path: `${screenshotDir}/${name}.png` });
};

const localDate = (offsetDays = 0) => {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};
const TODAY = localDate(0);
const CLIENT_ID = 23;
const HOME_CLIENT_ID = 5;
let asConsultant = false;
const SITE = { id: 1, name: "Harbour Hotel" };

// ─── Stateful /api/fire-safety fixture ───────────────────────────────────────

// The server's ACTIVE_FIRE_CHECK_TYPES (alarm_panel and emergency_lights_annual are retired).
const FREQUENCIES = { alarm: 7, emergency_lights: 30, extinguishers: 7, fire_doors: 90, fire_drill: 180, fire_walk: 7, alarm_service: 180, extinguisher_service: 365 };
const callPoints = [
  { id: 11, siteId: 1, name: "CP1 – Reception", location: null, sortOrder: 1, sleepingArea: true, archivedAt: null, lastTestedDate: localDate(-7) },
  { id: 12, siteId: 1, name: "CP2 – Kitchen", location: null, sortOrder: 2, archivedAt: null, lastTestedDate: null },
  { id: 13, siteId: 1, name: "CP3 – Old wing", location: null, sortOrder: 3, archivedAt: "2026-09-01T09:00:00.000Z", lastTestedDate: localDate(-30) },
];
// The call point used on the latest alarm test (lib/fireCallPointRotation.ts).
let lastTestedPointId = 11;
const byOrder = (a, b) => a.sortOrder - b.sortOrder || a.id - b.id;
function withRotation(point) {
  const active = callPoints.filter(p => !p.archivedAt).sort(byOrder);
  const last = callPoints.find(p => p.id === lastTestedPointId);
  const next = last ? active.find(p => byOrder(p, last) > 0) ?? active[0] : active[0];
  const roundDays = active.length * FREQUENCIES.alarm;
  const daysAgo = point.lastTestedDate ? Math.round((Date.parse(TODAY) - Date.parse(point.lastTestedDate)) / 86_400_000) : null;
  return {
    ...point, nextInTurn: !point.archivedAt && next?.id === point.id,
    notTestedThisRound: !point.archivedAt && (daysAgo === null || daysAgo > roundDays),
  };
}
// Staff roster for ticking who was present at a drill (Cat has no site).
const roster = [
  { id: 31, name: "Ann Able", site_id: 1, site_name: "Harbour Hotel", active: true },
  { id: 32, name: "Bob Brown", site_id: 1, site_name: "Harbour Hotel", active: true },
  { id: 33, name: "Cat Cole", site_id: null, site_name: null, active: true },
];
let nextId = 500;
const checks = [
  {
    id: 401, clientId: CLIENT_ID, siteId: 1, checkType: "alarm", checkDate: localDate(-7), result: "pass",
    location: null, notes: null, performedBy: "Duty Manager", callPointId: 11, callPoint: "CP1 – Reception", nightStaff: null,
    drillTime: null, evacuationSeconds: null, staffPresent: [],
    createdAt: "2026-10-09T09:00:00.000Z", updatedAt: "2026-10-09T09:00:00.000Z",
  },
  {
    id: 402, clientId: CLIENT_ID, siteId: 1, checkType: "fire_drill", checkDate: localDate(-100), result: "pass",
    location: null, notes: "Kitchen exit sign needs replacing", performedBy: "Duty Manager", callPointId: null, callPoint: null, nightStaff: "not_included",
    drillTime: "10:15", evacuationSeconds: 185, staffPresent: [{ staffRosterId: 31, name: "Ann Able" }],
    createdAt: "2026-07-08T09:00:00.000Z", updatedAt: "2026-07-08T09:00:00.000Z",
  },
  {
    id: 403, clientId: CLIENT_ID, siteId: 1, checkType: "alarm_panel", checkDate: localDate(-40), result: "pass",
    location: null, performedBy: "Duty Manager", callPointId: null, callPoint: null, nightStaff: null,
    notes: JSON.stringify({ _type: "alarm_panel", panelStatus: "normal", faultsFound: "", zonesTested: "", actionsTaken: "", freeNotes: "" }),
    createdAt: "2026-09-19T09:00:00.000Z", updatedAt: "2026-09-19T09:00:00.000Z",
  },
];
const posts = [];
const unexpectedRequests = [];
const assigneeRequests = [];

// Contractor visit types (artifacts/api-server/src/lib/contractorVisits.ts)
// and their compliance checks: one with a certificate outstanding (red), one
// due within 30 days (amber), one done in house (green), one with no check
// that is marked "No contractor needed".
const CONTRACTOR_TYPES = [
  { key: "fire:alarm_service", module: "fire", trackLabel: "FireTrack", title: "Fire Alarm Maintenance", label: "Fire alarm service (6-monthly)", description: "", dueFrom: "check" },
  { key: "fire:extinguisher_service", module: "fire", trackLabel: "FireTrack", title: "Fire Extinguishers Maintenance", label: "Fire extinguisher service (annual)", description: "", dueFrom: "check" },
  { key: "fire:emergency_lights_annual", module: "fire", trackLabel: "FireTrack", title: "Emergency Light Maintenance", label: "Emergency lighting 3-hour test (annual)", description: "", dueFrom: "check" },
  { key: "fire:risk_assessment", module: "fire", trackLabel: "FireTrack", title: "Fire Risk Assessment Review", label: "Fire risk assessment review", description: "", dueFrom: "later" },
  { key: "pest:visit", module: "pest", trackLabel: "PestTrack", title: "Pest Control Visit", label: "Routine pest control visit", description: "", dueFrom: "track" },
];
const complianceItem = (id, title, fields) => ({
  id, title, status: "pending", priority: "high", siteId: 1, siteName: SITE.name, categoryId: null, categoryName: null, categoryColor: null,
  contractorId: null, contractorName: null, contractorEmail: null, assignedTo: null, assigneeUserId: null, dueDate: null,
  leadTimeDays: 14, frequencyMonths: 12, notificationSentAt: null, completedAt: null, completedInHouseBy: null, notes: null,
  needsAction: false, needsActionReason: null, openDefectCount: 0, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  ...fields,
});
const COMPLIANCE_ITEMS = [
  complianceItem(61, "Fire Alarm Maintenance", {
    frequencyMonths: 6, contractorId: 3, contractorName: "Alarm Co", completedAt: `${localDate(-20)}T00:00:00.000Z`,
    dueDate: `${localDate(160)}T00:00:00.000Z`, needsAction: true, needsActionReason: "certificate_outstanding",
  }),
  complianceItem(62, " fire extinguishers maintenance ", { siteId: null, siteName: null, dueDate: `${localDate(12)}T00:00:00.000Z` }),
  complianceItem(63, "Emergency Light Maintenance", {
    completedAt: `${localDate(-40)}T00:00:00.000Z`, completedInHouseBy: "Sam Patel", dueDate: `${localDate(325)}T00:00:00.000Z`,
  }),
  complianceItem(64, "Gas Boilers — Annual Service", { dueDate: `${localDate(-5)}T00:00:00.000Z` }),
];

const json = (route, data, code = 200) => route.fulfill({ status: code, contentType: "application/json", body: JSON.stringify(data) });
async function routeApi(route) {
  const request = route.request(), url = new URL(request.url()), method = request.method();
  const path = url.pathname;
  if (method === "GET") {
    switch (path) {
      case "/api/auth/csrf-token": return json(route, { token: "fire-track-csrf" });
      case "/api/auth/me": if (asConsultant) {
        // Their own business (HOME_CLIENT_ID) has core only; CLIENT_ID is free.
        const open = url.searchParams.get("clientId");
        return json(route, {
          user: { id: 8, email: "consultant@example.test", name: "ALPS Consultant", role: "consultant", clientId: HOME_CLIENT_ID, departmentId: null, active: true, totpEnabled: true },
          billingLocked: false, client: { id: HOME_CLIENT_ID, name: "ALPS Consultancy", slug: "alps", logoUrl: null, primaryColor: "#2F7C8C", active: true },
          services: open === String(CLIENT_ID) ? "all" : ["core"],
        });
      } else return json(route, {
        user: { id: 7, email: "manager@example.test", name: "Duty Manager", role: "client_admin", clientId: CLIENT_ID, departmentId: null, active: true, totpEnabled: true },
        billingLocked: false, client: { id: CLIENT_ID, name: "Harbour Hotel Group", slug: "harbour", logoUrl: null, primaryColor: "#2F7C8C", active: true },
        services: ["firetrack"],
      });
      case `/api/clients/${CLIENT_ID}`: return json(route, { id: CLIENT_ID, name: "Harbour Hotel Group" });
      case "/api/billing/cancellation-status": return json(route, { accessEndsAt: null });
      case "/api/notifications": return json(route, { notifications: [], unreadCount: 0 });
      case "/api/managed-by": return json(route, null);
      // Setup is finished, so the "Add your team first" gate stays out of the way.
      case "/api/setup/state": return json(route, { needsSetup: false, canManage: true, team: { recorders: 2, aloneAt: null, ready: true } });
      case "/api/sites": return json(route, [SITE]);
      case "/api/staff-roster": return json(route, roster);
      // Mirrors lib/fireDrillAttendance.ts: latest drill each person was ticked at.
      case "/api/fire-safety/drill-attendance": return json(route, {
        periodMonths: 12,
        staff: roster.map(person => {
          const dates = checks.filter(c => c.checkType === "fire_drill" && c.staffPresent.some(p => p.staffRosterId === person.id)).map(c => c.checkDate).sort();
          const lastDrillDate = dates.at(-1) ?? null;
          return { staffRosterId: person.id, name: person.name, siteId: person.site_id, siteName: person.site_name, lastDrillDate, due: !lastDrillDate || lastDrillDate <= localDate(-365) };
        }),
      });
      case "/api/storage/status": return json(route, { state: "not_limited", canManage: true, autoTopUp: false, usedBytes: 0, capacityBytes: null });
      case "/api/photos":
      case "/api/photos/requirements":
      case "/api/audit-log":
      case "/api/track-actions":
      case "/api/track-actions/templates/matching":
      case "/api/track-evidence":
      case "/api/track-evidence/requirements": return json(route, []);
      // FireTrack's contractor services are their compliance checks
      // (components/track-contractor-checks.tsx).
      case "/api/contractor-visits": return json(route, {
        types: CONTRACTOR_TYPES,
        visits: CONTRACTOR_TYPES.map(type => ({ visitKey: type.key, siteId: SITE.id, notNeeded: type.key === "fire:risk_assessment" })),
      });
      case "/api/compliance-items": return json(route, COMPLIANCE_ITEMS);
      // FireTrack's "Performed by" lists people with a login (Owners, Managers,
      // Staff), not the roster; roster staff are typed in under "Other".
      case "/api/assignees":
        assigneeRequests.push(url.searchParams.get("siteId"));
        return json(route, [
          { id: 7, name: "Duty Manager", role: "client_admin" },
          { id: 10, name: "Sam Green", role: "client_staff" },
          { id: 9, name: "Leanne Elliot", role: "client_manager" },
        ]);
      case "/api/fire-safety/config": return json(route, {
        fire_escape_routes: "", fire_alarm_zones: "", fire_extinguisher_points: "", fire_show_drill: "true",
        fire_default_performer: "", fire_frequency_days: JSON.stringify(FREQUENCIES), controlProfile: null,
        siteId: url.searchParams.get("siteId") ? Number(url.searchParams.get("siteId")) : null,
      });
      case "/api/fire-safety/status": return json(route, Object.entries(FREQUENCIES).map(([checkType, frequencyDays]) => {
        const last = checks.filter(c => c.checkType === checkType).sort((a, b) => b.checkDate.localeCompare(a.checkDate))[0];
        return {
          checkType, frequencyDays, lastDate: last?.checkDate ?? null, lastResult: last?.result ?? null,
          dueDate: null, status: last ? "ok" : "never", siteId: 1, siteName: SITE.name, siteCount: 1, sitesAffected: last ? 0 : 1,
        };
      }));
      case "/api/fire-safety": {
        const type = url.searchParams.get("checkType");
        return json(route, checks.filter(c => !type || c.checkType === type).sort((a, b) => b.checkDate.localeCompare(a.checkDate) || b.id - a.id));
      }
      case "/api/fire-safety/call-points": {
        const siteParam = url.searchParams.get("siteId");
        const rows = callPoints.filter(p => (siteParam === "none" ? p.siteId == null : !siteParam || p.siteId === Number(siteParam))
          && (url.searchParams.get("includeArchived") === "true" || !p.archivedAt));
        return json(route, [...rows].sort(byOrder).map(withRotation));
      }
    }
  }
  if (method === "POST" && path === "/api/fire-safety") {
    const body = JSON.parse(request.postData() ?? "{}");
    posts.push({ path, body });
    const point = callPoints.find(p => p.id === body.callPointId);
    const created = {
      id: nextId++, clientId: CLIENT_ID, siteId: body.siteId ?? null, checkType: body.checkType, checkDate: body.checkDate,
      result: body.result, location: body.location ?? null, notes: body.notes ?? null, performedBy: body.performedBy ?? null,
      callPointId: body.checkType === "alarm" ? body.callPointId ?? null : null,
      callPoint: body.checkType === "alarm" ? point?.name ?? body.callPoint ?? null : null,
      nightStaff: body.checkType === "fire_drill" ? body.nightStaff ?? null : null,
      drillTime: body.checkType === "fire_drill" ? body.drillTime ?? null : null,
      evacuationSeconds: body.checkType === "fire_drill" ? body.evacuationSeconds ?? null : null,
      staffPresent: body.checkType === "fire_drill"
        ? roster.filter(p => (body.staffPresentIds ?? []).includes(p.id)).map(p => ({ staffRosterId: p.id, name: p.name })) : [],
      soundLevelDb: body.checkType === "alarm" ? body.soundLevelDb ?? null : null,
      soundLevelMethod: body.checkType === "alarm" ? body.soundLevelMethod ?? null : null,
      soundLevelBedhead: body.checkType === "alarm" ? body.soundLevelBedhead ?? null : null,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    if (created.callPointId && point) { point.lastTestedDate = created.checkDate; lastTestedPointId = point.id; }
    checks.push(created);
    return json(route, created, 201);
  }
  if (method === "POST" && path === "/api/fire-safety/call-points") {
    const body = JSON.parse(request.postData() ?? "{}");
    posts.push({ path, body });
    const created = {
      id: nextId++, siteId: body.siteId, name: body.name, location: body.location ?? null,
      sortOrder: Math.max(0, ...callPoints.map(p => p.sortOrder)) + 1, archivedAt: null, lastTestedDate: null,
    };
    callPoints.push(created);
    return json(route, withRotation(created), 201);
  }
  if (method === "PUT" && path === "/api/fire-safety/call-points/order") {
    const body = JSON.parse(request.postData() ?? "{}");
    posts.push({ path, body });
    body.ids.forEach((id, index) => { callPoints.find(p => p.id === id).sortOrder = index + 1; });
    return json(route, callPoints.filter(p => !p.archivedAt).sort(byOrder).map(withRotation));
  }
  // The AI list reader (it needs the AI add-on) is not part of these checks.
  if (method === "GET" && path === "/api/imports/list-reading/fire-call-points") {
    return json(route, { available: false, monthlyLimit: 0, usedThisMonth: 0, ai: null, sites: [] });
  }
  if (method === "POST" && path === "/api/imports/fire-call-points") {
    const body = JSON.parse(request.postData() ?? "{}");
    posts.push({ path, body });
    return json(route, {
      preview: body.preview, committed: false, ignoredHeaders: [],
      summary: { total: body.rows.length, create: body.rows.length, update: 0, skip: 0, error: 0 },
      rows: body.rows.map((row, index) => ({ row: index + 2, action: "create", label: row.filter(Boolean).join(" · "), reasons: [] })),
    });
  }
  unexpectedRequests.push(`${method} ${path}`);
  return method === "GET" ? json(route, []) : json(route, { error: "Not in the FireTrack fixture" }, 404);
}

async function openRecordDialog(page, checkTypeLabel) {
  await page.getByRole("button", { name: "Record Check" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByText("Record Fire Safety Check").waitFor();
  if (checkTypeLabel) {
    await dialog.getByRole("combobox").first().click();
    await page.getByRole("option", { name: checkTypeLabel }).click();
  }
  return dialog;
}

try {
  await waitForVite();
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"], executablePath: chromiumPath() });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-GB", timezoneId: "Europe/London" });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.route("**/api/**", routeApi);
  await page.goto(`${baseUrl}/tests/fire-track-harness.html`, { waitUntil: "domcontentloaded" });

  // ── Status cards name the schedule in words ──────────────────────────────
  await page.getByText("Monthly emergency lighting flick test").first().waitFor();
  const cardText = await page.locator("body").innerText();
  assert.match(cardText, /Weekly fire alarm test\s+\S*\s*OK\s+Weekly/);
  assert.match(cardText, /Monthly emergency lighting flick test[\s\S]*?Monthly/);
  assert.match(cardText, /Fire drill \(6-monthly, with night staff\)[\s\S]*?At least every 6 months/);
  // ── History shows call points and night staff ────────────────────────────
  assert.match(cardText, /Call point: CP1 – Reception/);
  assert.match(cardText, /Night staff included: No/);
  assert.match(cardText, /Time of drill: 10:15/);
  assert.match(cardText, /Time taken to evacuate: 3 min 5 s/);
  assert.match(cardText, /Staff present \(1\): Ann Able/);
  assert.match(cardText, /Improvements required \/ notes: Kitchen exit sign needs replacing/);
  const drillCard = page.getByTestId("drill-attendance-card");
  await drillCard.waitFor();
  assert.match(await drillCard.innerText(), /2 of 3 staff have not taken part in a fire drill in the last 12 months/);
  assert.match(await drillCard.innerText(), /Bob Brown[\s\S]*Never[\s\S]*Cat Cole[\s\S]*Never/);
  assert.doesNotMatch(await drillCard.innerText(), /Ann Able/, "Ann was at the drill 100 days ago");
  await drillCard.scrollIntoViewIfNeeded();
  await shot(page, "1b-staff-fire-drills");
  await page.getByText("Time taken to evacuate: 3 min 5 s").scrollIntoViewIfNeeded();
  await shot(page, "1c-drill-history");
  // ── The rotation card names the next call point and any behind ─────────
  const rotationCard = page.getByTestId("call-point-rotation");
  await rotationCard.waitFor();
  assert.match(await rotationCard.innerText(), /Next to test: CP2 – Kitchen \(not tested yet\)/);
  assert.doesNotMatch(await rotationCard.innerText(), /Every call point has been tested/, "CP2 has never been tested");
  await shot(page, "1-status-and-history");
  console.log("ok - status cards say weekly, monthly and at least every 6 months; history shows call point and drill details; the drill card lists staff not in a drill");

  // ── Weekly alarm test: the next call point in turn is suggested ──────────
  let dialog = await openRecordDialog(page);
  const callPointSelect = dialog.getByTestId("select-call-point");
  await callPointSelect.waitFor();
  await page.waitForFunction(() => document.querySelector('[data-testid="select-call-point"]')?.textContent?.includes("CP2"));
  assert.match(await callPointSelect.innerText(), /CP2 – Kitchen · not tested yet · next in turn/);
  await callPointSelect.click();
  const options = await page.getByRole("option").allInnerTexts();
  assert.equal(options.length, 2, `archived call points are not offered: ${options}`);
  assert.match(options[0], /CP1 – Reception · last tested/);
  await shot(page, "2-alarm-call-point");
  await page.getByRole("option", { name: /CP1 – Reception/ }).click();

  // Performed by: a Manager with a login but no roster entry can be chosen.
  const performer = dialog.getByTestId("select-performed-by");
  await page.waitForFunction(() => document.querySelector('[data-testid="select-performed-by"]')?.textContent?.includes("Leanne Elliot"));
  assert.deepEqual(await performer.locator("option").allInnerTexts(),
    ["Select a staff member", "Duty Manager", "Leanne Elliot", "Sam Green", "Other / enter name…"],
    "logins only, A to Z; roster staff are typed in");
  assert.equal(await performer.evaluate(select => select.selectedOptions[0].textContent), "Duty Manager", "starts on the signed-in person");
  assert.equal(await dialog.getByTestId("input-performed-by-custom").count(), 0);
  assert.ok(assigneeRequests.includes("1"), "logins are listed for the record's site");
  await performer.selectOption({ label: "Leanne Elliot" });

  // Sound level: CP1 is near a sleeping area, so the 75 dB bedhead limit applies.
  const bedhead = dialog.getByTestId("checkbox-sound-level-bedhead");
  assert.equal(await bedhead.getAttribute("data-state"), "checked", "a sleeping-area call point sets the bedhead limit");
  const measure = dialog.getByTestId("button-measure-sound");
  await measure.click();
  await page.waitForFunction(() => /^\d+$/.test(document.querySelector('[data-testid="input-sound-level"]')?.value ?? ""), null, { timeout: 15_000 });
  assert.match(await dialog.getByTestId("select-sound-level-method").innerText(), /phone \(rough guide\)/);
  assert.match(await dialog.getByTestId("sound-level-field").innerText(), /isn't set up yet/);
  await dialog.getByTestId("input-sound-level").fill("70");
  await dialog.getByTestId("select-sound-level-method").click();
  await page.getByRole("option", { name: "From a sound meter" }).click();
  const verdict = dialog.getByTestId("sound-level-verdict");
  assert.equal(await verdict.getAttribute("data-verdict"), "low");
  assert.match(await verdict.innerText(), /Too quiet: needs at least 75 dB/);
  await bedhead.click();
  assert.equal(await verdict.getAttribute("data-verdict"), "ok", "70 dB is enough in a general area");
  await bedhead.click();
  await dialog.getByTestId("input-sound-level").fill("7");
  assert.equal(await dialog.getByRole("button", { name: "Record Check" }).isDisabled(), true, "an impossible level cannot be saved");
  await dialog.getByTestId("input-sound-level").fill("70");
  await shot(page, "2b-alarm-sound-level");
  await dialog.getByRole("button", { name: "Record Check" }).click();
  await dialog.waitFor({ state: "hidden" });
  const alarmPost = posts.at(-1);
  assert.equal(alarmPost.body.checkType, "alarm");
  assert.equal(alarmPost.body.callPointId, 11);
  assert.equal(alarmPost.body.siteId, 1, "a one-site business records against its site");
  assert.equal(alarmPost.body.performedBy, "Leanne Elliot");
  assert.equal(alarmPost.body.staffRosterId, null, "a login with no roster entry links no roster record");
  assert.deepEqual([alarmPost.body.soundLevelDb, alarmPost.body.soundLevelMethod, alarmPost.body.soundLevelBedhead], [70, "meter", true]);
  const soundLine = page.getByTestId(`sound-level-${checks.at(-1).id}`);
  await soundLine.waitFor();
  assert.match(await soundLine.innerText(), /Sound level: 70 dB at a bedhead \(sound meter\)\s*Too quiet: needs at least 75 dB/);
  console.log("ok - the alarm test picks the next call point in the order, measures or takes a typed sound level, and flags a quiet one");

  // ── Emergency lighting: the 5 minute flick test ──────────────────────────
  dialog = await openRecordDialog(page, "Monthly emergency lighting flick test");
  await dialog.getByText("Monthly 5 minute flick test.").waitFor();
  assert.equal(await dialog.getByTestId("select-call-point").count(), 0);
  await shot(page, "3-emergency-lighting");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  console.log("ok - the emergency lighting test explains the 5 minute flick test");

  // ── Retired checks: not offered, not due, older records kept ─────────────
  dialog = await openRecordDialog(page);
  await dialog.getByRole("combobox").first().click();
  await page.getByRole("option", { name: "Weekly fire alarm test" }).waitFor();
  assert.equal(await page.getByRole("option", { name: "Alarm panel check" }).count(), 0, "the alarm panel is on the opening and closing checks");
  for (const name of ["Annual 3-hour emergency lighting discharge test", "6-monthly fire alarm service", "Annual fire extinguisher service"]) {
    assert.equal(await page.getByRole("option", { name }).count(), 0, `${name} is its compliance check`);
  }
  await page.keyboard.press("Escape");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  const statusText = await page.locator("body").innerText();
  assert.match(statusText, /Alarm panel check/, "the older alarm panel record stays in the history");
  await page.getByText("Filter History").waitFor();
  await page.getByRole("combobox").filter({ hasText: "All types" }).click();
  await page.getByText("No longer recorded here").waitFor();
  await page.getByRole("option", { name: "Alarm panel check" }).waitFor();
  await page.keyboard.press("Escape");
  console.log("ok - the alarm panel check and the contractor services are no longer offered or due; older records stay in the history");

  // ── Contractor services: the compliance checks' own status ───────────────
  const contractorCard = page.getByTestId("track-contractor-checks-fire");
  await contractorCard.waitFor();
  const contractorRows = contractorCard.getByTestId("contractor-check-row");
  assert.equal(await contractorRows.count(), 4, "one row per fire contractor check, none for other tracks or other checks");
  const rowFor = (label) => contractorRows.filter({ hasText: label });
  assert.equal(await rowFor("Fire alarm service").getAttribute("data-rag"), "red");
  assert.match(await rowFor("Fire alarm service").innerText(), /Certificate outstanding[\s\S]*Contractor: Alarm Co/);
  assert.equal(await rowFor("Fire alarm service").getAttribute("href"), "/items/61");
  assert.equal(await rowFor("Fire extinguisher service").getAttribute("data-rag"), "amber", "a business-wide check counts at the site");
  assert.equal(await rowFor("Emergency lighting 3-hour test").getAttribute("data-rag"), "green");
  assert.match(await rowFor("Emergency lighting 3-hour test").innerText(), /in house by Sam Patel/);
  assert.equal(await rowFor("Fire risk assessment review").getAttribute("data-rag"), "grey");
  assert.match(await rowFor("Fire risk assessment review").innerText(), /No contractor needed/, "as marked on the Contractors page");
  await contractorCard.scrollIntoViewIfNeeded();
  await shot(page, "7-contractor-checks");
  console.log("ok - FireTrack shows its contractor services red, amber or green from their compliance checks, each opening the check");

  // ── Drill: night staff answer required ───────────────────────────────────
  dialog = await openRecordDialog(page, "Fire drill (6-monthly, with night staff)");
  const save = dialog.getByRole("button", { name: "Record Check" });
  assert.equal(await save.isDisabled(), true, "a drill cannot be saved without its details");
  await dialog.getByText("Give the time of the drill").waitFor();
  await dialog.getByTestId("input-drill-time").fill("14:30");
  await dialog.getByText("Give the time taken to evacuate").waitFor();
  await dialog.getByTestId("input-evacuation-minutes").fill("2");
  await dialog.getByTestId("input-evacuation-seconds").fill("75");
  await dialog.getByText("Enter minutes, and seconds from 0 to 59.").waitFor();
  await dialog.getByTestId("input-evacuation-seconds").fill("35");
  await dialog.getByText("Say whether night staff were included (Yes, No or N/A)").waitFor();
  await dialog.getByText("Night staff included?").waitFor();
  assert.deepEqual(
    await dialog.getByRole("radiogroup", { name: "Night staff included" }).getByRole("radio").allInnerTexts(),
    ["Yes", "No", "N/A"]);
  await dialog.getByTestId("night-staff-no_night_staff").click();
  await dialog.getByText("N/A: this site has no night staff.").waitFor();
  await dialog.getByTestId("night-staff-not_included").click();
  await dialog.getByText("Plan the next drill so night staff take part.").waitFor();
  await shot(page, "4-drill-night-staff");
  await dialog.getByTestId("night-staff-included").click();
  await dialog.getByText("Write the improvements required, or notes").waitFor();
  assert.equal(await save.isDisabled(), true, "the improvements required / notes box is required on a drill");
  // The one site is chosen, so its staff and staff with no site are listed.
  const picker = dialog.getByTestId("drill-staff-picker");
  assert.match(await picker.innerText(), /Ann Able[\s\S]*Bob Brown[\s\S]*Cat Cole/);
  await picker.getByText("0 of 3 ticked").waitFor();
  await dialog.getByTestId("drill-staff-31").click();
  await dialog.getByTestId("drill-staff-32").click();
  await picker.getByText("2 of 3 ticked").waitFor();
  await dialog.getByLabel("Improvements required / notes").fill("Fire door on the first floor slow to close");
  await shot(page, "4b-drill-details");
  assert.equal(await save.isDisabled(), false);
  await save.click();
  await dialog.waitFor({ state: "hidden" });
  const sent = posts.at(-1).body;
  assert.equal(sent.checkType, "fire_drill");
  assert.equal(sent.nightStaff, "included");
  assert.equal(sent.drillTime, "14:30");
  assert.equal(sent.evacuationSeconds, 155);
  assert.deepEqual(sent.staffPresentIds, [31, 32]);
  assert.equal(sent.notes, "Fire door on the first floor slow to close");
  await page.getByTestId("drill-attendance-card").getByText("1 of 3 staff has not taken part").waitFor();
  console.log("ok - a drill records its time, evacuation time, night staff (Yes, No or N/A), staff present and the improvements required");

  // ── Without a list, the call point is typed in and required ──────────────
  callPoints.splice(0, callPoints.length);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByText("Monthly emergency lighting flick test").first().waitFor();
  dialog = await openRecordDialog(page, "Weekly fire alarm test");
  const typed = dialog.getByTestId("input-call-point");
  await typed.waitFor();
  assert.equal(await dialog.getByRole("button", { name: "Record Check" }).isDisabled(), true);
  await typed.fill("Front door");
  await dialog.getByRole("button", { name: "Record Check" }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.equal(posts.at(-1).body.callPoint, "Front door");
  assert.equal(posts.at(-1).body.callPointId, null);
  console.log("ok - without a list the call point is typed in, and is required");

  // ── Managers add call points under Template ──────────────────────────────
  await page.getByRole("button", { name: "Template" }).click();
  const template = page.getByRole("dialog");
  await template.getByTestId("tab-fire-call-points").click();
  await template.getByText("No call points listed yet.").waitFor();
  await template.getByPlaceholder('Call point, e.g. "CP1"').fill("CP4");
  await template.getByPlaceholder("Location, e.g. Reception, main entrance").fill("Bar");
  await template.getByRole("button", { name: "Add" }).click();
  await template.locator('input[value="CP4"]').waitFor();
  assert.deepEqual(posts.at(-1), { path: "/api/fire-safety/call-points", body: { siteId: 1, name: "CP4", location: "Bar" } });
  await template.getByPlaceholder('Call point, e.g. "CP1"').fill("CP5");
  await template.getByRole("button", { name: "Add" }).click();
  await template.locator('input[value="CP5"]').waitFor();
  console.log("ok - managers add a site's call points with their location under Template");

  // ── The order changes with the arrows ────────────────────────────────────
  const cp5Row = template.locator('[data-testid^="call-point-row-"]').nth(1);
  await cp5Row.getByRole("button", { name: "Move up" }).click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid^="call-point-row-"] input[aria-label="Call point name"]')[0]?.value === "CP5");
  const orderPost = posts.at(-1);
  assert.equal(orderPost.path, "/api/fire-safety/call-points/order");
  assert.equal(orderPost.body.siteId, 1);
  assert.equal(orderPost.body.ids.length, 2);
  assert.equal(callPoints.find(p => p.id === orderPost.body.ids[0]).name, "CP5");
  await template.getByText("Tested in this order, from the top.").waitFor();
  await shot(page, "5-template-call-points");
  console.log("ok - managers change the test order with the arrows");

  // ── A list can be uploaded from a spreadsheet ────────────────────────────
  await template.getByTestId("button-import-fire-call-points").click();
  const upload = page.getByRole("dialog", { name: "Upload call points" });
  await upload.getByText("List them in the order you want them tested").waitFor();
  await upload.getByTestId("input-fire-call-points-file").setInputFiles({
    name: "call-points.csv", mimeType: "text/csv", buffer: Buffer.from("Call point,Location\r\nCP6,Lift lobby\r\nCP7,Plant room\r\n"),
  });
  await upload.getByTestId("import-summary").waitFor();
  const uploadPost = posts.at(-1);
  assert.equal(uploadPost.path, "/api/imports/fire-call-points");
  assert.deepEqual(uploadPost.body, { headers: ["Call point", "Location"], rows: [["CP6", "Lift lobby"], ["CP7", "Plant room"]], preview: true, siteId: 1 });
  assert.match(await upload.getByTestId("button-confirm-fire-call-points-import").innerText(), /Import 2 call points/);
  await shot(page, "8-upload-call-points");
  await upload.getByRole("button", { name: "Cancel" }).click();
  console.log("ok - a call point list can be uploaded, with a preview first");

  // ── Walk round and speak (typed here; the browser's dictation fills the same box) ──
  await template.getByTestId("button-walk-round-call-points").click();
  const walk = page.getByRole("dialog", { name: /Walk round and speak/ });
  await walk.getByTestId("walk-round-examples").waitFor();
  await walk.getByTestId("walk-round-text").fill("this is call point 6 by the lift lobby this is call point 7 in the plant room\nback stairs");
  await walk.getByTestId("walk-round-row-2").waitFor();
  const names = await walk.locator('[data-testid^="walk-round-row-"] input[aria-label="Name"]').evaluateAll(inputs => inputs.map(input => input.value));
  const places = await walk.locator('[data-testid^="walk-round-row-"] input[aria-label="Location"]').evaluateAll(inputs => inputs.map(input => input.value));
  assert.deepEqual(names, ["CP6", "CP7", "CP8"], "unnumbered points carry on from the highest number");
  assert.deepEqual(places, ["By the lift lobby", "Plant room", "Back stairs"]);
  await walk.getByTestId("walk-round-row-2").getByLabel("Location").fill("Back stairs, first floor");
  await walk.getByTestId("walk-round-row-1").getByRole("button", { name: "Leave this one out" }).click();
  await shot(page, "9-walk-round");
  await walk.getByTestId("walk-round-save").click();
  await walk.waitFor({ state: "hidden" });
  const walkPost = posts.at(-1);
  assert.equal(walkPost.path, "/api/imports/fire-call-points");
  assert.deepEqual(walkPost.body, { headers: ["Call point", "Location"], rows: [["CP6", "By the lift lobby"], ["CP8", "Back stairs, first floor"]], siteId: 1, preview: false });
  console.log("ok - walking round and speaking makes the call point list in the order spoken");

  // ── A consultant opens a free business from their core-only one ────────
  asConsultant = true;
  const openConsultantPage = async (openClientId) => {
    const consultantContext = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-GB", timezoneId: "Europe/London" });
    if (openClientId !== null) {
      await consultantContext.addInitScript(value => sessionStorage.setItem("complytrack:activeClient", value), JSON.stringify({ userId: 8, clientId: openClientId }));
    }
    const consultantPage = await consultantContext.newPage();
    consultantPage.setDefaultTimeout(20000);
    consultantPage.on("pageerror", error => pageErrors.push(error.message));
    await consultantPage.route("**/api/**", routeApi);
    await consultantPage.goto(`${baseUrl}/tests/fire-track-harness.html`, { waitUntil: "domcontentloaded" });
    return consultantPage;
  };
  const homePage = await openConsultantPage(null);
  await homePage.getByRole("button", { name: "Enable FireTrack" }).waitFor();
  await homePage.context().close();
  const freePage = await openConsultantPage(CLIENT_ID);
  await freePage.getByText("Monthly emergency lighting flick test").first().waitFor();
  assert.equal(await freePage.getByRole("button", { name: "Enable FireTrack" }).count(), 0, "FireTrack is open in the free business");
  await shot(freePage, "10-consultant-free-business");
  await freePage.context().close();
  console.log("ok - a consultant sees FireTrack in a free business though their own has only core");

  assert.deepEqual(pageErrors, []);
  assert.deepEqual([...new Set(unexpectedRequests)], [], "every request is in the fixture");
  console.log("FireTrack browser checks passed.");
} catch (error) {
  console.error("FireTrack page:", browser ? await browser.contexts()[0]?.pages()[0]?.locator("body").innerText().catch(() => "") : "");
  throw error;
} finally {
  await browser?.close();
  vite.kill("SIGTERM");
}
