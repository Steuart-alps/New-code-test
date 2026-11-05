import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { chromium } from "@playwright/test";

// Clickable column headings on the Incidents list: each heading sorts the
// list, filters it with a dropdown-style list, or searches it, and the
// heading filters stay in step with the filter bar above the list.
// Fixtures and API stubs follow tests/incident-export-browser.test.mjs.
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

const SITES = [{ id: 1, name: "Harbour Hotel" }, { id: 2, name: "Riverside Depot" }];
const INCIDENT_TYPES = ["accident", "near_miss", "dangerous_occurrence", "occupational_disease", "slip_trip"];
const LABELS = {
  status: { open: "Open", under_investigation: "Under Investigation", closed: "Closed" },
  severity: { minor: "Minor", moderate: "Moderate", serious: "Serious", fatal: "Fatal" },
  type: {
    accident: "Accident", near_miss: "Near Miss", dangerous_occurrence: "Dangerous Occurrence",
    occupational_disease: "Occupational Disease", slip_trip: "Slip Trip",
  },
};

const incident = (id, incidentDate, incidentTime, incidentType, severity, status, siteId, riddor, person, location, description, reportedBy) => ({
  id, clientId: 23, siteId, incidentType, severity, status, incidentDate, incidentTime,
  location, description,
  involvedName: person.name, involvedJobTitle: person.job ?? null, involvedEmploymentType: person.employment ?? "employee",
  injuriesSustained: null, firstAidGiven: false, firstAiderName: null, witnesses: null,
  riddorReportable: riddor !== null, reportedToHse: riddor?.reported ?? false,
  hseReference: riddor?.ref ?? null, hseReportDate: riddor?.reported ? incidentDate : null,
  immediateActions: null, investigationFindings: null, correctiveActions: null,
  reportedBy, createdAt: `${incidentDate}T12:00:00.000Z`,
});
const outstanding = { reported: false };
const reported = ref => ({ reported: true, ref });

// Every filter value has matches and non-matches; dates sit on month boundaries
// so inclusive from/to handling is exercised; search terms hit each searched
// field (name, location, description, reported by) on its own.
const INCIDENTS = [
  incident(1, "2026-01-05", "08:15", "accident", "minor", "open", 1, null, { name: "Amira Khan", job: "Chef" }, "Main kitchen", "Cut finger on mandoline", "Duty Manager"),
  incident(2, "2026-01-31", null, "near_miss", "minor", "closed", 2, null, { name: "Ben Ortiz", employment: "contractor" }, "Loading bay", "Pallet nearly fell from racking", "Site Supervisor"),
  incident(3, "2026-02-01", "14:00", "accident", "serious", "under_investigation", 1, outstanding, { name: "Cara Lewis", job: "Porter" }, "Cellar stairs", "Fell down stairs, fractured wrist", "Duty Manager"),
  incident(4, "2026-02-14", null, "dangerous_occurrence", "serious", "open", 2, reported("RID-2026-0042"), { name: "Dev Patel", job: "Forklift driver" }, "Yard", "Forklift overturned", "Transport Lead"),
  incident(5, "2026-02-28", "09:00", "occupational_disease", "moderate", "closed", 1, reported(null), { name: "Ella Brown", job: "Cleaner" }, "Laundry", "Dermatitis from detergent", "HR Officer"),
  incident(6, "2026-03-01", null, "accident", "fatal", "under_investigation", 2, outstanding, { name: "Finn O'Neil", job: "Electrician", employment: "contractor" }, "Plant room", "Electrocution during maintenance", "Site Supervisor"),
  incident(7, "2026-03-01", "23:45", "slip_trip", "minor", "open", null, null, { name: "Gwen Stacey", employment: "visitor" }, "Reception", "Slipped on wet floor near lift", "Front Desk"),
  incident(8, "2026-03-15", null, "near_miss", "moderate", "open", 1, null, { name: "Harry Lime", job: "Barista" }, "Bar & Grill <terrace>", "Hot water splash, no injury", "Duty Manager"),
  incident(9, "2026-03-31", "11:30", "accident", "moderate", "closed", 2, outstanding, { name: "Isla Grant", job: "Warehouse operative" }, "Mezzanine", "Over-7-day back injury lifting boxes", "Transport Lead"),
  incident(10, "2026-04-01", null, "dangerous_occurrence", "fatal", "closed", 1, reported("RID-2026-0099"), { name: "Jon Snow", employment: "member_of_public" }, "Car park", "Scaffold collapse onto public path", "Facilities Manager"),
  incident(11, "2026-04-10", "16:20", "occupational_disease", "serious", "open", 2, null, { name: "Kemi Ade", job: "Painter", employment: "contractor" }, "Paint store", "Respiratory irritation reported", "Site Supervisor"),
  incident(12, "2026-04-30", null, "slip_trip", "moderate", "under_investigation", 1, null, { name: "Liam Hart", job: "Waiter" }, "Restaurant", "Tripped on loose carpet", "Duty Manager"),
  incident(13, "2026-05-02", null, "near_miss", "serious", "closed", null, null, { name: "Mia Wong", job: "Delivery driver", employment: "contractor" }, "Service road", "Reversing lorry close call", "Front Desk"),
  incident(14, "2026-05-20", "07:05", "accident", "minor", "under_investigation", 2, null, { name: "Noah Reid", job: "Picker" }, "Aisle 7", "Bruised arm on trolley HAYSTACK-TOKEN", "Transport Lead"),
  incident(15, "2026-06-01", null, "accident", "serious", "open", 1, outstanding, { name: "Olivia Ross", job: "Housekeeper" }, "Room 214", "Specified injury from fall", "REPORTER-ONLY-TOKEN Night Manager"),
];
// The register API returns newest first.
const API_INCIDENTS = [...INCIDENTS].sort((a, b) => b.incidentDate.localeCompare(a.incidentDate) || b.id - a.id);

// Independent statement of the filter rules from the IncidentTrack spec: every
// filter narrows the register, date bounds are inclusive and search matches
// person, location, description or reporter case-insensitively.
function expectedRecords(filters) {
  return INCIDENTS.filter(r =>
    (!filters.status || r.status === filters.status) &&
    (!filters.severity || r.severity === filters.severity) &&
    (!filters.type || r.incidentType === filters.type) &&
    (!filters.site || r.siteId === filters.site) &&
    (!filters.from || r.incidentDate >= filters.from) &&
    (!filters.to || r.incidentDate <= filters.to) &&
    (!filters.riddor || r.riddorReportable) &&
    (!filters.search || [r.involvedName, r.location, r.description, r.reportedBy]
      .some(field => field.toLowerCase().includes(filters.search.toLowerCase()))));
}

const CASES = [
  { name: "no filters", filters: {} },
  ...Object.keys(LABELS.status).map(status => ({ name: `status ${status}`, filters: { status } })),
  ...Object.keys(LABELS.severity).map(severity => ({ name: `severity ${severity}`, filters: { severity } })),
  ...INCIDENT_TYPES.map(type => ({ name: `type ${type}`, filters: { type } })),
  ...SITES.map(site => ({ name: `site ${site.name}`, filters: { site: site.id } })),
  { name: "from date only (inclusive)", filters: { from: "2026-03-01" } },
  { name: "to date only (inclusive)", filters: { to: "2026-03-01" } },
  { name: "single-day range", filters: { from: "2026-03-01", to: "2026-03-01" } },
  { name: "month range excludes neighbouring days", filters: { from: "2026-02-01", to: "2026-02-28" } },
  { name: "RIDDOR only", filters: { riddor: true } },
  { name: "search by person, any case", filters: { search: "aMIRA" } },
  { name: "search by location", filters: { search: "LOADING bay" } },
  { name: "search by description only", filters: { search: "haystack-token" } },
  { name: "search by reporter only", filters: { search: "reporter-only" } },
  { name: "search matching several records", filters: { search: "duty manager" } },
  { name: "search with HTML characters", filters: { search: "<terrace>" } },
  { name: "site + status + RIDDOR", filters: { site: 1, status: "open", riddor: true } },
  { name: "date range + RIDDOR", filters: { from: "2026-02-01", to: "2026-03-31", riddor: true } },
  { name: "date range + severity + type", filters: { from: "2026-02-01", to: "2026-04-30", severity: "serious", type: "accident" } },
  { name: "site + search + to date", filters: { site: 2, search: "site supervisor", to: "2026-03-31" } },
  { name: "every filter at once", filters: { site: 2, status: "closed", severity: "moderate", type: "accident", from: "2026-03-01", to: "2026-03-31", riddor: true, search: "back" } },
  { name: "combination with no matches", filters: { site: 1, type: "dangerous_occurrence", status: "open" } },
];

// ─── API fixture ─────────────────────────────────────────────────────────────

let managedBy = null;
const json = (route, data, code = 200) => route.fulfill({ status: code, contentType: "application/json", body: JSON.stringify(data) });
const unexpectedRequests = [];
async function routeApi(route) {
  const request = route.request(), url = new URL(request.url()), method = request.method();
  if (method !== "GET") {
    unexpectedRequests.push(`${method} ${url.pathname}`);
    return json(route, { error: "The export test never writes" }, 501);
  }
  switch (url.pathname) {
    case "/api/auth/csrf-token": return json(route, { token: "incident-export-csrf" });
    case "/api/auth/me": return json(route, {
      user: { id: 5, email: "incident-manager@example.test", name: "Incident Manager", role: "client_admin", clientId: 23, departmentId: null, active: true, totpEnabled: true },
      billingLocked: false, client: { id: 23, name: "Harbour & Co <Leisure>", slug: "harbour", logoUrl: null, primaryColor: "#2F7C8C", active: true },
      services: ["incidenttrack"],
    });
    case "/api/billing/cancellation-status": return json(route, { accessEndsAt: null });
    // The header's notification bell (#92).
    case "/api/notifications": return json(route, { notifications: [], unreadCount: 0 });
    case "/api/managed-by": return json(route, managedBy);
    // Setup is finished, so the "Add your team first" gate stays out of the way.
    case "/api/setup/state": return json(route, { needsSetup: false, canManage: true, team: { recorders: 2, aloneAt: null, ready: true } });
    // The app-wide storage limit banner (#156).
    case "/api/storage/status": return json(route, { state: "not_limited", canManage: true, autoTopUp: false, usedBytes: 0, capacityBytes: null });
    case "/api/sites": return json(route, SITES);
    case "/api/photos": return json(route, []);
    case "/api/photos/requirements": return json(route, []);
    case "/api/track-actions":
    case "/api/track-actions/templates/matching":
    case "/api/track-evidence":
    case "/api/track-evidence/requirements": return json(route, []);
    case "/api/form-options": return json(route, {
      options: { incident_types: INCIDENT_TYPES }, defaults: { incident_types: INCIDENT_TYPES.slice(0, 4) },
      disabled: {}, customised: { incident_types: true },
    });
    case "/api/incidents/config": return json(route, {
      incident_default_reporter: "", incident_locations: "[]", incident_departments: "[]", incident_show_investigation: "true",
    });
    case "/api/incidents": return json(route, API_INCIDENTS);
    case "/api/incidents/summary": {
      const riddor = INCIDENTS.filter(r => r.riddorReportable);
      return json(route, {
        total: INCIDENTS.length,
        openCount: INCIDENTS.filter(r => r.status === "open").length,
        investigatingCount: INCIDENTS.filter(r => r.status === "under_investigation").length,
        riddorCount: riddor.length,
        riddorOutstanding: riddor.filter(r => !r.reportedToHse).length,
        thisMonth: 0,
        seriousCount: INCIDENTS.filter(r => r.severity === "serious" || r.severity === "fatal").length,
      });
    }
    default:
      unexpectedRequests.push(`${method} ${url.pathname}`);
      return json(route, { error: "Not in the incident export fixture" }, 404);
  }
}

// Records each print iframe printHtmlDocument opens, keeps the HTML the browser
// actually loaded for printing, and swaps the print dialog for a recorder.

// ─── Page helpers ────────────────────────────────────────────────────────────

const normalise = text => text.replace(/\s+/g, " ").trim();
const SCREEN_RIDDOR = { Reported: "reported", Outstanding: "outstanding", "—": "no" };

async function openRegister(page) {
  await page.goto(`${baseUrl}/tests/incident-export-harness.html`, { waitUntil: "domcontentloaded" });
  // The register starts on the user's working site (an Owner's first site);
  // these checks start from All sites.
  await page.getByRole("combobox", { name: "Filter incidents by site" }).getByText(SITES[0].name).waitFor();
  await choose(page, "Filter incidents by site", "All sites");
  await page.getByText(`Showing ${INCIDENTS.length} of ${INCIDENTS.length} records`).waitFor();
}

async function choose(page, filterName, optionLabel) {
  await page.getByRole("combobox", { name: filterName }).click();
  await page.getByRole("option", { name: optionLabel, exact: true }).click();
  await page.getByRole("listbox").waitFor({ state: "detached" });
}


const rows = page => page.locator("#root table tbody tr").evaluateAll(trs => trs.map(tr => [...tr.cells].map(c => c.innerText.trim())));
const people = async page => (await rows(page)).map(r => r[2].split("\n")[0]);
const heading = (page, label) => page.getByRole("button", { name: new RegExp(`^Sort and filter by ${label}`) });
async function pick(page, label, option) {
  await heading(page, label).click();
  await page.getByRole("dialog").getByRole("button", { name: option, exact: true }).click();
}
const closePopover = page => page.keyboard.press("Escape");
const SEVERITY_RANK = { fatal: 0, serious: 1, moderate: 2, minor: 3 };

try {
  await waitForVite();
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"], executablePath: chromiumPath() });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: "en-GB", timezoneId: "Europe/London", deviceScaleFactor: Number(process.env.SHOT_SCALE ?? 1) });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.route("**/api/**", routeApi);
  const shots = process.env.SCREENSHOT_DIR;

  await openRegister(page);
  // Newest first by default.
  const byDate = [...API_INCIDENTS].map(r => r.involvedName);
  assert.deepEqual(await people(page), byDate, "the list starts newest first");

  // Person, A to Z.
  await pick(page, "Person Involved", "A to Z");
  assert.deepEqual(await people(page), [...INCIDENTS].map(r => r.involvedName).sort((a, b) => a.localeCompare(b)), "Person sorts A to Z");
  assert.equal(await page.locator("th", { has: heading(page, "Person Involved") }).getAttribute("aria-sort"), "ascending");

  // Severity, most serious first (newest first among equals is not promised; check the ranks only).
  await pick(page, "Type / Severity", "Severity, most serious first");
  const severityOrder = (await rows(page)).map(r => r[1].split("\n")[1].trim().toLowerCase());
  const ranks = severityOrder.map(s => SEVERITY_RANK[s]);
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b), "Severity sorts most serious first");

  // Type filter from the heading: a dropdown-style list, kept in step with the filter bar.
  await pick(page, "Type / Severity", "Near Miss");
  await closePopover(page);
  const nearMisses = INCIDENTS.filter(r => r.incidentType === "near_miss").length;
  await page.getByText(`Showing ${nearMisses} of ${INCIDENTS.length} records`).waitFor();
  assert.ok((await rows(page)).every(r => r[1].startsWith("Near Miss")), "only near misses are listed");
  assert.equal(await page.getByRole("combobox", { name: "Filter incidents by type" }).innerText(), "Near Miss", "the filter bar shows the heading's choice");
  assert.match(await heading(page, "Type / Severity").getAttribute("aria-label"), /filtered/);
  if (shots) {
    await heading(page, "Type / Severity").click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${shots}/incidents-type-heading.png` });
    await closePopover(page);
  }
  await heading(page, "Type / Severity").click();
  await page.getByRole("dialog").getByRole("button", { name: "Clear" }).click();
  await closePopover(page);
  await page.getByText(`Showing ${INCIDENTS.length} of ${INCIDENTS.length} records`).waitFor();

  // Status filter.
  await pick(page, "Status", "Open");
  await closePopover(page);
  const open = INCIDENTS.filter(r => r.status === "open").length;
  await page.getByText(`Showing ${open} of ${INCIDENTS.length} records`).waitFor();
  await heading(page, "Status").click();
  await page.getByRole("dialog").getByRole("button", { name: "All statuses", exact: true }).click();
  await closePopover(page);

  // Person search box in the heading: typing keeps the box open and narrows the list.
  await heading(page, "Person Involved").click();
  const search = page.getByRole("dialog").getByLabel("Search person involved");
  await search.pressSequentially("amira");
  assert.equal(await search.inputValue(), "amira", "the heading search box stays open while typing");
  await closePopover(page);
  await page.getByText(`Showing 1 of ${INCIDENTS.length} records`).waitFor();
  assert.deepEqual(await people(page), ["Amira Khan"]);
  if (shots) await page.screenshot({ path: `${shots}/incidents-person-search.png` });

  // Nothing matching: the headings stay so the filter can be cleared.
  await heading(page, "Person Involved").click();
  await page.getByRole("dialog").getByLabel("Search person involved").fill("nobody-matches");
  await closePopover(page);
  await page.getByText("No records match the current filters.").waitFor();
  await page.getByRole("button", { name: /Total/ }).first().click();
  await page.getByText(`Showing ${INCIDENTS.length} of ${INCIDENTS.length} records`).waitFor();

  // Date range in the Date heading matches the filter bar's dates.
  await heading(page, "Date").click();
  await page.getByRole("dialog").getByLabel("Date column from").fill("2026-03-01");
  await page.getByRole("dialog").getByLabel("Date column to").fill("2026-03-31");
  await closePopover(page);
  assert.equal(await page.getByLabel("Incidents from date").inputValue(), "2026-03-01");
  const march = INCIDENTS.filter(r => r.incidentDate >= "2026-03-01" && r.incidentDate <= "2026-03-31").length;
  await page.getByText(`Showing ${march} of ${INCIDENTS.length} records`).waitFor();

  assert.deepEqual(unexpectedRequests, []);
  assert.deepEqual(pageErrors, []);
  console.log("Column heading browser checks passed: Incidents headings sort (date, person, severity), filter (type, status, dates) in step with the filter bar, and search (person) with the box staying open while typing.");
} finally {
  await browser?.close();
  vite.kill("SIGTERM");
}
