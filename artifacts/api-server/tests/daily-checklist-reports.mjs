// Regression tests for daily checklist reporting and duplicate submits:
//  - reports (site, all-sites, trend) count the stored checklist types
//    (kitchen_/premises_ opening/closing), not literal 'am'/'pm' values, so a
//    site with every checklist submitted shows 100%;
//  - mobile-app submissions (daily_checklist_submissions) count too, and a
//    day done on both web and mobile counts once;
//  - a repeated POST /daily-track-am|pm for the same site/type/date updates
//    the one row instead of adding a duplicate (also under concurrency and
//    for the "no site" slot).
// Run through test:daily-checklist-reports, which starts a test-mode API.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createFixtureOwnership, resolveRunId } from "./fixture-ownership.mjs";

const BASE = process.env.API_BASE;
assert.ok(BASE, "Run through test:daily-checklist-reports to start a test-mode API");
const runId = resolveRunId();
const fixtures = createFixtureOwnership({ runId, suite: "daily-checklist-reports" });

function session(defaultHeaders = {}) {
  let cookie = "";
  return async (method, path, body) => {
    const response = await fetch(`${BASE}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}), ...defaultHeaders },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    const data = await response.json().catch(() => null);
    return { status: response.status, data };
  };
}

function ok(result, label) {
  assert.ok(result.status >= 200 && result.status < 300, `${label}: ${result.status} ${JSON.stringify(result.data)}`);
  return result.data;
}

function totp(secret) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of secret.toUpperCase()) bits += alphabet.indexOf(char).toString(2).padStart(5, "0");
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac("sha1", Buffer.from(bytes)).update(counter).digest();
  const offset = digest.at(-1) & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

// The trend report covers complete UK months, so use the previous one. The
// owner is a client admin (exempt from the record lock).
function previousUkMonth() {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "numeric" })
    .formatToParts(new Date());
  const year = Number(parts.find(p => p.type === "year").value);
  const month = Number(parts.find(p => p.type === "month").value);
  const d = new Date(Date.UTC(year, month - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

async function main() {
  // The owner deliberately backfills past months, which needs a reason.
  const owner = session({ "X-Override-Reason": encodeURIComponent("Daily reports fixture: past-month record") });
  const email = `daily-reports-${runId}@test.local`;
  const registered = ok(await owner("POST", "/auth/register", {
    name: "Daily Reports Admin", email, password: "password-123",
  }), "register");
  fixtures.trackRegisteredUser();
  ok(await owner("GET", `/auth/verify-email?token=${encodeURIComponent(registered.verificationToken)}`), "verify email");
  ok(await owner("POST", "/auth/login", { email, password: "password-123" }), "login");
  const { secret } = ok(await owner("GET", "/auth/2fa/setup"), "2fa setup");
  ok(await owner("POST", "/auth/2fa/enable", { code: totp(secret) }), "2fa enable");
  const { user } = ok(await owner("GET", "/auth/me"), "me");
  fixtures.trackClient(user.clientId);

  const month = previousUkMonth();
  const d1 = `${month}-01`;
  const d2 = `${month}-02`;
  const submittedAt = new Date().toISOString();
  const site = async name => ok(await owner("POST", "/sites", { name: `${name} ${runId}`, seedStarterChecks: false }), `create ${name}`);
  const webSite = await site("Web");
  const mobileSite = await site("Mobile");
  const bothSite = await site("Both");
  const draftSite = await site("Draft");
  const dupSite = await site("Duplicate");

  const webChecklist = (path, siteId, checklistType, checkDate, extra = {}) => owner("POST", path, {
    siteId, checklistType, checkDate, items: [{ label: "Done", checked: true }], ...extra,
  });

  // ── C2: every stored checklist type counts towards its AM/PM period ──────
  for (const type of ["kitchen_opening", "premises_opening"]) {
    assert.equal((await webChecklist("/daily-track-am", webSite.id, type, d1, { submittedAt })).status, 201, `submit ${type}`);
  }
  for (const type of ["kitchen_closing", "premises_closing"]) {
    assert.equal((await webChecklist("/daily-track-pm", webSite.id, type, d1, { submittedAt })).status, 201, `submit ${type}`);
  }
  // ── C3: mobile-app submissions count, and web + mobile on one day once ──
  for (const period of ["am", "pm"]) {
    ok(await owner("POST", `/daily-checklists/${mobileSite.id}/${d1}/${period}`, {
      answers: [{ question: "All good", checked: true }],
    }), `mobile ${period}`);
  }
  assert.equal((await webChecklist("/daily-track-am", bothSite.id, "kitchen_opening", d1, { submittedAt })).status, 201);
  ok(await owner("POST", `/daily-checklists/${bothSite.id}/${d1}/am`, {
    answers: [{ question: "All good", checked: true }],
  }), "mobile am at web site");
  // Drafts never count.
  assert.equal((await webChecklist("/daily-track-am", draftSite.id, "kitchen_opening", d1)).status, 201);

  const daily = (report, siteId, type) => report.dailyChecklists.find(r => r.siteId === siteId && r.type === type);

  const webReport = ok(await owner("GET", `/reports/compliance?from=${d1}&to=${d1}&siteId=${webSite.id}`), "site report");
  assert.deepEqual(
    ["am", "pm"].map(type => [daily(webReport, webSite.id, type)?.submitted, daily(webReport, webSite.id, type)?.pct]),
    [[1, 100], [1, 100]],
    "site report: all four checklist types submitted is 100% AM and PM",
  );

  const allSites = ok(await owner("GET", `/reports/compliance?from=${d1}&to=${d1}`), "all-sites report");
  for (const s of [webSite, mobileSite]) {
    for (const type of ["am", "pm"]) {
      assert.equal(daily(allSites, s.id, type)?.pct, 100, `all-sites report ${type} 100% for ${s.name}`);
    }
  }
  assert.equal(daily(allSites, bothSite.id, "am")?.submitted, 1, "web + mobile on one day counts once");
  assert.equal(daily(allSites, bothSite.id, "pm")?.submitted, 0);
  assert.equal(daily(allSites, draftSite.id, "am")?.submitted, 0, "a draft is not a submission");

  const twoDays = ok(await owner("GET", `/reports/compliance?from=${d1}&to=${d2}&siteId=${bothSite.id}`), "two-day report");
  assert.deepEqual([daily(twoDays, bothSite.id, "am")?.submitted, daily(twoDays, bothSite.id, "am")?.pct], [1, 50]);

  const mobileReport = ok(await owner("GET", `/reports/compliance?from=${d1}&to=${d1}&siteId=${mobileSite.id}`), "mobile site report");
  assert.equal(daily(mobileReport, mobileSite.id, "am")?.pct, 100, "mobile AM counts in the site report");
  assert.equal(daily(mobileReport, mobileSite.id, "pm")?.pct, 100, "mobile PM counts in the site report");

  const trend = ok(await owner("GET", "/reports/compliance-trend?months=2"), "trend report");
  const point = siteId => trend.series.find(s => s.siteId === siteId)?.data.find(p => p.month === month);
  assert.deepEqual([point(webSite.id)?.amSubmitted, point(webSite.id)?.pmSubmitted], [1, 1], "trend counts web checklist types");
  assert.deepEqual([point(mobileSite.id)?.amSubmitted, point(mobileSite.id)?.pmSubmitted], [1, 1], "trend counts mobile submissions");
  assert.equal(point(bothSite.id)?.amSubmitted, 1, "trend counts web + mobile on one day once");

  // The department report shares the same source; it must still run.
  const dept = ok(await owner("POST", "/departments", { name: `Dept ${runId}` }), "create department");
  ok(await owner("GET", `/reports/compliance?from=${d1}&to=${d1}&departmentId=${dept.id}`), "department report");

  // ── Duplicate submits ──────────────────────────────────────────────────
  const first = await webChecklist("/daily-track-am", dupSite.id, "kitchen_opening", d1);
  assert.equal(first.status, 201, "first draft is created");
  const again = await owner("POST", "/daily-track-am", {
    siteId: dupSite.id, checklistType: "kitchen_opening", checkDate: d1,
    items: [{ label: "Done", checked: true }, { label: "Second", checked: true }],
  });
  assert.equal(again.status, 200, "repeat POST updates the draft");
  assert.equal(again.data?.id, first.data?.id, "repeat POST returns the same checklist");
  assert.equal(again.data?.items?.length, 2, "repeat POST saves the latest items");
  const submitted = await webChecklist("/daily-track-am", dupSite.id, "kitchen_opening", d1, { submittedAt });
  assert.equal(submitted.status, 200);
  assert.equal(submitted.data?.id, first.data?.id);
  assert.ok(submitted.data?.submittedAt, "POST can submit the existing draft");
  const late = await webChecklist("/daily-track-am", dupSite.id, "kitchen_opening", d1, { submittedAt });
  assert.equal(late.status, 409, "a submitted checklist is not overwritten");
  assert.equal(late.data?.code, "CHECKLIST_ALREADY_SUBMITTED");
  assert.equal(late.data?.id, first.data?.id);

  const burst = await Promise.all(Array.from({ length: 6 }, () =>
    webChecklist("/daily-track-am", dupSite.id, "premises_opening", d1, { submittedAt })));
  assert.deepEqual(burst.map(r => r.status).sort(), [201, 409, 409, 409, 409, 409], "concurrent submits create one row");

  const dupRows = ok(await owner("GET", `/daily-track-am?siteId=${dupSite.id}&date=${d1}`), "list duplicates");
  assert.deepEqual(dupRows.map(r => r.checklistType).sort(), ["kitchen_opening", "premises_opening"],
    "one row per checklist type after repeated submits");

  const noSite = await Promise.all(Array.from({ length: 3 }, () =>
    webChecklist("/daily-track-pm", null, "kitchen_closing", d2)));
  assert.deepEqual(noSite.map(r => r.status).sort(), [200, 200, 201], "the no-site slot is deduplicated too");
  const pmRows = ok(await owner("GET", `/daily-track-pm?date=${d2}`), "list PM");
  assert.equal(pmRows.filter(r => r.siteId === null && r.checklistType === "kitchen_closing").length, 1);

  console.log("daily checklist report and duplicate-submit checks passed");
}

try {
  await main();
} finally {
  await fixtures.cleanup();
}
