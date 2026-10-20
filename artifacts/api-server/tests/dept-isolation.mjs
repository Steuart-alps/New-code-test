// Department-isolation integration tests.
//
// Verifies that client_staff and client_viewer users scoped to a specific
// department can only access sites, compliance items, and module checks that
// belong to their department. Admins bypass all department filtering.
//
// Flow:
//   1. Admin registers and creates two departments (Alpha, Beta).
//   2. Admin creates one site per department with seeded compliance checks.
//   3. Admin creates staff and viewer users assigned to Department Alpha.
//   4. Staff and viewer log in; tests confirm they see only Alpha resources.
//   5. Admin confirms unrestricted access to both departments.
//   6. A staff member moves from Alpha to Beta: department reports keep each
//      record with the department recorded when it was created (cookie and
//      bearer submissions), across sites and tenants, and older records with
//      no recorded department are listed apart rather than reassigned.
//
// Usage: node tests/dept-isolation.mjs  (API must be running on API_BASE)
// Exits 0 when every check passes, 1 otherwise.

import { createRequire } from "node:module";

const BASE = process.env.API_BASE || "http://localhost:8080/api";
// pg comes from @workspace/db; used only for the legacy-row and trigger checks.
const pg = createRequire(new URL("../../../lib/db/package.json", import.meta.url))("pg");

let passed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed++;
  } else {
    failures.push(`${name} — ${detail}`);
    console.error(`FAIL: ${name} — ${detail}`);
  }
}

function expectBlocked(name, status) {
  check(name, [400, 403, 404].includes(status), `expected 400/403/404, got ${status}`);
}

function expectForbidden(name, status) {
  check(name, status === 403, `expected 403, got ${status}`);
}

function expectOk(name, status, allowed = [200, 201]) {
  check(name, allowed.includes(status), `expected ${allowed.join("/")}, got ${status}`);
}

// Mobile app requests: Authorization: Bearer <token from /auth/mobile-login>.
function makeBearerSession(token) {
  return async function request(method, path, body) {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { "Content-Type": "application/json", authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const ct = res.headers.get("content-type") ?? "";
    const data = ct.includes("application/json") ? await res.json().catch(() => null) : (await res.text().catch(() => null), null);
    return { status: res.status, data };
  };
}

function makeSession() {
  let cookie = "";
  return async function request(method, path, body, extraHeaders = {}) {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(cookie ? { cookie } : {}),
        ...extraHeaders,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    let data = null;
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) data = await res.json().catch(() => null);
    else await res.text().catch(() => null);
    return { status: res.status, data };
  };
}

async function main() {
  const ts = Date.now();
  const adminEmail = `dept-admin-${ts}@test.local`;

  // ── 1. Admin registers ───────────────────────────────────────────────────────
  const admin = makeSession();
  const reg = await admin("POST", "/auth/register", {
    name: "Dept Test Admin",
    email: adminEmail,
    password: "password-123",
  });
  expectOk("admin: register", reg.status, [200, 201]);
  if (reg.data?.verificationToken) {
    const verify = await admin(
      "GET",
      `/auth/verify-email?token=${encodeURIComponent(reg.data.verificationToken)}`,
    );
    expectOk("admin: verify email", verify.status);
    const login = await admin("POST", "/auth/login", {
      email: adminEmail,
      password: "password-123",
    });
    expectOk("admin: login", login.status);
  }

  const meRes = await admin("GET", "/auth/me");
  expectOk("admin: /auth/me", meRes.status);
  const adminUser = meRes.data?.user ?? meRes.data;
  const clientId = adminUser?.clientId;
  check("admin: has clientId", Number.isInteger(clientId), `clientId=${clientId}`);

  // ── 2. Create two departments ────────────────────────────────────────────────
  const deptAlphaRes = await admin("POST", "/departments", { name: "Dept Alpha" });
  expectOk("admin: create Dept Alpha", deptAlphaRes.status, [200, 201]);
  const deptAlphaId = deptAlphaRes.data?.id;
  check("admin: Dept Alpha id", Number.isInteger(deptAlphaId), `id=${deptAlphaId}`);

  const deptBetaRes = await admin("POST", "/departments", { name: "Dept Beta" });
  expectOk("admin: create Dept Beta", deptBetaRes.status, [200, 201]);
  const deptBetaId = deptBetaRes.data?.id;
  check("admin: Dept Beta id", Number.isInteger(deptBetaId), `id=${deptBetaId}`);

  // ── 3. Create one site per department with seeded compliance checks ───────────
  const siteAlphaRes = await admin("POST", "/sites", {
    name: "Alpha Site",
    departmentId: deptAlphaId,
    seedStarterChecks: true,
  });
  expectOk("admin: create Alpha Site", siteAlphaRes.status, [200, 201]);
  const siteAlphaId = siteAlphaRes.data?.id;
  check("admin: Alpha Site id", Number.isInteger(siteAlphaId), `id=${siteAlphaId}`);

  const siteBetaRes = await admin("POST", "/sites", {
    name: "Beta Site",
    departmentId: deptBetaId,
    seedStarterChecks: true,
  });
  expectOk("admin: create Beta Site", siteBetaRes.status, [200, 201]);
  const siteBetaId = siteBetaRes.data?.id;
  check("admin: Beta Site id", Number.isInteger(siteBetaId), `id=${siteBetaId}`);

  // Get one compliance item id per site for mutation tests.
  const allItemsRes = await admin("GET", "/compliance-items");
  expectOk("admin: list compliance items", allItemsRes.status);
  const allItems = Array.isArray(allItemsRes.data)
    ? allItemsRes.data
    : allItemsRes.data?.items ?? [];
  const alphaItem = allItems.find((i) => i.siteId === siteAlphaId);
  const betaItem = allItems.find((i) => i.siteId === siteBetaId);
  check("admin: found alpha item", alphaItem != null, "no item for alpha site");
  check("admin: found beta item", betaItem != null, "no item for beta site");

  // Add fire-safety and legionella checks on both sites via admin
  // The account's own day (Europe/London), which the record lock compares
  // against; a UTC date is a day behind between 23:00 and 00:00 UTC in BST.
  const uniqueDate = (offset = 0) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" })
    .format(new Date(Date.now() - offset * 86400000));

  const fireAlpha = await admin("POST", "/fire-safety", {
    checkType: "alarm", callPoint: "CP1",
    checkDate: uniqueDate(1),
    result: "pass",
    siteId: siteAlphaId,
  });
  // Fire-safety POST may or may not require siteId; we record the id if it succeeded.
  const fireAlphaId = fireAlpha.status === 201 ? fireAlpha.data?.id : null;

  const fireBeta = await admin("POST", "/fire-safety", {
    checkType: "alarm", callPoint: "CP1",
    checkDate: uniqueDate(0),
    result: "pass",
    siteId: siteBetaId,
  });
  const fireBetaId = fireBeta.status === 201 ? fireBeta.data?.id : null;

  // Add legionella checks on both sites via admin
  const legAlpha = await admin("POST", "/legionella", {
    checkType: "calorifier_temp",
    checkDate: uniqueDate(1),
    result: "pass",
    temperature: 60,
    performedBy: "Dept Test Admin",
    siteId: siteAlphaId,
  });
  const legAlphaId = [200, 201].includes(legAlpha.status) ? legAlpha.data?.id : null;
  check("admin: create alpha legionella check", legAlphaId != null, `status=${legAlpha.status}`);

  const legBeta = await admin("POST", "/legionella", {
    checkType: "calorifier_temp",
    checkDate: uniqueDate(0),
    result: "pass",
    temperature: 60,
    performedBy: "Dept Test Admin",
    siteId: siteBetaId,
  });
  const legBetaId = [200, 201].includes(legBeta.status) ? legBeta.data?.id : null;
  check("admin: create beta legionella check", legBetaId != null, `status=${legBeta.status}`);

  // Distinct sentinel outlets and monthly readings make outlet-status leaks visible.
  const outletAlpha = await admin("POST", "/legionella/outlets", {
    name: `Alpha sentinel ${ts}`, type: "hot", siteId: siteAlphaId,
  });
  expectOk("admin: create alpha sentinel outlet", outletAlpha.status, [201]);
  const outletAlphaId = outletAlpha.data?.id;
  check("admin: alpha sentinel id", Number.isInteger(outletAlphaId), `id=${outletAlphaId}`);
  const outletBeta = await admin("POST", "/legionella/outlets", {
    name: `Beta sentinel ${ts}`, type: "hot", siteId: siteBetaId,
  });
  expectOk("admin: create beta sentinel outlet", outletBeta.status, [201]);
  const outletBetaId = outletBeta.data?.id;
  check("admin: beta sentinel id", Number.isInteger(outletBetaId), `id=${outletBetaId}`);
  const alphaReading = await admin("POST", "/legionella", {
    checkType: "hot_sentinel_temp", checkDate: uniqueDate(0), result: "pass",
    temperature: 52, performedBy: "Dept Test Admin", siteId: siteAlphaId,
    outletId: outletAlphaId, notes: `Alpha reading ${ts}`,
  });
  expectOk("admin: record alpha sentinel reading", alphaReading.status, [201]);
  const betaReading = await admin("POST", "/legionella", {
    checkType: "hot_sentinel_temp", checkDate: uniqueDate(0), result: "pass",
    temperature: 53, performedBy: "Dept Test Admin", siteId: siteBetaId,
    outletId: outletBetaId, notes: `Beta reading ${ts}`,
  });
  expectOk("admin: record beta sentinel reading", betaReading.status, [201]);
  // New readings can only link to an active outlet of this business at the
  // reading's own site that takes the reading's check type.
  const outletLinkRejections = [
    ["another site's outlet", { siteId: siteBetaId, outletId: outletAlphaId }],
    ["a site outlet without a site", { siteId: null, outletId: outletAlphaId }],
    ["an incompatible check type", { siteId: siteAlphaId, outletId: outletAlphaId, checkType: "cold_sentinel_temp", temperature: 12 }],
    ["an unknown outlet", { siteId: siteAlphaId, outletId: 2147480000 }],
  ];
  for (const [label, link] of outletLinkRejections) {
    expectBlocked(`admin: reading cannot link to ${label}`, (await admin("POST", "/legionella", {
      checkType: "hot_sentinel_temp", checkDate: uniqueDate(0), result: "pass", temperature: 54,
      performedBy: "Dept Test Admin", notes: `Rejected outlet link ${ts}`, ...link,
    })).status);
  }
  const retiredOutlet = await admin("POST", "/legionella/outlets", {
    name: `Retired alpha sentinel ${ts}`, type: "hot", siteId: siteAlphaId,
  });
  expectOk("admin: retire an alpha outlet", (await admin("DELETE", `/legionella/outlets/${retiredOutlet.data?.id}`)).status, [204]);
  expectBlocked("admin: reading cannot link to a removed outlet", (await admin("POST", "/legionella", {
    checkType: "hot_sentinel_temp", checkDate: uniqueDate(0), result: "pass", temperature: 54,
    siteId: siteAlphaId, outletId: retiredOutlet.data?.id,
  })).status);
  // Edits keep the same rules: a linked reading cannot move to another site,
  // and cannot be relinked to another site's outlet.
  expectBlocked("admin: linked reading cannot move to another site", (await admin("PUT", `/legionella/${alphaReading.data?.id}`, {
    siteId: siteBetaId,
  })).status);
  expectBlocked("admin: reading cannot be relinked to another site's outlet", (await admin("PUT", `/legionella/${alphaReading.data?.id}`, {
    outletId: outletBetaId,
  })).status);
  // Valid monthly history: two readings this month and one last month on the
  // same outlet; only this month's readings count towards its monthly test.
  const secondAlphaReading = await admin("POST", "/legionella", {
    checkType: "hot_sentinel_temp", checkDate: uniqueDate(0), result: "pass",
    temperature: 51, performedBy: "Dept Test Admin", siteId: siteAlphaId, outletId: outletAlphaId,
  });
  expectOk("admin: second alpha sentinel reading this month", secondAlphaReading.status, [201]);
  const lastMonthAlphaReading = await admin("POST", "/legionella", {
    checkType: "hot_sentinel_temp",
    checkDate: new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 1, 15)).toISOString().slice(0, 10),
    result: "pass", temperature: 53, performedBy: "Dept Test Admin", siteId: siteAlphaId, outletId: outletAlphaId,
  }, { "X-Override-Reason": encodeURIComponent("Dept isolation fixture: prior-month reading") });
  expectOk("admin: last month's alpha sentinel reading", lastMonthAlphaReading.status, [201]);
  const alphaHistory = (await admin("GET", "/legionella/outlet-status")).data?.find?.(row => row.id === outletAlphaId);
  const historyIds = new Set((alphaHistory?.thisMonthChecks ?? []).map(reading => reading.id));
  check("admin: alpha outlet keeps this month's readings and leaves out last month's",
    historyIds.has(alphaReading.data?.id) && historyIds.has(secondAlphaReading.data?.id) &&
      !historyIds.has(lastMonthAlphaReading.data?.id), `monthly checks=${[...historyIds]}`);
  check("admin: alpha outlet's readings stayed linked after refused edits",
    [alphaReading.data?.id, secondAlphaReading.data?.id].every(id => historyIds.has(id)), "reading unlinked");

  // A historically mismatched outlet reference (an outlet moved to another
  // site after it was tested) must not expose a Beta check through an
  // otherwise accessible Alpha outlet.
  const movedOutlet = await admin("POST", "/legionella/outlets", {
    name: `Moved sentinel ${ts}`, type: "hot", siteId: siteBetaId,
  });
  expectOk("admin: create beta outlet to move", movedOutlet.status, [201]);
  const crossSiteReading = await admin("POST", "/legionella", {
    checkType: "hot_sentinel_temp", checkDate: uniqueDate(0), result: "pass",
    temperature: 54, performedBy: "Dept Test Admin", siteId: siteBetaId,
    outletId: movedOutlet.data?.id, notes: `Beta linked to Alpha outlet ${ts}`,
  });
  expectOk("admin: record beta reading before the outlet moves", crossSiteReading.status, [201]);
  expectOk("admin: move tested outlet to alpha site", (await admin("PUT", `/legionella/outlets/${movedOutlet.data?.id}`, {
    siteId: siteAlphaId,
  })).status);

  // Put one module record in the most recently completed month. A trend must
  // return its count without leaking the record to another department.
  const lastMonthDate = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 1, 15))
    .toISOString().slice(0, 10);
  // Backfilling a past record needs an owner's reason.
  const priorMonthCheck = await admin("POST", "/fire-safety", {
    checkType: "alarm", callPoint: "CP1",
    checkDate: lastMonthDate,
    result: "pass",
    siteId: siteAlphaId,
  }, { "X-Override-Reason": encodeURIComponent("Dept isolation fixture: prior-month record") });
  expectOk("admin: create prior-month module record", priorMonthCheck.status, [200, 201]);

  // ── 4. Create staff user assigned to Dept Alpha ──────────────────────────────
  const staffEmail = `dept-staff-alpha-${ts}@test.local`;
  const staffPassword = "password-456";
  const createStaffRes = await admin("POST", "/users", {
    name: "Staff Alpha",
    email: staffEmail,
    password: staffPassword,
    role: "client_staff",
    clientId,
    departmentId: deptAlphaId,
  });
  expectOk("admin: create staff user", createStaffRes.status, [200, 201]);
  const staffUserId = createStaffRes.data?.id;
  check("admin: staff user has clientId", createStaffRes.data?.clientId === clientId, `staff clientId=${createStaffRes.data?.clientId}, expected ${clientId}`);
  check("admin: staff user id", Number.isInteger(staffUserId), `id=${staffUserId}`);
  expectOk("admin: designate department manager", (await admin("PUT", `/users/${staffUserId}`, {
    isDepartmentManager: true,
  })).status);
  expectOk("admin: route TubTrack to Alpha department", (await admin("PUT", "/settings", {
    trackSummaryRouting: JSON.stringify({ hot_tub: { managerIds: [staffUserId], departmentIds: [deptAlphaId] } }),
  })).status);
  check("admin: rejects unknown department recipient", (await admin("PUT", "/settings", {
    trackSummaryRouting: JSON.stringify({ hot_tub: { managerIds: [], departmentIds: [999999999] } }),
  })).status === 400, "foreign/unknown department accepted");

  // ── 5. Staff logs in ─────────────────────────────────────────────────────────
  const staff = makeSession();
  const staffLogin = await staff("POST", "/auth/login", {
    email: staffEmail,
    password: staffPassword,
  });
  expectOk("staff: login", staffLogin.status, [200, 201]);
  expectForbidden("staff cannot change track recipients", (await staff("PUT", "/settings", {
    trackSummaryRouting: JSON.stringify({ hot_tub: { managerIds: [staffUserId], departmentIds: [] } }),
  })).status);

  // The checklist strip and AM/PM cards must report the same completion state
  // for the same sites, including when department access narrows the site set.
  const assertDashboardChecklists = (label, response, expectedSites, completedAm, completedPm) => {
    const totals = response.data?.checklistTotals;
    const am = response.data?.tracks?.find(track => track.trackId === "daily_am");
    const pm = response.data?.tracks?.find(track => track.trackId === "daily_pm");
    check(`${label}: totals and cards available`, response.status === 200 && totals?.available === true &&
      am?.enabled === true && pm?.enabled === true, `status=${response.status}`);
    check(`${label}: AM strip matches card`, totals?.expectedAmPairs === expectedSites &&
      totals?.completedAmPairs === completedAm &&
      (am?.status === "ok") === (completedAm === expectedSites) &&
      (am?.health === "clear") === (completedAm === expectedSites),
      `totals=${JSON.stringify(totals)} card=${JSON.stringify(am)}`);
    check(`${label}: PM strip matches card`, totals?.expectedPmPairs === expectedSites &&
      totals?.completedPmPairs === completedPm &&
      (pm?.status === "ok") === (completedPm === expectedSites) &&
      (pm?.health === "clear") === (completedPm === expectedSites),
      `totals=${JSON.stringify(totals)} card=${JSON.stringify(pm)}`);
  };
  const today = uniqueDate(0);
  const yesterday = uniqueDate(1);
  const draft = await admin("POST", "/daily-track-am", {
    siteId: siteAlphaId, checklistType: "premises_opening", checkDate: today, items: [],
  });
  expectOk("draft AM checklist remains unsubmitted", draft.status, [201]);
  for (const [path, checklistType] of [
    ["/daily-track-am", "kitchen_opening"],
    ["/daily-track-pm", "kitchen_closing"],
  ]) {
    const prior = await admin("POST", path, {
      siteId: siteBetaId, checklistType, checkDate: yesterday, items: [{ label: "Checked", checked: true, result: "pass" }],
      submittedAt: new Date().toISOString(),
    });
    expectOk("prior-day checklist does not count today", prior.status, [201]);
  }
  assertDashboardChecklists("before submissions", await admin("GET", "/dashboard/summary"), 2, 0, 0);
  const submitChecklist = (siteId, path, checklistType) => admin("POST", path, {
    siteId, checklistType, checkDate: today, items: [{ label: "Checked", checked: true, result: "pass" }], submittedAt: new Date().toISOString(),
  });
  const alphaAm = await submitChecklist(siteAlphaId, "/daily-track-am", "kitchen_opening");
  const alphaPm = await submitChecklist(siteAlphaId, "/daily-track-pm", "kitchen_closing");
  expectOk("alpha: submit today's AM checklist", alphaAm.status, [201]);
  expectOk("alpha: submit today's PM checklist", alphaPm.status, [201]);
  assertDashboardChecklists("admin all sites after alpha", await admin("GET", "/dashboard/summary"), 2, 1, 1);
  assertDashboardChecklists("admin alpha site", await admin("GET", `/dashboard/summary?siteId=${siteAlphaId}`), 1, 1, 1);
  assertDashboardChecklists("admin beta site", await admin("GET", `/dashboard/summary?siteId=${siteBetaId}`), 1, 0, 0);
  assertDashboardChecklists("alpha department staff", await staff("GET", "/dashboard/summary"), 1, 1, 1);
  expectForbidden("alpha staff cannot select beta dashboard site",
    (await staff("GET", `/dashboard/summary?siteId=${siteBetaId}`)).status);
  const betaAm = await submitChecklist(siteBetaId, "/daily-track-am", "premises_opening");
  const betaPm = await submitChecklist(siteBetaId, "/daily-track-pm", "premises_closing");
  expectOk("beta: submit today's AM checklist", betaAm.status, [201]);
  expectOk("beta: submit today's PM checklist", betaPm.status, [201]);
  assertDashboardChecklists("admin all sites complete", await admin("GET", "/dashboard/summary"), 2, 2, 2);

  // PoolTrack and SwimTrack mobile submissions are tenant- and
  // department-scoped just like the allowed-site list.
  const poolAlpha = await admin("POST", "/pool-track", {
    checkDate: uniqueDate(1), siteId: siteAlphaId,
  });
  expectOk("admin: create alpha pool check", poolAlpha.status, [201]);
  const poolBeta = await admin("POST", "/pool-track", {
    checkDate: uniqueDate(1), siteId: siteBetaId,
  });
  expectOk("admin: create beta pool check", poolBeta.status, [201]);
  const swimAlpha = await admin("POST", "/swim-track/sessions", {
    sessionDate: uniqueDate(1), siteId: siteAlphaId,
  });
  expectOk("admin: create alpha swim session", swimAlpha.status, [201]);
  const swimBeta = await admin("POST", "/swim-track/sessions", {
    sessionDate: uniqueDate(1), siteId: siteBetaId,
  });
  expectOk("admin: create beta swim session", swimBeta.status, [201]);

  // Manager-style users remain able to use the historical optional / null
  // site scope on both endpoints.
  expectOk("admin: pool check without siteId", (await admin("POST", "/pool-track", {
    checkDate: uniqueDate(0),
  })).status, [201]);
  expectOk("admin: pool check with null siteId", (await admin("POST", "/pool-track", {
    checkDate: uniqueDate(0), siteId: null,
  })).status, [201]);
  expectOk("admin: swim session without siteId", (await admin("POST", "/swim-track/sessions", {
    sessionDate: uniqueDate(0),
  })).status, [201]);
  expectOk("admin: swim session with null siteId", (await admin("POST", "/swim-track/sessions", {
    sessionDate: uniqueDate(0), siteId: null,
  })).status, [201]);

  const staffPoolChecks = await staff("GET", "/pool-track");
  expectOk("staff: GET /pool-track is scoped", staffPoolChecks.status);
  const staffPoolRows = Array.isArray(staffPoolChecks.data) ? staffPoolChecks.data : [];
  check("staff: pool list excludes beta site", !staffPoolRows.some(row => row.site_id === siteBetaId), "beta check visible");
  check("staff: pool list includes alpha site", staffPoolRows.some(row => row.site_id === siteAlphaId), "alpha check missing");
  const staffPoolBeta = await staff("GET", `/pool-track?siteId=${siteBetaId}`);
  expectOk("staff: GET /pool-track at inaccessible site returns empty", staffPoolBeta.status);
  check("staff: pool beta filter is empty", Array.isArray(staffPoolBeta.data) && staffPoolBeta.data.length === 0, "inaccessible site returned records");
  expectOk("staff: GET /pool-track at allowed site", (await staff("GET", `/pool-track?siteId=${siteAlphaId}`)).status);
  expectOk("staff: POST /pool-track at allowed site", (await staff("POST", "/pool-track", {
    checkDate: uniqueDate(0), siteId: siteAlphaId,
  })).status, [201]);
  expectForbidden("staff: POST /pool-track at inaccessible site", (await staff("POST", "/pool-track", {
    checkDate: uniqueDate(0), siteId: siteBetaId,
  })).status);
  expectBlocked("staff: POST /pool-track without siteId", (await staff("POST", "/pool-track", {
    checkDate: uniqueDate(0),
  })).status);
  expectBlocked("staff: POST /pool-track with null siteId", (await staff("POST", "/pool-track", {
    checkDate: uniqueDate(0), siteId: null,
  })).status);

  const staffSwimSessions = await staff("GET", "/swim-track/sessions");
  expectOk("staff: GET /swim-track/sessions is scoped", staffSwimSessions.status);
  const staffSwimRows = Array.isArray(staffSwimSessions.data) ? staffSwimSessions.data : [];
  check("staff: swim list excludes beta site", !staffSwimRows.some(row => row.site_id === siteBetaId), "beta session visible");
  check("staff: swim list includes alpha site", staffSwimRows.some(row => row.site_id === siteAlphaId), "alpha session missing");
  const staffSwimBeta = await staff("GET", `/swim-track/sessions?siteId=${siteBetaId}`);
  expectOk("staff: GET /swim-track/sessions at inaccessible site returns empty", staffSwimBeta.status);
  check("staff: swim beta filter is empty", Array.isArray(staffSwimBeta.data) && staffSwimBeta.data.length === 0, "inaccessible site returned sessions");
  expectOk("staff: GET /swim-track/sessions at allowed site", (await staff("GET", `/swim-track/sessions?siteId=${siteAlphaId}`)).status);
  expectOk("staff: POST /swim-track/sessions at allowed site", (await staff("POST", "/swim-track/sessions", {
    sessionDate: uniqueDate(0), siteId: siteAlphaId,
  })).status, [201]);
  expectForbidden("staff: POST /swim-track/sessions at inaccessible site", (await staff("POST", "/swim-track/sessions", {
    sessionDate: uniqueDate(0), siteId: siteBetaId,
  })).status);
  expectBlocked("staff: POST /swim-track/sessions without siteId", (await staff("POST", "/swim-track/sessions", {
    sessionDate: uniqueDate(0),
  })).status);
  expectBlocked("staff: POST /swim-track/sessions with null siteId", (await staff("POST", "/swim-track/sessions", {
    sessionDate: uniqueDate(0), siteId: null,
  })).status);

  const staffFire = await staff("POST", "/fire-safety", {
    checkType: "alarm", callPoint: "CP1",
    checkDate: uniqueDate(0),
    result: "pass",
    siteId: siteAlphaId,
  });
  expectOk("staff: create attributed fire check", staffFire.status, [200, 201]);
  const staffDaily = await staff("POST", `/daily-checklists/${siteAlphaId}/${uniqueDate(0)}/am`, {
    answers: [{ question: "Opening check", checked: true }],
  });
  expectOk("staff: submit attributed daily checklist", staffDaily.status, [201]);
  // Mobile outbox replays (response lost after the server applied it) are
  // recognised by the device entry ID: same user and answers → 200 with the
  // stored row; anything else stays 409. Today's PM list (staff record lock).
  const replayPath = `/daily-checklists/${siteAlphaId}/${uniqueDate(0)}/pm`;
  const replayBody = {
    answers: [{ question: "Closing check", checked: true, notes: "Doors locked" }],
    clientEntryId: `daily-${Date.now().toString(36)}-replay-test`,
  };
  const firstSend = await staff("POST", replayPath, replayBody);
  expectOk("staff: submit daily checklist with device entry ID", firstSend.status, [201]);
  const replayed = await staff("POST", replayPath, replayBody);
  expectOk("staff: replayed device entry returns the stored submission", replayed.status, [200]);
  check("staff: replay does not create another submission",
    replayed.data?.id === firstSend.data?.id && replayed.data?.submittedById === firstSend.data?.submittedById,
    `first=${firstSend.data?.id} replay=${replayed.data?.id}`);
  expectOk("staff: reused device entry with different answers is rejected", (await staff("POST", replayPath, {
    ...replayBody, answers: [{ question: "Closing check", checked: false, result: "fail", notes: "Doors open" }],
  })).status, [409]);
  expectOk("staff: another device entry for a submitted checklist is rejected", (await staff("POST", replayPath, {
    ...replayBody, clientEntryId: `daily-${Date.now().toString(36)}-other-entry`,
  })).status, [409]);
  expectOk("admin: another user's device entry ID is not a replay",
    (await admin("POST", replayPath, replayBody)).status, [409]);
  const staffLegacyDaily = await staff("POST", "/daily-track-am", {
    siteId: siteAlphaId,
    checklistType: "kitchen_opening",
    checkDate: uniqueDate(1),
    items: [{ label: "Checked", checked: true, result: "pass" }],
    submittedAt: new Date().toISOString(),
  });
  expectOk("staff: submit legacy AM checklist", staffLegacyDaily.status, [201]);

  const departmentReport = await admin(
    "GET", `/reports/compliance?from=${uniqueDate(2)}&to=${uniqueDate(0)}&departmentId=${deptAlphaId}`,
  );
  expectOk("admin: creator-scoped department report", departmentReport.status);
  check(
    "admin: report labels selected department",
    departmentReport.data?.departmentName === "Dept Alpha"
      && departmentReport.data?.dailyChecklists?.every(row => row.departmentName === "Dept Alpha"),
    "department label missing from report",
  );
  check(
    "admin: only staff-authored FireTrack records counted",
    departmentReport.data?.moduleActivity?.find(row =>
      row.module === "FireTrack" && row.siteId === siteAlphaId)?.count === 1,
    "admin-authored fire check was included or staff check missing",
  );
  check(
    "admin: current and legacy AM submissions counted",
    departmentReport.data?.dailyChecklists?.find(row =>
      row.siteId === siteAlphaId && row.type === "am")?.submitted === 2,
    "current or legacy daily submission missing from department report",
  );
  const crossSiteDepartment = await admin(
    "GET", `/reports/compliance?from=${uniqueDate(2)}&to=${uniqueDate(0)}&departmentId=${deptAlphaId}&siteId=${siteBetaId}`,
  );
  expectOk("admin: can filter department at a different site", crossSiteDepartment.status);
  check(
    "admin: different-site department filter excludes other authors",
    crossSiteDepartment.data?.moduleActivity?.length === 0
      && crossSiteDepartment.data?.sites?.length === 1,
    "site-only department attribution leaked unrelated records",
  );

  // ── 6. Staff site access ─────────────────────────────────────────────────────

  // List — Alpha site visible, Beta site NOT visible.
  const staffSiteList = await staff("GET", "/sites");
  expectOk("staff: GET /sites", staffSiteList.status);
  const staffSites = Array.isArray(staffSiteList.data) ? staffSiteList.data : [];
  check(
    "staff: /sites includes alpha site",
    staffSites.some((s) => s.id === siteAlphaId),
    "alpha site missing from staff list",
  );
  check(
    "staff: /sites excludes beta site",
    !staffSites.some((s) => s.id === siteBetaId),
    "beta site visible in staff list",
  );

  // Direct GET — alpha → 200, beta → 403.
  expectOk(
    "staff: GET /sites/:id (own dept)",
    (await staff("GET", `/sites/${siteAlphaId}`)).status,
  );
  expectBlocked(
    "staff: GET /sites/:id (other dept)",
    (await staff("GET", `/sites/${siteBetaId}`)).status,
  );
  // The three Reports tabs must retain the active department and reject both
  // a department override and a site outside that department.
  const reportFrom = uniqueDate(2);
  const reportTo = uniqueDate();
  const staffCompliance = await staff(
    "GET",
    `/reports/compliance?from=${reportFrom}&to=${reportTo}`,
  );
  expectOk("staff: GET /reports/compliance (active department)", staffCompliance.status);
  check(
    "staff: compliance report excludes beta site",
    !(staffCompliance.data?.sites ?? []).some((site) => site.id === siteBetaId),
    "beta site appeared in active-department report",
  );
  const trend = await staff("GET", "/reports/compliance-trend?months=3");
  expectOk("staff: GET /reports/compliance-trend (active department)", trend.status);
  check(
    "staff: trend excludes beta site",
    !(trend.data?.series ?? []).some((series) => series.siteId === siteBetaId),
    "beta site appeared in active-department trend",
  );
  check(
    "staff: trend has three complete months",
    (trend.data?.months ?? []).length === 3
      && trend.data.to === new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 0)).toISOString().slice(0, 10),
    `months=${JSON.stringify(trend.data?.months)}, to=${trend.data?.to}`,
  );
  check(
    "staff: trend counts prior-month module record",
    (trend.data?.series ?? []).find((series) => series.siteId === siteAlphaId)
      ?.data.some((point) => point.month === lastMonthDate.slice(0, 7) && point.moduleRecordCount >= 1),
    "prior-month record missing from trend",
  );
  const priorMonthCount = trend.data?.series?.find((series) => series.siteId === siteAlphaId)
    ?.data.find((point) => point.month === lastMonthDate.slice(0, 7))?.moduleRecordCount;
  check(
    "staff: monthly module total matches visible sites",
    priorMonthCount >= 1
      && trend.data?.monthlyTotals?.find((total) => total.month === lastMonthDate.slice(0, 7))
        ?.moduleRecordCount === priorMonthCount,
    `monthly total did not match scoped series`,
  );
  for (const [label, path] of [
    ["compliance department override", `/reports/compliance?from=${reportFrom}&to=${reportTo}&departmentId=${deptBetaId}`],
    ["compliance foreign-department site", `/reports/compliance?from=${reportFrom}&to=${reportTo}&siteId=${siteBetaId}`],
    ["trend department override", `/reports/compliance-trend?months=3&departmentId=${deptBetaId}`],
    ["trend foreign-department site", `/reports/compliance-trend?months=3&siteId=${siteBetaId}`],
    ["risk department override", `/reports/risk-acknowledgements?departmentId=${deptBetaId}`],
    ["risk foreign-department site", `/reports/risk-acknowledgements?siteId=${siteBetaId}`],
  ]) {
    expectForbidden(`staff: report ${label}`, (await staff("GET", path)).status);
  }

  // PATCH — beta site must be blocked.
  expectBlocked(
    "staff: PATCH /sites/:id (other dept)",
    (await staff("PATCH", `/sites/${siteBetaId}`, { name: "hacked" })).status,
  );

  // ── 7. Staff compliance-item access ─────────────────────────────────────────

  // List — alpha items visible, beta items NOT visible.
  const staffItemList = await staff("GET", "/compliance-items");
  expectOk("staff: GET /compliance-items", staffItemList.status);
  const staffItems = Array.isArray(staffItemList.data)
    ? staffItemList.data
    : staffItemList.data?.items ?? [];
  if (betaItem) {
    check(
      "staff: /compliance-items excludes beta item",
      !staffItems.some((i) => i.id === betaItem.id),
      "beta dept item visible in staff list",
    );
  }
  if (alphaItem) {
    check(
      "staff: /compliance-items includes alpha item",
      staffItems.some((i) => i.id === alphaItem.id),
      "alpha dept item missing from staff list",
    );
  }

  // Direct GET — alpha → 200, beta → 403.
  if (alphaItem) {
    expectOk(
      "staff: GET /compliance-items/:id (own dept)",
      (await staff("GET", `/compliance-items/${alphaItem.id}`)).status,
    );
  }
  if (betaItem) {
    expectBlocked(
      "staff: GET /compliance-items/:id (other dept)",
      (await staff("GET", `/compliance-items/${betaItem.id}`)).status,
    );
  }

  // PATCH /status — staff can update own-dept item, blocked on other-dept item.
  if (alphaItem) {
    expectOk(
      "staff: PATCH /compliance-items/:id/status (own dept)",
      (await staff("PATCH", `/compliance-items/${alphaItem.id}/status`, { status: "in_progress" })).status,
    );
  }
  if (betaItem) {
    expectBlocked(
      "staff: PATCH /compliance-items/:id/status (other dept)",
      (await staff("PATCH", `/compliance-items/${betaItem.id}/status`, { status: "in_progress" })).status,
    );
  }

  // ── 8. Staff fire-safety access (if siteId is supported on that route) ───────
  if (fireAlphaId && fireBetaId) {
    // Staff cannot PUT a fire-safety check that belongs to the beta site.
    expectBlocked(
      "staff: PUT /fire-safety/:id (other dept)",
      (await staff("PUT", `/fire-safety/${fireBetaId}`, { result: "fail" })).status,
    );
    // Staff can see their own fire-safety records.
    const staffFireList = await staff("GET", "/fire-safety");
    expectOk("staff: GET /fire-safety", staffFireList.status);
    const staffFire = Array.isArray(staffFireList.data) ? staffFireList.data : [];
    check(
      "staff: /fire-safety excludes beta check",
      !staffFire.some((r) => r.id === fireBetaId),
      "beta fire-safety check visible in staff list",
    );
  }

  // ── 8b. Staff legionella access ───────────────────────────────────────────────
  if (legAlphaId && legBetaId) {
    const staffLegList = await staff("GET", "/legionella");
    expectOk("staff: GET /legionella", staffLegList.status);
    const staffLeg = Array.isArray(staffLegList.data) ? staffLegList.data : [];
    check(
      "staff: /legionella includes alpha check",
      staffLeg.some((r) => r.id === legAlphaId),
      "alpha legionella check missing from staff list",
    );
    check(
      "staff: /legionella excludes beta check",
      !staffLeg.some((r) => r.id === legBetaId),
      "beta legionella check visible in staff list",
    );
    expectForbidden(
      "staff: PUT /legionella/:id (other dept)",
      (await staff("PUT", `/legionella/${legBetaId}`, { result: "fail" })).status,
    );
  }
  const alphaStatus = await staff("GET", `/legionella/status?siteId=${siteAlphaId}`);
  expectOk("staff: GET /legionella/status for alpha site", alphaStatus.status);
  check("staff: alpha status includes alpha reading",
    alphaStatus.data?.find(row => row.checkType === "calorifier_temp")?.lastDate === uniqueDate(1),
    "alpha check date missing or replaced");
  expectForbidden("staff: GET /legionella/status for beta site",
    (await staff("GET", `/legionella/status?siteId=${siteBetaId}`)).status);
  const unselectedStatus = await staff("GET", "/legionella/status");
  expectOk("staff: GET /legionella/status without a site", unselectedStatus.status);
  check("staff: status without a site has no beta readings",
    Array.isArray(unselectedStatus.data) && unselectedStatus.data.every(row => row.lastDate == null),
    "site-specific reading visible without selecting a site");

  const adminOutlets = await admin("GET", "/legionella/outlets");
  expectOk("admin: GET /legionella/outlets", adminOutlets.status);
  check("admin: can see both department outlets",
    Array.isArray(adminOutlets.data) && [outletAlphaId, outletBetaId].every(id =>
      adminOutlets.data.some(row => row.id === id)), "department outlet missing for admin");
  const staffOutlets = await staff("GET", "/legionella/outlets");
  expectOk("staff: GET /legionella/outlets", staffOutlets.status);
  check("staff: outlets include alpha but exclude beta",
    Array.isArray(staffOutlets.data) &&
      staffOutlets.data.some(row => row.id === outletAlphaId && row.site_id === siteAlphaId) &&
      !staffOutlets.data.some(row => row.id === outletBetaId || row.site_id === siteBetaId),
    "alpha outlet missing or beta outlet visible");

  const adminOutletStatus = await admin("GET", "/legionella/outlet-status");
  expectOk("admin: GET /legionella/outlet-status", adminOutletStatus.status);
  check("admin: both outlets show their monthly checks",
    Array.isArray(adminOutletStatus.data) && [outletAlphaId, outletBetaId].every(id =>
      adminOutletStatus.data.some(row => row.id === id && row.testedThisMonth &&
        row.thisMonthChecks?.length > 0)), "admin monthly check missing");
  const staffOutletStatus = await staff("GET", "/legionella/outlet-status");
  expectOk("staff: GET /legionella/outlet-status", staffOutletStatus.status);
  check("staff: outlet status includes alpha reading but excludes beta outlet and reading",
    Array.isArray(staffOutletStatus.data) &&
      staffOutletStatus.data.some(row => row.id === outletAlphaId && row.siteId === siteAlphaId &&
        row.thisMonthChecks?.some(reading => reading.id === alphaReading.data?.id)) &&
      !staffOutletStatus.data.some(row => row.id === outletBetaId || row.siteId === siteBetaId ||
        row.thisMonthChecks?.some(reading =>
          reading.id === betaReading.data?.id || reading.id === crossSiteReading.data?.id)),
    "alpha reading missing or beta outlet/reading visible");

  // ── 8b-ii. Outlet create/edit/delete need access to the outlet's site ─────────
  const betaStaffEmail = `dept-staff-beta-${ts}@test.local`;
  expectOk("admin: create beta staff user", (await admin("POST", "/users", {
    name: "Staff Beta", email: betaStaffEmail, password: staffPassword,
    role: "client_staff", clientId, departmentId: deptBetaId,
  })).status, [200, 201]);
  const betaStaff = makeSession();
  expectOk("beta staff: login", (await betaStaff("POST", "/auth/login", {
    email: betaStaffEmail, password: staffPassword,
  })).status, [200, 201]);
  for (const [who, session, ownSiteId, otherSiteId, otherOutletId] of [
    ["alpha staff", staff, siteAlphaId, siteBetaId, outletBetaId],
    ["beta staff", betaStaff, siteBetaId, siteAlphaId, outletAlphaId],
  ]) {
    expectForbidden(`${who}: cannot add an outlet at the other department's site`,
      (await session("POST", "/legionella/outlets", { name: `${who} cross outlet ${ts}`, type: "hot", siteId: otherSiteId })).status);
    expectBlocked(`${who}: cannot add an outlet at an unknown site`,
      (await session("POST", "/legionella/outlets", { name: `${who} unknown-site outlet ${ts}`, type: "hot", siteId: 2147480000 })).status);
    expectForbidden(`${who}: cannot edit the other department's outlet`,
      (await session("PUT", `/legionella/outlets/${otherOutletId}`, { name: `${who} renamed ${ts}` })).status);
    expectForbidden(`${who}: cannot remove the other department's outlet`,
      (await session("DELETE", `/legionella/outlets/${otherOutletId}`)).status);
    const own = await session("POST", "/legionella/outlets", { name: `${who} outlet ${ts}`, type: "cold", siteId: ownSiteId });
    expectOk(`${who}: can add an outlet at own site`, own.status, [201]);
    expectOk(`${who}: can rename own outlet`,
      (await session("PUT", `/legionella/outlets/${own.data?.id}`, { name: `${who} outlet renamed ${ts}` })).status);
    expectForbidden(`${who}: cannot move own outlet to the other department's site`,
      (await session("PUT", `/legionella/outlets/${own.data?.id}`, { siteId: otherSiteId })).status);
    expectOk(`${who}: can remove own outlet`, (await session("DELETE", `/legionella/outlets/${own.data?.id}`)).status, [204]);
  }
  const outletsAfterStaff = await admin("GET", "/legionella/outlets");
  check("admin: refused staff changes left both department outlets as they were",
    [[outletAlphaId, siteAlphaId, `Alpha sentinel ${ts}`], [outletBetaId, siteBetaId, `Beta sentinel ${ts}`]].every(([id, site, name]) =>
      outletsAfterStaff.data?.some?.(row => row.id === id && row.site_id === site && row.name === name)),
    "a department outlet was renamed, moved or removed");
  // Account-wide admins manage outlets at every site.
  for (const [label, siteId] of [["alpha", siteAlphaId], ["beta", siteBetaId]]) {
    const created = await admin("POST", "/legionella/outlets", { name: `Admin ${label} outlet ${ts}`, type: "hot", siteId });
    expectOk(`admin: add outlet at ${label} site`, created.status, [201]);
    expectOk(`admin: edit outlet at ${label} site`,
      (await admin("PUT", `/legionella/outlets/${created.data?.id}`, { siteId: label === "alpha" ? siteBetaId : siteAlphaId })).status);
    expectOk(`admin: remove outlet moved from ${label} site`,
      (await admin("DELETE", `/legionella/outlets/${created.data?.id}`)).status, [204]);
  }

  // ── 8c. Viewer (read-only) department scoping ─────────────────────────────────
  const viewerEmail = `dept-viewer-alpha-${ts}@test.local`;
  const viewerPassword = "password-789";
  const createViewerRes = await admin("POST", "/users", {
    name: "Viewer Alpha",
    email: viewerEmail,
    password: viewerPassword,
    role: "client_viewer",
    clientId,
    departmentId: deptAlphaId,
  });
  expectOk("admin: create viewer user", createViewerRes.status, [200, 201]);

  const viewer = makeSession();
  const viewerLogin = await viewer("POST", "/auth/login", {
    email: viewerEmail,
    password: viewerPassword,
  });
  expectOk("viewer: login", viewerLogin.status, [200, 201]);

  // Viewers see only their own training records, so even their own
  // department's sites and items are closed to them.
  for (const path of ["/sites", `/sites/${siteAlphaId}`, `/sites/${siteBetaId}`, "/compliance-items",
    ...(betaItem ? [`/compliance-items/${betaItem.id}`] : [])]) {
    expectForbidden(`viewer: GET ${path} refused`, (await viewer("GET", path)).status);
  }

  // All viewer mutations must be rejected, even in their own dept.
  expectForbidden(
    "viewer: POST /fire-safety rejected",
    (await viewer("POST", "/fire-safety", {
      checkType: "alarm", callPoint: "CP1",
      checkDate: uniqueDate(0),
      result: "pass",
      siteId: siteAlphaId,
    })).status,
  );

  // An unassigned staff/viewer account must never silently become tenant-wide.
  // It may still see explicitly site-neutral records, but neither department.
  for (const role of ["client_staff", "client_viewer"]) {
    const email = `dept-unassigned-${role}-${ts}@test.local`;
    const created = await admin("POST", "/users", {
      name: `Unassigned ${role}`, email, password: "password-000", role, clientId,
    });
    expectOk(`unassigned ${role}: create`, created.status, [200, 201]);
    const session = makeSession();
    expectOk(`unassigned ${role}: login`, (await session("POST", "/auth/login", {
      email, password: "password-000",
    })).status, [200, 201]);
    const scopedSites = await session("GET", "/sites");
    if (role === "client_viewer") {
      expectForbidden(`unassigned ${role}: GET /sites refused`, scopedSites.status);
      continue;
    }
    expectOk(`unassigned ${role}: GET /sites`, scopedSites.status);
    const rows = Array.isArray(scopedSites.data) ? scopedSites.data : [];
    check(`unassigned ${role}: excludes alpha department`, !rows.some(s => s.id === siteAlphaId), "alpha site visible");
    check(`unassigned ${role}: excludes beta department`, !rows.some(s => s.id === siteBetaId), "beta site visible");
    expectBlocked(`unassigned ${role}: direct alpha site`, (await session("GET", `/sites/${siteAlphaId}`)).status);
    // Full exports are management-only, so no staff/viewer can use them to
    // evade the same department boundary.
    expectBlocked(`unassigned ${role}: export rejected`, (await session("GET", "/export")).status);
  }
  expectForbidden(
    "viewer: POST /legionella rejected",
    (await viewer("POST", "/legionella", {
      checkType: "calorifier_temp",
      checkDate: uniqueDate(0),
      result: "pass",
      siteId: siteAlphaId,
    })).status,
  );
  if (fireAlphaId) {
    expectForbidden(
      "viewer: PUT /fire-safety/:id rejected (own dept)",
      (await viewer("PUT", `/fire-safety/${fireAlphaId}`, { result: "fail" })).status,
    );
    expectForbidden(
      "viewer: DELETE /fire-safety/:id rejected (own dept)",
      (await viewer("DELETE", `/fire-safety/${fireAlphaId}`)).status,
    );
  }
  if (legAlphaId) {
    expectForbidden(
      "viewer: PUT /legionella/:id rejected (own dept)",
      (await viewer("PUT", `/legionella/${legAlphaId}`, { result: "fail" })).status,
    );
    expectForbidden(
      "viewer: DELETE /legionella/:id rejected (own dept)",
      (await viewer("DELETE", `/legionella/${legAlphaId}`)).status,
    );
  }
  if (fireBetaId) {
    expectForbidden(
      "viewer: PUT /fire-safety/:id rejected (other dept)",
      (await viewer("PUT", `/fire-safety/${fireBetaId}`, { result: "fail" })).status,
    );
  }
  if (legBetaId) {
    expectForbidden(
      "viewer: PUT /legionella/:id rejected (other dept)",
      (await viewer("PUT", `/legionella/${legBetaId}`, { result: "fail" })).status,
    );
  }

  // Viewers must be rejected on representative mutations in every module.
  const viewerMutationAttempts = [
    ["POST /food-safety", "POST", "/food-safety", { recordDate: uniqueDate(0) }],
    ["PUT /food-safety/config", "PUT", "/food-safety/config", { food_num_fridges: "2" }],
    ["POST /incidents", "POST", "/incidents", { siteId: siteAlphaId, incidentDate: uniqueDate(0), description: "x" }],
    ["POST /hot-tub/tubs", "POST", "/hot-tub/tubs", { name: "Tub" }],
    ["POST /pat-track/appliances", "POST", "/pat-track/appliances", { name: "Kettle" }],
    ["POST /pest-track/visits", "POST", "/pest-track/visits", { visitDate: uniqueDate(0) }],
    ["POST /pool-track", "POST", "/pool-track", { checkDate: uniqueDate(0) }],
    ["POST /tree-track", "POST", "/tree-track", { checkDate: uniqueDate(0) }],
    ["POST /bike-track/bikes", "POST", "/bike-track/bikes", { name: "Bike 1" }],
    ["POST /train-track/records", "POST", "/train-track/records", { staffName: "X", courseName: "Y" }],
    ["POST /doc-track/documents", "POST", "/doc-track/documents", { title: "Doc" }],
    ["POST /staff-roster", "POST", "/staff-roster", { name: "Someone" }],
    ["POST /photos/request-upload", "POST", "/photos/request-upload", { fileName: "a.jpg" }],
    ["POST /kitchen-cleaning/tasks", "POST", "/kitchen-cleaning/tasks", { name: "Wipe" }],
    ["POST /swim-track/sessions", "POST", "/swim-track/sessions", { sessionDate: uniqueDate(0) }],
    ["POST /green-track/pre-use-checks", "POST", "/green-track/pre-use-checks", { checkDate: uniqueDate(0) }],
    ["POST /daily-track-am", "POST", "/daily-track-am", { recordDate: uniqueDate(0) }],
    ["POST /daily-track-pm", "POST", "/daily-track-pm", { recordDate: uniqueDate(0) }],
    ["POST /daily-checklists", "POST", `/daily-checklists/${siteAlphaId}/${uniqueDate(0)}/am`, {}],
    ["POST /kitchen-weekly/weekly", "POST", "/kitchen-weekly/weekly", { weekCommencing: uniqueDate(0) }],
    ["POST /premises-track", "POST", "/premises-track", { checkDate: uniqueDate(0) }],
    ["POST /room-track/checks", "POST", "/room-track/checks", { checkDate: uniqueDate(0) }],
    ["POST /safe-track/risk-assessments", "POST", "/safe-track/risk-assessments", { title: "Viewer write" }],
    ["POST /track-actions", "POST", "/track-actions", { title: "Viewer write" }],
    ["POST /fix-track/issues", "POST", "/fix-track/issues", { title: "Leak" }],
    ["PATCH /compliance-items/:id/status", "PATCH", `/compliance-items/${alphaItem ? alphaItem.id : 0}/status`, { status: "compliant" }],
    ["POST /storage/uploads/request-url", "POST", "/storage/uploads/request-url", { fileName: "a.pdf" }],
  ];
  for (const [label, method, path, body] of viewerMutationAttempts) {
    expectForbidden(`viewer: ${label} rejected`, (await viewer(method, path, body)).status);
  }

  // ── 9. Admin bypasses all department filtering ────────────────────────────────
  expectOk(
    "admin: GET /sites/:id (alpha)",
    (await admin("GET", `/sites/${siteAlphaId}`)).status,
  );
  expectOk(
    "admin: GET /sites/:id (beta)",
    (await admin("GET", `/sites/${siteBetaId}`)).status,
  );
  if (alphaItem) {
    expectOk(
      "admin: GET /compliance-items/:id (alpha)",
      (await admin("GET", `/compliance-items/${alphaItem.id}`)).status,
    );
  }
  if (betaItem) {
    expectOk(
      "admin: GET /compliance-items/:id (beta)",
      (await admin("GET", `/compliance-items/${betaItem.id}`)).status,
    );
  }

  // Admin can see both sites in list.
  const adminSiteList = await admin("GET", "/sites");
  expectOk("admin: GET /sites", adminSiteList.status);
  const adminSites = Array.isArray(adminSiteList.data) ? adminSiteList.data : [];
  check(
    "admin: /sites includes alpha site",
    adminSites.some((s) => s.id === siteAlphaId),
    "alpha site missing from admin list",
  );
  check(
    "admin: /sites includes beta site",
    adminSites.some((s) => s.id === siteBetaId),
    "beta site missing from admin list",
  );

  // ── 10. Department moves keep past report totals fixed ─────────────────────
  // Records keep the department their author belonged to when each was
  // created; a later move, an edit or the author's other sites never move them.
  const annexAlpha = await admin("POST", "/sites", { name: `Alpha Annex ${ts}`, departmentId: deptAlphaId });
  const annexBeta = await admin("POST", "/sites", { name: `Beta Annex ${ts}`, departmentId: deptBetaId });
  expectOk("transfer: create Alpha Annex", annexAlpha.status, [200, 201]);
  expectOk("transfer: create Beta Annex", annexBeta.status, [200, 201]);
  const annexAlphaId = annexAlpha.data?.id;
  const annexBetaId = annexBeta.data?.id;
  const moverEmail = `dept-mover-${ts}@test.local`;
  const moverPassword = "password-789";
  const moverRes = await admin("POST", "/users", {
    name: "Moving Staff", email: moverEmail, password: moverPassword,
    role: "client_staff", clientId, departmentId: deptAlphaId,
  });
  expectOk("transfer: create staff in Alpha", moverRes.status, [200, 201]);
  const moverId = moverRes.data?.id;
  const mover = makeSession();
  expectOk("transfer: staff web login", (await mover("POST", "/auth/login", {
    email: moverEmail, password: moverPassword,
  })).status, [200, 201]);
  const mobileLogin = await makeSession()("POST", "/auth/mobile-login", { email: moverEmail, password: moverPassword });
  expectOk("transfer: staff mobile login", mobileLogin.status);
  check("transfer: mobile login returns a bearer token", typeof mobileLogin.data?.token === "string",
    JSON.stringify(mobileLogin.data));
  const moverMobile = makeBearerSession(mobileLogin.data?.token ?? "missing");

  const today10 = uniqueDate(0);
  const range = `from=${uniqueDate(1)}&to=${today10}`;
  const fireAt = (session, siteId) => session("POST", "/fire-safety", {
    checkType: "alarm", checkDate: today10, result: "pass", siteId,
  });
  const webFire = await fireAt(mover, annexAlphaId);
  expectOk("transfer: web fire check while in Alpha", webFire.status, [200, 201]);
  expectOk("transfer: mobile fire check while in Alpha", (await fireAt(moverMobile, annexAlphaId)).status, [200, 201]);
  expectOk("transfer: mobile AM checklist while in Alpha", (await moverMobile("POST",
    `/daily-checklists/${annexAlphaId}/${today10}/am`, {
      answers: [{ question: "Opening check", checked: true }],
    })).status, [201]);

  const report = async (deptId, siteId) => {
    const res = await admin("GET", `/reports/compliance?${range}&departmentId=${deptId}${siteId ? `&siteId=${siteId}` : ""}`);
    expectOk(`transfer: department ${deptId} report${siteId ? ` at site ${siteId}` : ""}`, res.status);
    return res.data ?? {};
  };
  const fireCount = (data, siteId) =>
    data.moduleActivity?.find(row => row.module === "FireTrack" && row.siteId === siteId)?.count ?? 0;
  const amDays = (data, siteId) =>
    data.dailyChecklists?.find(row => row.siteId === siteId && row.type === "am")?.submitted ?? 0;

  const alphaBefore = await report(deptAlphaId, annexAlphaId);
  check("transfer: Alpha counts web and mobile fire checks", fireCount(alphaBefore, annexAlphaId) === 2,
    JSON.stringify(alphaBefore.moduleActivity));
  check("transfer: Alpha counts the mobile AM checklist", amDays(alphaBefore, annexAlphaId) === 1,
    JSON.stringify(alphaBefore.dailyChecklists));
  check("transfer: report says how departments are attributed",
    alphaBefore.attribution === "recorded_at_submission"
      && alphaBefore.departmentNotRecorded?.label === "Department not recorded",
    JSON.stringify({ attribution: alphaBefore.attribution, notRecorded: alphaBefore.departmentNotRecorded }));

  expectOk("transfer: move staff to Beta", (await admin("PUT", `/users/${moverId}`, { departmentId: deptBetaId })).status);
  expectOk("transfer: web fire check after moving to Beta", (await fireAt(mover, annexBetaId)).status, [200, 201]);
  expectOk("transfer: mobile AM checklist after moving to Beta", (await moverMobile("POST",
    `/daily-checklists/${annexBetaId}/${today10}/am`, {
      answers: [{ question: "Opening check", checked: true }],
    })).status, [201]);
  expectOk("transfer: admin edits a pre-move record", (await admin("PUT", `/fire-safety/${webFire.data?.id}`, {
    notes: `Edited after the move ${ts}`,
  })).status);

  const alphaAfter = await report(deptAlphaId, annexAlphaId);
  check("transfer: Alpha's past fire total is unchanged", fireCount(alphaAfter, annexAlphaId) === 2,
    JSON.stringify(alphaAfter.moduleActivity));
  check("transfer: Alpha's past AM total is unchanged", amDays(alphaAfter, annexAlphaId) === 1,
    JSON.stringify(alphaAfter.dailyChecklists));
  const alphaAll = await report(deptAlphaId);
  check("transfer: post-move Beta work is not counted for Alpha",
    fireCount(alphaAll, annexBetaId) === 0 && !alphaAll.sites?.some(site => site.id === annexBetaId),
    JSON.stringify(alphaAll.moduleActivity));
  const betaAtAlphaAnnex = await report(deptBetaId, annexAlphaId);
  check("transfer: pre-move Alpha work does not follow the staff member to Beta",
    fireCount(betaAtAlphaAnnex, annexAlphaId) === 0 && amDays(betaAtAlphaAnnex, annexAlphaId) === 0,
    JSON.stringify(betaAtAlphaAnnex));
  const betaAnnexReport = await report(deptBetaId, annexBetaId);
  check("transfer: Beta counts post-move web and mobile work",
    fireCount(betaAnnexReport, annexBetaId) === 1 && amDays(betaAnnexReport, annexBetaId) === 1,
    JSON.stringify(betaAnnexReport));
  const alphaAtBetaAnnex = await report(deptAlphaId, annexBetaId);
  check("transfer: Alpha filtered to a Beta site shows none of the post-move work",
    (alphaAtBetaAnnex.moduleActivity?.length ?? -1) === 0 && amDays(alphaAtBetaAnnex, annexBetaId) === 0,
    JSON.stringify(alphaAtBetaAnnex));

  // Database checks: what was stored, that it can't be rewritten, cross-tenant
  // authors, and rows from before departments were recorded.
  const outsiderEmail = `dept-outsider-${ts}@test.local`;
  const outsider = makeSession();
  const outsiderReg = await outsider("POST", "/auth/register", {
    name: "Other Tenant Admin", email: outsiderEmail, password: "password-123",
  });
  expectOk("cross-tenant: register another business", outsiderReg.status, [200, 201]);
  if (outsiderReg.data?.verificationToken) {
    await outsider("GET", `/auth/verify-email?token=${encodeURIComponent(outsiderReg.data.verificationToken)}`);
    await outsider("POST", "/auth/login", { email: outsiderEmail, password: "password-123" });
  }
  const outsiderMe = await outsider("GET", "/auth/me");
  const outsiderClientId = (outsiderMe.data?.user ?? outsiderMe.data)?.clientId;
  const outsiderDept = await outsider("POST", "/departments", { name: "Other Tenant Dept" });
  expectOk("cross-tenant: create department in the other business", outsiderDept.status, [200, 201]);
  const outsiderStaff = await outsider("POST", "/users", {
    name: "Other Tenant Staff", email: `dept-outsider-staff-${ts}@test.local`, password: "password-456",
    role: "client_staff", clientId: outsiderClientId, departmentId: outsiderDept.data?.id,
  });
  expectOk("cross-tenant: create staff in the other business", outsiderStaff.status, [200, 201]);

  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const stored = await client.query(
      `SELECT site_id, submitter_department_id, submitter_department_source FROM fire_safety_checks
       WHERE client_id = $1 AND created_by = $2 ORDER BY id`, [clientId, moverId]);
    check("db: each fire check stores the department at creation",
      JSON.stringify(stored.rows.map(r => [r.site_id, r.submitter_department_id, r.submitter_department_source]))
        === JSON.stringify([[annexAlphaId, deptAlphaId, "recorded"], [annexAlphaId, deptAlphaId, "recorded"], [annexBetaId, deptBetaId, "recorded"]]),
      JSON.stringify(stored.rows));
    const mobileDaily = await client.query(
      `SELECT site_id, submitter_department_id FROM daily_checklist_submissions
       WHERE client_id = $1 AND submitted_by_id = $2 ORDER BY id`, [clientId, moverId]);
    check("db: bearer daily submissions store the department at creation",
      JSON.stringify(mobileDaily.rows.map(r => [r.site_id, r.submitter_department_id]))
        === JSON.stringify([[annexAlphaId, deptAlphaId], [annexBetaId, deptBetaId]]),
      JSON.stringify(mobileDaily.rows));

    await client.query(
      `UPDATE fire_safety_checks SET submitter_department_id = $1, submitter_department_source = 'not_recorded'
       WHERE id = $2`, [deptBetaId, webFire.data?.id]);
    const pinned = await client.query(
      `SELECT submitter_department_id, submitter_department_source FROM fire_safety_checks WHERE id = $1`, [webFire.data?.id]);
    check("db: a recorded department can't be rewritten",
      pinned.rows[0]?.submitter_department_id === deptAlphaId && pinned.rows[0]?.submitter_department_source === "recorded",
      JSON.stringify(pinned.rows));

    const forged = await client.query(
      `INSERT INTO fire_safety_checks (client_id, site_id, check_type, check_date, result, created_by,
         submitter_department_id, submitter_department_source)
       VALUES ($1, $2, 'alarm', $3, 'pass', $4, $5, 'not_recorded')
       RETURNING submitter_department_id, submitter_department_source`,
      [clientId, annexAlphaId, today10, outsiderStaff.data?.id, deptAlphaId]);
    check("db: another business's account records no department here",
      forged.rows[0]?.submitter_department_id === null && forged.rows[0]?.submitter_department_source === "recorded",
      JSON.stringify(forged.rows));

    // Rows written before capture began (simulated with the trigger off, inside
    // one transaction so nothing else sees it disabled).
    await client.query("BEGIN");
    for (const table of ["fire_safety_checks", "daily_checklist_submissions"]) {
      await client.query(`ALTER TABLE ${table} DISABLE TRIGGER record_submitter_department`);
    }
    await client.query(
      `INSERT INTO fire_safety_checks (client_id, site_id, check_type, check_date, result, created_by,
         submitter_department_id, submitter_department_source)
       VALUES ($1, $2, 'alarm', $3, 'pass', $4, NULL, 'not_recorded')`,
      [clientId, annexAlphaId, uniqueDate(1), moverId]);
    await client.query(
      `INSERT INTO daily_checklist_submissions (client_id, site_id, checklist_date, type, answers,
         submitted_by_id, submitted_at, submitter_department_id, submitter_department_source)
       VALUES ($1, $2, $3, 'pm', '[]'::jsonb, $4, now(), NULL, 'not_recorded')`,
      [clientId, annexAlphaId, uniqueDate(1), moverId]);
    for (const table of ["fire_safety_checks", "daily_checklist_submissions"]) {
      await client.query(`ALTER TABLE ${table} ENABLE TRIGGER record_submitter_department`);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    check("db: attribution checks ran", false, String(err?.message ?? err));
  } finally {
    await client.end();
  }

  for (const [label, deptId] of [["Alpha", deptAlphaId], ["Beta", deptBetaId]]) {
    const data = await report(deptId, annexAlphaId);
    const notRecorded = data.departmentNotRecorded ?? {};
    check(`legacy: ${label} report lists older records under "Department not recorded"`,
      notRecorded.moduleActivity?.find(row => row.module === "FireTrack" && row.siteId === annexAlphaId)?.count === 1
        && notRecorded.dailyChecklists?.find(row => row.siteId === annexAlphaId && row.type === "pm")?.submitted === 1
        && notRecorded.records === 2,
      JSON.stringify(notRecorded));
    check(`legacy: ${label} totals don't absorb older records`,
      fireCount(data, annexAlphaId) === (label === "Alpha" ? 2 : 0)
        && (data.dailyChecklists?.find(row => row.siteId === annexAlphaId && row.type === "pm")?.submitted ?? 0) === 0,
      JSON.stringify({ moduleActivity: data.moduleActivity, dailyChecklists: data.dailyChecklists }));
  }

  // ── Summary ───────────────────────────────────────────────────────────────────
  console.log(`\n${passed} checks passed, ${failures.length} failed.`);
  if (failures.length > 0) {
    console.error("\nFailures:");
    for (const f of failures) console.error(` - ${f}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Test run crashed:", err);
  process.exit(1);
});
