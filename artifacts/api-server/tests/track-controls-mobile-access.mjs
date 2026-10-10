// Mobile (bearer-session) access to the site-scoped FireTrack and
// LegionellaTrack control profiles, status and history.
//
// The mobile app reads these with only `Authorization: Bearer <token>` from
// /auth/mobile-login. This suite proves that a department-scoped user sees the
// controls for their own site, is refused another department's or another
// client's site, cannot widen scope with a clientId, stays read-only as a
// viewer, and loses access once the bearer session is revoked.
//
// Usage: node tests/track-controls-mobile-access.mjs  (API must be running on API_BASE)
// Exits 0 when every check passes, 1 otherwise.

const BASE = process.env.API_BASE || "http://localhost:8080/api";

let passed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) passed++;
  else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.error(`FAIL: ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
const expectStatus = (name, actual, expected) =>
  check(name, actual === expected, `expected ${expected}, got ${actual}`);

async function call(method, path, { cookie, bearer, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { cookie } : {}),
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = res.headers.get("set-cookie");
  const ct = res.headers.get("content-type") ?? "";
  const data = ct.includes("application/json") ? await res.json().catch(() => null) : (await res.text().catch(() => null), null);
  return { status: res.status, data, setCookie };
}

/** Registers a verified client admin and returns a cookie-session caller. */
async function registerAdmin(label, ts) {
  let cookie = "";
  const admin = async (method, path, body) => {
    const res = await call(method, path, { cookie, body });
    if (res.setCookie) cookie = res.setCookie.split(";")[0];
    return res;
  };
  const email = `track-controls-${label}-${ts}@test.local`;
  const reg = await admin("POST", "/auth/register", { name: `Controls ${label}`, email, password: "password-123" });
  check(`${label}: register`, [200, 201].includes(reg.status), `status=${reg.status}`);
  if (reg.data?.verificationToken) {
    await admin("GET", `/auth/verify-email?token=${encodeURIComponent(reg.data.verificationToken)}`);
    const login = await admin("POST", "/auth/login", { email, password: "password-123" });
    check(`${label}: login`, login.status === 200, `status=${login.status}`);
  }
  const me = await admin("GET", "/auth/me");
  const clientId = (me.data?.user ?? me.data)?.clientId;
  check(`${label}: has clientId`, Number.isInteger(clientId), `clientId=${clientId}`);
  return { admin, clientId };
}

async function mobileLogin(email, password) {
  const res = await call("POST", "/auth/mobile-login", { body: { email, password } });
  check(`mobile-login ${email}`, res.status === 200 && typeof res.data?.token === "string",
    `status=${res.status} body=${JSON.stringify(res.data)}`);
  return res.data?.token;
}

async function main() {
  const ts = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const { admin, clientId } = await registerAdmin("owner", ts);

  const deptAlpha = (await admin("POST", "/departments", { name: `Controls Alpha ${ts}` })).data?.id;
  const deptBeta = (await admin("POST", "/departments", { name: `Controls Beta ${ts}` })).data?.id;
  check("departments created", Number.isInteger(deptAlpha) && Number.isInteger(deptBeta));
  const siteAlpha = (await admin("POST", "/sites", { name: `Alpha ${ts}`, departmentId: deptAlpha })).data?.id;
  const siteBeta = (await admin("POST", "/sites", { name: `Beta ${ts}`, departmentId: deptBeta })).data?.id;
  check("sites created", Number.isInteger(siteAlpha) && Number.isInteger(siteBeta));

  for (const [siteId, tag, alarmDays] of [[siteAlpha, "ALPHA", 3], [siteBeta, "BETA", 2]]) {
    expectStatus(`save ${tag} fire profile`, (await admin("PUT", `/fire-safety/config?siteId=${siteId}`, {
      controlProfile: {
        riskAssessmentReference: `FRA-${tag}-${ts}`, nextReviewDate: "2027-03-31",
        responsiblePerson: `${tag} manager`, frequencyDays: { alarm: alarmDays },
      },
    })).status, 200);
    expectStatus(`save ${tag} legionella profile`, (await admin("PUT", `/legionella/config?siteId=${siteId}`, {
      controlProfile: { writtenControlSchemeReference: `WCS-${tag}-${ts}`, schemeReviewDate: "2027-01-31" },
    })).status, 200);
    expectStatus(`record ${tag} fire check`, (await admin("POST", "/fire-safety", {
      checkType: "alarm", checkDate: "2026-10-01", result: "pass", siteId, notes: `fire-${tag}-${ts}`,
    })).status, 201);
    expectStatus(`record ${tag} legionella check`, (await admin("POST", "/legionella", {
      checkType: "calorifier_temp", checkDate: "2026-10-01", result: "pass", temperature: 61, siteId, notes: `leg-${tag}-${ts}`,
    })).status, 201);
  }

  const users = {};
  for (const [role, label] of [["client_staff", "staff"], ["client_viewer", "viewer"]]) {
    const email = `track-controls-${label}-${ts}@test.local`;
    const created = await admin("POST", "/users", {
      name: `Controls ${label}`, email, password: "password-456", role, clientId, departmentId: deptAlpha,
    });
    check(`create ${label}`, [200, 201].includes(created.status), `status=${created.status}`);
    if (label === "staff") {
      expectStatus("designate department manager", (await admin("PUT", `/users/${created.data?.id}`, { isDepartmentManager: true })).status, 200);
    }
    users[label] = await mobileLogin(email, "password-456");
  }
  const manager = (method, path, body) => call(method, path, { bearer: users.staff, body });
  const viewer = (method, path, body) => call(method, path, { bearer: users.viewer, body });

  // ── Own-department site: everything the mobile controls screen reads ──────
  const fireConfig = await manager("GET", `/fire-safety/config?siteId=${siteAlpha}`);
  expectStatus("manager bearer: fire config for own site", fireConfig.status, 200);
  check("fire config carries the site's control references",
    fireConfig.data?.controlProfile?.riskAssessmentReference === `FRA-ALPHA-${ts}` &&
      fireConfig.data?.controlProfile?.nextReviewDate === "2027-03-31",
    JSON.stringify(fireConfig.data?.controlProfile));
  const fireStatus = await manager("GET", `/fire-safety/status?siteId=${siteAlpha}`);
  expectStatus("manager bearer: fire status for own site", fireStatus.status, 200);
  check("fire status uses the site's risk-assessed cadence",
    fireStatus.data?.find?.((row) => row.checkType === "alarm")?.frequencyDays === 3,
    JSON.stringify(fireStatus.data?.find?.((row) => row.checkType === "alarm")));
  const fireHistory = await manager("GET", `/fire-safety?siteId=${siteAlpha}`);
  check("fire history lists only the site's checks",
    fireHistory.status === 200 && fireHistory.data.some((r) => r.notes === `fire-ALPHA-${ts}`) &&
      fireHistory.data.every((r) => r.siteId === siteAlpha), `status=${fireHistory.status}`);

  const legConfig = await manager("GET", `/legionella/config?siteId=${siteAlpha}`);
  expectStatus("manager bearer: legionella config for own site", legConfig.status, 200);
  check("legionella config carries the scheme reference and review date",
    legConfig.data?.controlProfile?.writtenControlSchemeReference === `WCS-ALPHA-${ts}` &&
      legConfig.data?.controlProfile?.schemeReviewDate === "2027-01-31" &&
      legConfig.data?.effectiveTemperatureLimits?.calorifier_temp?.min === 60,
    JSON.stringify(legConfig.data));
  const legStatus = await manager("GET", `/legionella/status?siteId=${siteAlpha}`);
  check("legionella status awaits an approved plan",
    legStatus.status === 200 && legStatus.data.every((row) => row.status === "plan_required"), `status=${legStatus.status}`);
  const plan = await manager("GET", `/legionella/monitoring-plan?siteId=${siteAlpha}`);
  check("manager bearer: monitoring plan for own site", plan.status === 200 && plan.data?.approved === false,
    `status=${plan.status}`);
  const legHistory = await manager("GET", `/legionella?siteId=${siteAlpha}`);
  check("legionella history lists only the site's checks",
    legHistory.status === 200 && legHistory.data.some((r) => r.notes === `leg-ALPHA-${ts}`) &&
      legHistory.data.every((r) => r.siteId === siteAlpha), `status=${legHistory.status}`);

  // ── Another department's site in the same client ───────────────────────────
  for (const path of [
    `/fire-safety/config?siteId=${siteBeta}`, `/fire-safety/status?siteId=${siteBeta}`,
    `/legionella/config?siteId=${siteBeta}`, `/legionella/status?siteId=${siteBeta}`,
    `/legionella/monitoring-plan?siteId=${siteBeta}`,
  ]) {
    const res = await manager("GET", path);
    expectStatus(`manager bearer: ${path.split("?")[0]} for another department's site`, res.status, 403);
    check(`no beta controls leak from ${path.split("?")[0]}`, !JSON.stringify(res.data ?? "").includes("BETA"));
  }
  for (const path of [`/fire-safety?siteId=${siteBeta}`, `/legionella?siteId=${siteBeta}`]) {
    const res = await manager("GET", path);
    check(`manager bearer: ${path.split("?")[0]} history hides another department's site`,
      res.status === 200 && Array.isArray(res.data) && res.data.length === 0, `status=${res.status} rows=${res.data?.length}`);
  }

  // ── Another client's site, and attempts to widen scope ────────────────────
  const other = await registerAdmin("other", ts);
  const foreignSite = (await other.admin("POST", "/sites", { name: `Foreign ${ts}` })).data?.id;
  check("foreign site created", Number.isInteger(foreignSite));
  for (const path of ["/fire-safety/config", "/fire-safety/status", "/legionella/config", "/legionella/status"]) {
    expectStatus(`manager bearer: ${path} for another client's site`, (await manager("GET", `${path}?siteId=${foreignSite}`)).status, 400);
    expectStatus(`manager bearer: ${path} with another clientId`,
      (await manager("GET", `${path}?siteId=${siteAlpha}&clientId=${other.clientId}`)).status, 403);
  }
  expectStatus("manager bearer: malformed siteId on fire status", (await manager("GET", "/fire-safety/status?siteId=abc")).status, 400);

  // ── Viewer bearer: reads, never writes ─────────────────────────────────────
  expectStatus("viewer bearer: fire config for own site", (await viewer("GET", `/fire-safety/config?siteId=${siteAlpha}`)).status, 200);
  expectStatus("viewer bearer: legionella status for own site", (await viewer("GET", `/legionella/status?siteId=${siteAlpha}`)).status, 200);
  expectStatus("viewer bearer: cannot change the fire profile", (await viewer("PUT", `/fire-safety/config?siteId=${siteAlpha}`, {
    controlProfile: { riskAssessmentReference: "tampered" },
  })).status, 403);
  check("viewer bearer: cannot change the legionella profile", [401, 403].includes((await viewer("PUT", `/legionella/config?siteId=${siteAlpha}`, {
    controlProfile: { writtenControlSchemeReference: "tampered" },
  })).status));
  const unchanged = await manager("GET", `/fire-safety/config?siteId=${siteAlpha}`);
  check("refused writes left the profile unchanged",
    unchanged.data?.controlProfile?.riskAssessmentReference === `FRA-ALPHA-${ts}`);

  // ── Bearer session lifecycle ───────────────────────────────────────────────
  expectStatus("no credentials: fire config", (await call("GET", `/fire-safety/config?siteId=${siteAlpha}`)).status, 401);
  expectStatus("unknown bearer: legionella status",
    (await call("GET", `/legionella/status?siteId=${siteAlpha}`, { bearer: "0".repeat(64) })).status, 401);
  expectStatus("manager: mobile logout", (await manager("POST", "/auth/mobile-logout")).status, 204);
  expectStatus("revoked bearer: fire status", (await manager("GET", `/fire-safety/status?siteId=${siteAlpha}`)).status, 401);

  console.log(`${passed} checks passed, ${failures.length} failed.`);
  if (failures.length) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
