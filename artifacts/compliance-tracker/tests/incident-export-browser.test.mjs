import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { chromium } from "@playwright/test";

// Screen-level regression for the IncidentTrack register PDF export. The PDF is
// assembled in the browser from the records visible on screen, so for every
// filter (and combinations of them) this checks that the on-screen register,
// the exported rows and the RIDDOR-outstanding footer all describe the same
// records, and that an invalid date range never opens the print flow.
// API responses mirror artifacts/api-server/src/routes/incidents.ts.
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
function capturePrints() {
  window.__incidentPrints = [];
  const appendChild = Node.prototype.appendChild;
  Node.prototype.appendChild = function (node) {
    if (node instanceof HTMLIFrameElement && node.src.startsWith("blob:")) {
      const entry = { html: null, printed: false };
      window.__incidentPrints.push(entry);
      const onload = node.onload;
      node.onload = function (event) {
        const frameWindow = node.contentWindow;
        entry.html = frameWindow.document.documentElement.outerHTML;
        frameWindow.print = () => { entry.printed = true; };
        return onload?.call(this, event);
      };
    }
    return appendChild.call(this, node);
  };
}

// ─── Page helpers ────────────────────────────────────────────────────────────

const normalise = text => text.replace(/\s+/g, " ").trim();
const SCREEN_RIDDOR = { Reported: "reported", Outstanding: "outstanding", "—": "no" };

async function openRegister(page) {
  await page.goto(`${baseUrl}/tests/incident-export-harness.html`, { waitUntil: "domcontentloaded" });
  await page.getByText(`Showing ${INCIDENTS.length} of ${INCIDENTS.length} records`).waitFor();
}

async function choose(page, filterName, optionLabel) {
  await page.getByRole("combobox", { name: filterName }).click();
  await page.getByRole("option", { name: optionLabel, exact: true }).click();
  await page.getByRole("listbox").waitFor({ state: "detached" });
}

async function applyFilters(page, filters) {
  if (filters.site) await choose(page, "Filter incidents by site", SITES.find(s => s.id === filters.site).name);
  if (filters.status) await choose(page, "Filter incidents by status", LABELS.status[filters.status]);
  if (filters.severity) await choose(page, "Filter incidents by severity", LABELS.severity[filters.severity]);
  if (filters.type) await choose(page, "Filter incidents by type", LABELS.type[filters.type]);
  if (filters.from) await page.getByLabel("Incidents from date").fill(filters.from);
  if (filters.to) await page.getByLabel("Incidents to date").fill(filters.to);
  if (filters.riddor) {
    const toggle = page.getByRole("button", { name: "RIDDOR only" });
    await toggle.click();
    assert.equal(await toggle.getAttribute("aria-pressed"), "true");
  }
  if (filters.search) await page.getByPlaceholder("Search name, location, description…").fill(filters.search);
}

// The visible register rows, read from the rendered table.
async function screenRows(page) {
  if (await page.getByText("No records match the current filters.").count()) return [];
  return page.locator("#root table tbody tr").evaluateAll(rows => rows.map(row => {
    const cells = [...row.cells].map(cell => cell.innerText);
    return { date: cells[0], typeSeverity: cells[1], person: cells[2], location: cells[3], riddor: cells[6] };
  }));
}

async function exportRegister(page) {
  const before = await page.evaluate(() => window.__incidentPrints.length);
  await page.getByRole("button", { name: "Export PDF" }).click();
  await page.waitForFunction(count => window.__incidentPrints.length > count && window.__incidentPrints.at(-1).printed, before);
  return page.evaluate(() => {
    const html = window.__incidentPrints.at(-1).html;
    const doc = new DOMParser().parseFromString(html, "text/html");
    const text = el => {
      const clone = el.cloneNode(true);
      clone.querySelectorAll("br").forEach(br => br.replaceWith("\n"));
      return clone.textContent;
    };
    return {
      html,
      meta: [...doc.querySelectorAll(".meta")].map(el => el.textContent),
      empty: doc.querySelector(".empty")?.textContent ?? null,
      header: [...doc.querySelectorAll("table tr:first-child th")].map(th => th.textContent),
      rows: [...doc.querySelectorAll("table tr")].slice(1).map(tr => [...tr.cells].map(text)),
      footer: doc.querySelector(".footer")?.textContent ?? null,
      injected: doc.querySelectorAll("terrace, leisure").length,
    };
  });
}

const footerText = count => `RIDDOR outstanding: ${count === 0
  ? "None in the exported records."
  : `${count} item${count === 1 ? "" : "s"} require${count === 1 ? "s" : ""} HSE reporting.`}`;
const fmt = iso => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

function assertExportMatchesScreen(label, filters, screen, exported) {
  const expected = expectedRecords(filters);
  const expectedNames = expected.map(r => r.involvedName).sort();
  const screenNames = screen.map(r => r.person.split("\n")[0].trim()).sort();
  const exportNames = exported.rows.map(cells => cells[3].split("\n")[0].trim()).sort();
  assert.deepEqual(screenNames, expectedNames, `${label}: on-screen register shows the filtered records`);
  assert.deepEqual(exportNames, screenNames, `${label}: export rows are exactly the visible records`);

  // Row by row, the export carries the same facts the manager can see.
  const screenByName = new Map(screen.map(r => [r.person.split("\n")[0].trim(), r]));
  for (const [date, type, severity, person, location, riddor] of exported.rows) {
    const name = person.split("\n")[0].trim();
    const onScreen = screenByName.get(name);
    const record = expected.find(r => r.involvedName === name);
    assert.equal(normalise(date), normalise(onScreen.date), `${label}: ${name} date`);
    assert.equal(normalise(`${type} ${severity}`), normalise(onScreen.typeSeverity), `${label}: ${name} type and severity`);
    assert.equal(normalise(person), normalise(onScreen.person), `${label}: ${name} person details`);
    assert.equal(location.split("\n")[0].trim(), onScreen.location.trim(), `${label}: ${name} location`);
    const site = SITES.find(s => s.id === record.siteId);
    assert.equal(location.split("\n")[1]?.trim(), site?.name, `${label}: ${name} site`);
    const screenRiddor = SCREEN_RIDDOR[onScreen.riddor.trim()];
    assert.ok(screenRiddor, `${label}: ${name} has a RIDDOR state on screen (${onScreen.riddor})`);
    const exportRiddor = riddor === "No" ? "no" : riddor.includes("outstanding") ? "outstanding" : riddor.startsWith("Yes (reported") ? "reported" : riddor;
    assert.equal(exportRiddor, screenRiddor, `${label}: ${name} RIDDOR status`);
    if (record.hseReference) assert.ok(riddor.includes(record.hseReference), `${label}: ${name} HSE reference`);
  }

  // Newest first, matching the register order.
  const exportDates = exported.rows.map(cells => cells[0]);
  const sortedDates = [...expected].sort((a, b) => b.incidentDate.localeCompare(a.incidentDate)).map(r => r.incidentDate);
  assert.deepEqual(exportDates.map(d => d.slice(0, d.indexOf("2026") + 4)), sortedDates.map(fmt), `${label}: export is newest first`);

  // The footer counts the outstanding RIDDOR reports among the visible records.
  const screenOutstanding = screen.filter(r => SCREEN_RIDDOR[r.riddor.trim()] === "outstanding").length;
  const expectedOutstanding = expected.filter(r => r.riddorReportable && !r.reportedToHse).length;
  assert.equal(screenOutstanding, expectedOutstanding, `${label}: outstanding RIDDOR rows on screen`);
  assert.equal(normalise(exported.footer), footerText(screenOutstanding), `${label}: RIDDOR-outstanding footer`);

  // Header block states the scope the rows were taken from.
  const siteName = filters.site ? SITES.find(s => s.id === filters.site).name : "All sites";
  assert.equal(normalise(exported.meta[0]), `Organisation: Harbour & Co <Leisure> · Site: ${siteName}`, `${label}: organisation and site`);
  const range = `${filters.from ? fmt(filters.from) : "Earliest record"} to ${filters.to ? fmt(filters.to) : "Latest record"}`;
  assert.ok(normalise(exported.meta[1]).startsWith(`Date range: ${range} · Generated`), `${label}: date range`);
  const parts = [
    filters.status && `Status: ${LABELS.status[filters.status]}`,
    filters.severity && `Severity: ${LABELS.severity[filters.severity]}`,
    filters.type && `Type: ${LABELS.type[filters.type]}`,
    filters.riddor && "RIDDOR only",
    filters.search && `Search: "${filters.search}"`,
  ].filter(Boolean).join(" · ");
  const count = `${expected.length} record${expected.length !== 1 ? "s" : ""}`;
  assert.equal(normalise(exported.meta[2]), parts ? `Filters applied — ${parts} · ${count}` : count, `${label}: filter summary`);

  if (expected.length === 0) {
    assert.equal(exported.empty, "No incidents match the current filters.", `${label}: empty export message`);
    assert.equal(exported.rows.length, 0);
  } else {
    assert.deepEqual(exported.header, ["Date", "Type", "Severity", "Person", "Location", "RIDDOR status"]);
  }
  assert.equal(exported.injected, 0, `${label}: user text is escaped in the export`);
}

// ─── Run ─────────────────────────────────────────────────────────────────────

try {
  await waitForVite();
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"], executablePath: chromiumPath() });
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 }, locale: "en-GB", timezoneId: "Europe/London",
  });
  await context.addInitScript(capturePrints);
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.route("**/api/**", routeApi);

  for (const { name, filters } of CASES) {
    await openRegister(page);
    await applyFilters(page, filters);
    // Give the register a moment to settle; a wrong count is reported by the
    // row assertions below rather than as a timeout.
    const expectedCount = expectedRecords(filters).length;
    await (expectedCount > 0
      ? page.getByText(`Showing ${expectedCount} of ${INCIDENTS.length} records`)
      : page.getByText("No records match the current filters.")).waitFor({ timeout: 3000 }).catch(() => {});
    const screen = await screenRows(page);
    const exported = await exportRegister(page);
    assertExportMatchesScreen(name, filters, screen, exported);
  }

  // An inverted date range is refused before anything is sent to print, with
  // or without other filters, and a corrected range exports normally.
  for (const filters of [
    { from: "2026-04-01", to: "2026-03-01" },
    { from: "2026-03-02", to: "2026-03-01", site: 2, riddor: true, search: "a" },
  ]) {
    await openRegister(page);
    await applyFilters(page, filters);
    await page.getByText("No records match the current filters.").waitFor();
    await page.getByRole("button", { name: "Export PDF" }).click();
    await page.waitForTimeout(500);
    assert.equal(await page.evaluate(() => window.__incidentPrints.length), 0, "invalid range does not open the print flow");
    assert.equal(await page.locator("iframe").count(), 0, "no print frame is attached for an invalid range");
    await page.getByText("The from date must be on or before the to date.").first().waitFor({ timeout: 3000 });
    assert.ok(await page.getByText("Invalid date range").first().isVisible(), "invalid range toast is shown");

    const corrected = { ...filters, from: "2026-02-01" };
    await page.getByLabel("Incidents from date").fill(corrected.from);
    const screen = await screenRows(page);
    const exported = await exportRegister(page);
    assert.equal(await page.evaluate(() => window.__incidentPrints.length), 1, "a corrected range opens the print flow once");
    assertExportMatchesScreen(`corrected range ${JSON.stringify(filters)}`, corrected, screen, exported);
  }

  assert.deepEqual(unexpectedRequests, []);
  assert.deepEqual(pageErrors, []);
  console.log(`Incident export browser checks passed: ${CASES.length} filter cases match screen and export (rows and RIDDOR-outstanding footer), and invalid date ranges never open the print flow.`);
} catch (error) {
  console.error("Incident register page:", browser ? await browser.contexts()[0]?.pages()[0]?.locator("body").innerText().catch(() => "") : "");
  throw error;
} finally {
  await browser?.close();
  vite.kill("SIGTERM");
}
