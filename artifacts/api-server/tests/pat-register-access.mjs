// Regression suite for GET /pat-track/register (the appliance-level PAT test
// register CSV). Proves the download's access boundaries: admin-only, tenant
// and site scoping, department scoping, the overdue filter, and
// spreadsheet-safe cells. Runs only through tests/run-fresh-schema.sh, which
// gives it a disposable database and API (no application data touched).
const BASE = process.env.API_BASE;
if (process.env.FRESH_SCHEMA_TEST !== "1" || !BASE) {
  throw new Error("Run via tests/run-fresh-schema.sh tests/pat-register-access.mjs (disposable database only)");
}
let passed = 0;
const failures = [];
function check(name, condition, detail = "") {
  if (condition) passed++;
  else { failures.push(`${name}: ${detail}`); console.error(`FAIL: ${name}: ${detail}`); }
}
const expectStatus = (name, response, expected) => check(name, expected.includes(response.status), `expected ${expected.join("/")}, got ${response.status} ${JSON.stringify(response.data ?? response.text?.slice(0, 200))}`);
function session() {
  let cookie = "";
  const request = async (method, path, body) => {
    const response = await fetch(`${BASE}${path}`, {
      method, headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    const data = (response.headers.get("content-type") || "").includes("application/json") ? await response.json().catch(() => null) : null;
    return { status: response.status, data };
  };
  request.cookie = () => cookie;
  return request;
}

// Every cell the route writes is quoted, so this parser only needs quoted
// cells, doubled quotes and CRLF row breaks.
function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === "\"" && text[i + 1] === "\"") { cell += "\""; i++; }
      else if (ch === "\"") quoted = false;
      else cell += ch;
    } else if (ch === "\"") quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\r" && text[i + 1] === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; i++; }
    else cell += ch;
  }
  row.push(cell);
  rows.push(row);
  return rows;
}

async function download(user, query = "") {
  const response = await fetch(`${BASE}/pat-track/register${query ? `?${query}` : ""}`, {
    headers: user?.cookie() ? { cookie: user.cookie() } : {},
  });
  // Keep the BOM: response.text() would silently strip it.
  const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(await response.arrayBuffer());
  const result = { status: response.status, text, contentType: response.headers.get("content-type") || "", disposition: response.headers.get("content-disposition") || "" };
  if (response.status === 200) {
    check(`register ${query || "(all)"} starts with a BOM`, text.startsWith("﻿"));
    const [headings, ...rows] = parseCsv(text.replace(/^﻿/, ""));
    result.headings = headings;
    result.records = rows.map((cells) => Object.fromEntries(headings.map((heading, index) => [heading, cells[index]])));
    result.names = result.records.map((record) => record["Appliance name"]);
  }
  return result;
}

async function registerTenant(label, stamp) {
  const user = session(), email = `pat-register-${label}-${stamp}@test.local`;
  const registered = await user("POST", "/auth/register", { name: `PAT register ${label}`, email, password: "password-123" });
  expectStatus(`register ${label}`, registered, [200, 201]);
  if (typeof registered.data?.verificationToken !== "string") throw new Error("Verification token unavailable; run via the test runner");
  expectStatus(`verify ${label}`, await user("GET", `/auth/verify-email?token=${encodeURIComponent(registered.data.verificationToken)}`), [200]);
  expectStatus(`login ${label}`, await user("POST", "/auth/login", { email, password: "password-123" }), [200]);
  const me = await user("GET", "/auth/me");
  return { user, clientId: (me.data?.user ?? me.data)?.clientId };
}

// Same calendar day the API computes for "today" (server-local date).
function localIso(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

async function main() {
  const stamp = Date.now();
  const today = localIso(new Date());
  const { user: admin, clientId } = await registerTenant("admin", stamp);
  check("admin has client", Number.isInteger(clientId), String(clientId));

  const alphaDept = await admin("POST", "/departments", { name: `Register Alpha ${stamp}` });
  const betaDept = await admin("POST", "/departments", { name: `Register Beta ${stamp}` });
  const alphaSite = await admin("POST", "/sites", { name: `Register Alpha ${stamp}`, departmentId: alphaDept.data?.id, seedStarterChecks: false });
  const betaSite = await admin("POST", "/sites", { name: `Register Beta ${stamp}`, departmentId: betaDept.data?.id, seedStarterChecks: false });
  for (const [name, response] of [["alpha department", alphaDept], ["beta department", betaDept], ["alpha site", alphaSite], ["beta site", betaSite]]) {
    expectStatus(`create ${name}`, response, [200, 201]);
  }

  const appliance = async (siteId, fields) => {
    const created = await admin("POST", "/pat-track/appliances", { siteId, ...fields });
    expectStatus(`create appliance ${fields.name}`, created, [201]);
    return created.data;
  };
  const test = async (applianceRow, fields) => {
    const created = await admin("POST", "/pat-track/tests", { applianceId: applianceRow.id, ...fields });
    expectStatus(`record test for ${applianceRow.name}`, created, [201]);
  };

  // Alpha site: one appliance per overdue-filter case.
  const alphaOverdue = await appliance(alphaSite.data.id, { name: "Alpha overdue kettle" });
  await test(alphaOverdue, { testDate: "2020-01-01", result: "pass", nextTestDate: "2021-01-01" });
  const alphaFailedOverdue = await appliance(alphaSite.data.id, { name: "Alpha failed overdue drill" });
  await test(alphaFailedOverdue, { testDate: "2020-06-01", result: "fail", nextTestDate: "2020-12-01" });
  const alphaCurrent = await appliance(alphaSite.data.id, { name: "Alpha current toaster" });
  await test(alphaCurrent, { testDate: today, result: "pass", nextTestDate: "2099-12-31" });
  // Only the latest test counts: an old overdue date is superseded by a retest.
  const alphaRetested = await appliance(alphaSite.data.id, { name: "Alpha retested lamp" });
  await test(alphaRetested, { testDate: "2019-01-01", result: "pass", nextTestDate: "2020-01-01" });
  await test(alphaRetested, { testDate: today, result: "pass", nextTestDate: "2099-12-31" });
  // Due today is not yet past due.
  const alphaDueToday = await appliance(alphaSite.data.id, { name: "Alpha due today fan" });
  await test(alphaDueToday, { testDate: "2025-01-01", result: "pass", nextTestDate: today });
  await appliance(alphaSite.data.id, { name: "Alpha untested heater" });
  const alphaNoNextDate = await appliance(alphaSite.data.id, { name: "Alpha no next date radio" });
  await test(alphaNoNextDate, { testDate: "2020-01-01", result: "pass" });

  // Every user-entered text column starts with a formula trigger.
  const formula = await appliance(alphaSite.data.id, {
    name: "=HYPERLINK(\"http://attacker.test\",\"Open\")",
    assetTag: "+SUM(A1:A9)",
    applianceType: "@SUM(1+1)",
    location: "-2+3",
  });
  await test(formula, { testDate: today, result: "pass", nextTestDate: "2099-12-31", testedBy: " \t=cmd|' /C calc'!A0" });
  const plain = await appliance(alphaSite.data.id, { name: "Alpha plain - rear store", location: "Kitchen - rear", assetTag: "A-100" });
  await test(plain, { testDate: today, result: "pass", nextTestDate: "2099-12-31", testedBy: "J. Smith-Jones" });

  const betaOverdue = await appliance(betaSite.data.id, { name: "Beta overdue kettle" });
  await test(betaOverdue, { testDate: "2020-01-01", result: "pass", nextTestDate: "2021-01-01" });
  const betaCurrent = await appliance(betaSite.data.id, { name: "Beta current toaster" });
  await test(betaCurrent, { testDate: today, result: "pass", nextTestDate: "2099-12-31" });
  const unsitedOverdue = await appliance(null, { name: "Unsited overdue iron" });
  await test(unsitedOverdue, { testDate: "2020-01-01", result: "pass", nextTestDate: "2021-01-01" });

  const { user: foreign } = await registerTenant("foreign", stamp);
  const foreignSite = await foreign("POST", "/sites", { name: `Register Foreign ${stamp}`, seedStarterChecks: false });
  expectStatus("create foreign site", foreignSite, [200, 201]);
  const foreignAppliance = await foreign("POST", "/pat-track/appliances", { siteId: foreignSite.data.id, name: "Foreign overdue kettle" });
  expectStatus("create foreign appliance", foreignAppliance, [201]);
  expectStatus("record foreign test", await foreign("POST", "/pat-track/tests", {
    applianceId: foreignAppliance.data.id, testDate: "2020-01-01", result: "pass", nextTestDate: "2021-01-01",
  }), [201]);

  const alphaNames = ["Alpha overdue kettle", "Alpha failed overdue drill", "Alpha current toaster", "Alpha retested lamp",
    "Alpha due today fan", "Alpha untested heater", "Alpha no next date radio", `'${formula.name}`, plain.name];
  const betaNames = ["Beta overdue kettle", "Beta current toaster"];
  const foreignNames = ["Foreign overdue kettle"];
  const sameSet = (actual, expected) => actual.length === expected.length && expected.every((name) => actual.includes(name));
  const noneOf = (actual, hidden) => !actual.some((name) => hidden.includes(name));

  const users = async (role, label, departmentId, extra) => {
    const email = `pat-register-${label}-${stamp}@test.local`;
    const created = await admin("POST", "/users", { name: `Register ${label}`, email, password: "password-456", role, clientId, departmentId });
    expectStatus(`create ${label}`, created, [200, 201]);
    if (extra) expectStatus(`configure ${label}`, await admin("PUT", `/users/${created.data.id}`, extra), [200]);
    const user = session();
    expectStatus(`login ${label}`, await user("POST", "/auth/login", { email, password: "password-456" }), [200]);
    return user;
  };
  const clientAdmin = await users("client_admin", "client-admin", null);
  const alphaStaff = await users("client_staff", "alpha-staff", alphaDept.data.id);
  const unassignedStaff = await users("client_staff", "unassigned-staff", null);
  const alphaViewer = await users("client_viewer", "alpha-viewer", alphaDept.data.id);
  const alphaManager = await users("client_staff", "alpha-manager", alphaDept.data.id, { isDepartmentManager: true });

  // ── Non-admin users cannot download ─────────────────────────────────────────
  for (const query of ["", `siteId=${alphaSite.data.id}`, "status=overdue"]) {
    const anonymous = await download(null, query);
    expectStatus(`anonymous cannot download register ${query}`, anonymous, [401]);
    for (const [label, user] of [["department staff", alphaStaff], ["unassigned staff", unassignedStaff], ["viewer", alphaViewer]]) {
      const denied = await download(user, query);
      expectStatus(`${label} cannot download register ${query}`, denied, [403]);
      check(`${label} receives no register rows ${query}`, !denied.text.includes("Appliance name") && !denied.text.includes("kettle"));
    }
  }

  // ── Admins: full tenant register, never another tenant's ────────────────────
  for (const [label, user] of [["consultant admin", admin], ["client admin", clientAdmin]]) {
    const all = await download(user);
    expectStatus(`${label} downloads register`, all, [200]);
    check(`${label} register is CSV`, all.contentType.startsWith("text/csv"), all.contentType);
    check(`${label} register is an attachment`, /^attachment; filename="pat-test-register-all-sites-all-\d{4}-\d{2}-\d{2}\.csv"$/.test(all.disposition), all.disposition);
    check(`${label} register lists every tenant appliance`, sameSet(all.names ?? [], [...alphaNames, ...betaNames, "Unsited overdue iron"]), JSON.stringify(all.names));
    check(`${label} register excludes other tenants`, noneOf(all.names ?? [], foreignNames));
  }
  const foreignOwn = await download(foreign);
  expectStatus("foreign tenant downloads own register", foreignOwn, [200]);
  check("foreign register holds only its own appliance", sameSet(foreignOwn.names ?? [], foreignNames), JSON.stringify(foreignOwn.names));

  // ── Site filter: only that accessible site's appliances ─────────────────────
  const alphaOnly = await download(admin, `siteId=${alphaSite.data.id}`);
  expectStatus("admin downloads alpha site register", alphaOnly, [200]);
  check("site filter lists exactly the alpha appliances", sameSet(alphaOnly.names ?? [], alphaNames), JSON.stringify(alphaOnly.names));
  check("site filter names the site in the filename", alphaOnly.disposition.includes(`pat-test-register-site-${alphaSite.data.id}-all-`), alphaOnly.disposition);
  const betaOnly = await download(admin, `siteId=${betaSite.data.id}`);
  expectStatus("admin downloads beta site register", betaOnly, [200]);
  check("site filter lists exactly the beta appliances", sameSet(betaOnly.names ?? [], betaNames), JSON.stringify(betaOnly.names));
  const foreignSiteQuery = await download(admin, `siteId=${foreignSite.data.id}`);
  expectStatus("admin cannot filter by another tenant's site", foreignSiteQuery, [400]);
  check("another tenant's site filter returns no rows", !foreignSiteQuery.text.includes("Foreign overdue kettle"));
  const foreignBySite = await download(foreign, `siteId=${alphaSite.data.id}`);
  expectStatus("foreign tenant cannot filter by this tenant's site", foreignBySite, [400]);
  check("foreign tenant receives no alpha rows", !foreignBySite.text.includes("Alpha"));
  expectStatus("consultant cannot switch to an unlinked client", await download(foreign, `clientId=${clientId}`), [400, 403]);
  for (const query of ["siteId=999999999", "siteId=abc", "siteId=0", "status=bogus"]) {
    expectStatus(`invalid register query ${query} is rejected`, await download(admin, query), [400]);
  }

  // ── Department-scoped managers ──────────────────────────────────────────────
  // The register is currently admin-only, so a department manager is refused
  // outright. If manager downloads are opened up later, the department boundary
  // must still hold: another department's site is refused, and an unfiltered
  // download never includes another department's appliances.
  const managerBeta = await download(alphaManager, `siteId=${betaSite.data.id}`);
  expectStatus("department manager cannot export another department's site", managerBeta, [403]);
  check("department manager receives no beta rows for the beta site", noneOf(managerBeta.names ?? [], betaNames) && !managerBeta.text.includes("Beta"));
  for (const query of ["", "status=overdue", `siteId=${alphaSite.data.id}`]) {
    const managerOwn = await download(alphaManager, query);
    expectStatus(`department manager register ${query || "(all)"} is refused or scoped`, managerOwn, [200, 403]);
    check(`department manager register ${query || "(all)"} excludes beta appliances`, !managerOwn.text.includes("Beta"), managerOwn.names ? JSON.stringify(managerOwn.names) : managerOwn.text.slice(0, 200));
    check(`department manager register ${query || "(all)"} excludes other tenants`, !managerOwn.text.includes("Foreign"));
  }

  // ── Overdue filter: only past-due appliances ────────────────────────────────
  const overdueAll = await download(admin, "status=overdue");
  expectStatus("admin downloads overdue register", overdueAll, [200]);
  check("overdue register lists only past-due appliances",
    sameSet(overdueAll.names ?? [], ["Alpha overdue kettle", "Alpha failed overdue drill", "Beta overdue kettle", "Unsited overdue iron"]),
    JSON.stringify(overdueAll.names));
  check("overdue filter names the status in the filename", /pat-test-register-all-sites-overdue-/.test(overdueAll.disposition), overdueAll.disposition);
  check("every overdue row has a next due date before today",
    (overdueAll.records ?? []).every((record) => /^\d{4}-\d{2}-\d{2}$/.test(record["Next due date"]) && record["Next due date"] < today),
    JSON.stringify(overdueAll.records?.map((record) => record["Next due date"])));
  const overdueAlpha = await download(admin, `siteId=${alphaSite.data.id}&status=overdue`);
  expectStatus("admin downloads alpha overdue register", overdueAlpha, [200]);
  check("site and overdue filters combine",
    sameSet(overdueAlpha.names ?? [], ["Alpha overdue kettle", "Alpha failed overdue drill"]), JSON.stringify(overdueAlpha.names));
  const statusOf = (name) => overdueAlpha.records?.find((record) => record["Appliance name"] === name)?.Status;
  check("passed overdue appliance is labelled Overdue", statusOf("Alpha overdue kettle") === "Overdue", statusOf("Alpha overdue kettle"));
  check("failed overdue appliance keeps its Failed label", statusOf("Alpha failed overdue drill") === "Failed", statusOf("Alpha failed overdue drill"));

  // ── Spreadsheet-safe cells ──────────────────────────────────────────────────
  const formulaRow = alphaOnly.records?.find((record) => record["Asset tag"] === "'+SUM(A1:A9)");
  check("formula appliance row is present", Boolean(formulaRow), JSON.stringify(alphaOnly.names));
  if (formulaRow) {
    check("formula appliance name is escaped", formulaRow["Appliance name"] === `'${formula.name}`, formulaRow["Appliance name"]);
    check("formula appliance type is escaped", formulaRow.Type === "'@SUM(1+1)", formulaRow.Type);
    check("formula location is escaped", formulaRow.Location === "'-2+3", formulaRow.Location);
    check("formula last-test location is escaped", formulaRow["Last test location"] === "'-2+3", formulaRow["Last test location"]);
    check("whitespace-led formula tester is escaped", formulaRow["Tested by"] === "' \t=cmd|' /C calc'!A0", JSON.stringify(formulaRow["Tested by"]));
  }
  check("quotes inside a formula are doubled in the raw CSV",
    alphaOnly.text.includes("\"'=HYPERLINK(\"\"http://attacker.test\"\",\"\"Open\"\")\""));
  const plainRow = alphaOnly.records?.find((record) => record["Asset tag"] === "A-100");
  check("plain appliance values are unchanged",
    plainRow?.["Appliance name"] === "Alpha plain - rear store" && plainRow?.Location === "Kitchen - rear" && plainRow?.["Tested by"] === "J. Smith-Jones",
    JSON.stringify(plainRow));
  const formulaLed = (cell) => /^[\u0000-\u0020]*[=+\-@]/.test(cell);
  const riskyCells = [alphaOnly.headings ?? [], ...(alphaOnly.records ?? []).map(Object.values)].flat().filter(formulaLed);
  check("no register cell starts a formula", riskyCells.length === 0, JSON.stringify(riskyCells));

  console.log(`\n${passed} checks passed, ${failures.length} failed.`);
  if (failures.length) process.exit(1);
}
main().catch((error) => { console.error(error); process.exit(1); });
