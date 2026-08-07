// Department-isolation integration tests.
//
// Verifies that client_staff users scoped to a specific department can only
// access sites, compliance items, and module checks that belong to their
// department. Admins bypass all department filtering.
//
// Flow:
//   1. Admin registers and creates two departments (Alpha, Beta).
//   2. Admin creates one site per department with seeded compliance checks.
//   3. Admin creates a staff user assigned to Department Alpha.
//   4. Staff logs in; tests confirm they see only Alpha resources.
//   5. Admin confirms unrestricted access to both departments.
//
// Usage: node tests/dept-isolation.mjs  (API must be running on API_BASE)
// Exits 0 when every check passes, 1 otherwise.

const BASE = process.env.API_BASE || "http://localhost:8080/api";

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

function expectOk(name, status, allowed = [200, 201]) {
  check(name, allowed.includes(status), `expected ${allowed.join("/")}, got ${status}`);
}

function makeSession() {
  let cookie = "";
  return async function request(method, path, body) {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(cookie ? { cookie } : {}),
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
  const uniqueDate = (offset = 0) => {
    const d = new Date();
    d.setDate(d.getDate() - offset);
    return d.toISOString().slice(0, 10);
  };

  const fireAlpha = await admin("POST", "/fire-safety", {
    checkType: "alarm",
    checkDate: uniqueDate(1),
    result: "pass",
    siteId: siteAlphaId,
  });
  // Fire-safety POST may or may not require siteId; we record the id if it succeeded.
  const fireAlphaId = fireAlpha.status === 201 ? fireAlpha.data?.id : null;

  const fireBeta = await admin("POST", "/fire-safety", {
    checkType: "alarm",
    checkDate: uniqueDate(2),
    result: "pass",
    siteId: siteBetaId,
  });
  const fireBetaId = fireBeta.status === 201 ? fireBeta.data?.id : null;

  // Add legionella checks on both sites via admin
  const legAlpha = await admin("POST", "/legionella", {
    checkType: "calorifier_temp",
    checkDate: uniqueDate(1),
    result: "pass",
    siteId: siteAlphaId,
  });
  const legAlphaId = [200, 201].includes(legAlpha.status) ? legAlpha.data?.id : null;
  check("admin: create alpha legionella check", legAlphaId != null, `status=${legAlpha.status}`);

  const legBeta = await admin("POST", "/legionella", {
    checkType: "calorifier_temp",
    checkDate: uniqueDate(2),
    result: "pass",
    siteId: siteBetaId,
  });
  const legBetaId = [200, 201].includes(legBeta.status) ? legBeta.data?.id : null;
  check("admin: create beta legionella check", legBetaId != null, `status=${legBeta.status}`);

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

  // ── 5. Staff logs in ─────────────────────────────────────────────────────────
  const staff = makeSession();
  const staffLogin = await staff("POST", "/auth/login", {
    email: staffEmail,
    password: staffPassword,
  });
  expectOk("staff: login", staffLogin.status, [200, 201]);

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
    expectBlocked(
      "staff: PUT /legionella/:id (other dept)",
      (await staff("PUT", `/legionella/${legBetaId}`, { result: "fail" })).status,
    );
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

  const viewerSiteList = await viewer("GET", "/sites");
  expectOk("viewer: GET /sites", viewerSiteList.status);
  const viewerSites = Array.isArray(viewerSiteList.data) ? viewerSiteList.data : [];
  check(
    "viewer: /sites includes alpha site",
    viewerSites.some((s) => s.id === siteAlphaId),
    "alpha site missing from viewer list",
  );
  check(
    "viewer: /sites excludes beta site",
    !viewerSites.some((s) => s.id === siteBetaId),
    "beta site visible in viewer list",
  );
  expectOk(
    "viewer: GET /sites/:id (own dept)",
    (await viewer("GET", `/sites/${siteAlphaId}`)).status,
  );
  expectBlocked(
    "viewer: GET /sites/:id (other dept)",
    (await viewer("GET", `/sites/${siteBetaId}`)).status,
  );

  const viewerItemList = await viewer("GET", "/compliance-items");
  expectOk("viewer: GET /compliance-items", viewerItemList.status);
  const viewerItems = Array.isArray(viewerItemList.data)
    ? viewerItemList.data
    : viewerItemList.data?.items ?? [];
  if (alphaItem) {
    check(
      "viewer: /compliance-items includes alpha item",
      viewerItems.some((i) => i.id === alphaItem.id),
      "alpha item missing from viewer list",
    );
  }
  if (betaItem) {
    check(
      "viewer: /compliance-items excludes beta item",
      !viewerItems.some((i) => i.id === betaItem.id),
      "beta dept item visible in viewer list",
    );
    expectBlocked(
      "viewer: GET /compliance-items/:id (other dept)",
      (await viewer("GET", `/compliance-items/${betaItem.id}`)).status,
    );
  }

  // Viewers are read-only: all mutations must be rejected, even in their own dept.
  expectBlocked(
    "viewer: POST /fire-safety rejected",
    (await viewer("POST", "/fire-safety", {
      checkType: "alarm",
      checkDate: uniqueDate(0),
      result: "pass",
      siteId: siteAlphaId,
    })).status,
  );
  expectBlocked(
    "viewer: POST /legionella rejected",
    (await viewer("POST", "/legionella", {
      checkType: "calorifier_temp",
      checkDate: uniqueDate(0),
      result: "pass",
      siteId: siteAlphaId,
    })).status,
  );
  if (fireAlphaId) {
    expectBlocked(
      "viewer: PUT /fire-safety/:id rejected (own dept)",
      (await viewer("PUT", `/fire-safety/${fireAlphaId}`, { result: "fail" })).status,
    );
    expectBlocked(
      "viewer: DELETE /fire-safety/:id rejected (own dept)",
      (await viewer("DELETE", `/fire-safety/${fireAlphaId}`)).status,
    );
  }
  if (legAlphaId) {
    expectBlocked(
      "viewer: PUT /legionella/:id rejected (own dept)",
      (await viewer("PUT", `/legionella/${legAlphaId}`, { result: "fail" })).status,
    );
    expectBlocked(
      "viewer: DELETE /legionella/:id rejected (own dept)",
      (await viewer("DELETE", `/legionella/${legAlphaId}`)).status,
    );
  }
  if (fireBetaId) {
    expectBlocked(
      "viewer: PUT /fire-safety/:id rejected (other dept)",
      (await viewer("PUT", `/fire-safety/${fireBetaId}`, { result: "fail" })).status,
    );
  }
  if (legBetaId) {
    expectBlocked(
      "viewer: PUT /legionella/:id rejected (other dept)",
      (await viewer("PUT", `/legionella/${legBetaId}`, { result: "fail" })).status,
    );
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
