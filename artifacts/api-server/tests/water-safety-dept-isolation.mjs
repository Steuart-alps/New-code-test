// Water-safety department isolation with real department-scoped sessions.
//
// Two departments each get a site with an unsafe Legionella reading and an
// unsafe HotTub reading, so each site has its own linked Compliance Hub
// actions, failed status, dashboard alerts and reminders. A staff user in each
// department must see only their own department's water records, and must not
// be able to update the other department's actions or checks. Account-wide
// managers (the registering owner and a separate client admin) still see both.
//
// Every record for a department carries a unique marker (site name, location,
// notes) so a leak anywhere in a response body is caught, not only in the
// fields the test looks at.
//
// Usage: node tests/water-safety-dept-isolation.mjs  (API must be running on API_BASE)
// Exits 0 when every check passes, 1 otherwise.

const BASE = process.env.API_BASE || "http://localhost:8080/api";

let passed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) passed++;
  else {
    failures.push(`${name} — ${detail}`);
    console.error(`FAIL: ${name} — ${detail}`);
  }
}

const expectStatus = (name, response, allowed) =>
  check(name, allowed.includes(response.status), `expected ${allowed.join("/")}, got ${response.status} ${JSON.stringify(response.data)?.slice(0, 300)}`);

function makeSession() {
  let cookie = "";
  return async function request(method, path, body) {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    let data = null;
    if ((res.headers.get("content-type") ?? "").includes("application/json")) data = await res.json().catch(() => null);
    else await res.text().catch(() => null);
    return { status: res.status, data };
  };
}

async function login(email, password) {
  const session = makeSession();
  expectStatus(`${email}: login`, await session("POST", "/auth/login", { email, password }), [200, 201]);
  return session;
}

async function main() {
  const ts = Date.now();
  const day = new Date().toISOString().slice(0, 10);

  // ── Account owner ───────────────────────────────────────────────────────────
  const owner = makeSession();
  const ownerEmail = `water-dept-owner-${ts}@test.local`;
  const reg = await owner("POST", "/auth/register", { name: "Water Dept Owner", email: ownerEmail, password: "password-123" });
  expectStatus("owner: register", reg, [200, 201]);
  if (reg.data?.verificationToken) {
    await owner("GET", `/auth/verify-email?token=${encodeURIComponent(reg.data.verificationToken)}`);
    expectStatus("owner: login", await owner("POST", "/auth/login", { email: ownerEmail, password: "password-123" }), [200]);
  }
  const me = await owner("GET", "/auth/me");
  const clientId = (me.data?.user ?? me.data)?.clientId;
  check("owner: has clientId", Number.isInteger(clientId), `clientId=${clientId}`);

  // ── Two departments, one site each, each with unsafe water readings ─────────
  const departments = {};
  for (const key of ["alpha", "beta"]) {
    const marker = `${key.toUpperCase()}-WATER-${ts}`;
    const dept = await owner("POST", "/departments", { name: `Water ${key} ${ts}` });
    expectStatus(`owner: create ${key} department`, dept, [200, 201]);
    const site = await owner("POST", "/sites", { name: `${marker} site`, departmentId: dept.data?.id, seedStarterChecks: false });
    expectStatus(`owner: create ${key} site`, site, [201]);
    const siteId = site.data?.id;
    const leg = await owner("POST", "/legionella", {
      checkType: "calorifier_temp", checkDate: day, result: "pass", temperature: 55, siteId,
      location: `${marker} calorifier`, notes: `${marker} legionella`, performedBy: "Water Dept Owner",
    });
    check(`owner: unsafe ${key} Legionella reading is failed`, leg.status === 201 && leg.data?.result === "fail",
      `status=${leg.status} result=${leg.data?.result}`);
    const tub = await owner("POST", "/hot-tub", {
      checkType: "water_chemistry", checkDate: day, result: "pass", phValue: 8.2, sanitiserLevel: 2, temperature: 41, siteId,
      location: `${marker} spa`, notes: `${marker} hot tub`, performedBy: "Water Dept Owner",
    });
    check(`owner: unsafe ${key} HotTub reading is failed`, tub.status === 201 && tub.data?.result === "fail",
      `status=${tub.status} result=${tub.data?.result}`);
    departments[key] = { key, marker, departmentId: dept.data?.id, siteId, legId: leg.data?.id, tubId: tub.data?.id };
  }

  // Link each department's checks to its automatically created actions.
  const ownerActions = await owner("GET", "/compliance-hub/actions");
  expectStatus("owner: GET /compliance-hub/actions", ownerActions, [200]);
  const actionFor = (track, recordId) => (ownerActions.data ?? [])
    .find(action => action.sourceTrack === track && action.sourceRecordId === String(recordId));
  for (const d of Object.values(departments)) {
    d.legAction = actionFor("LegionellaTrack", d.legId);
    d.tubAction = actionFor("HotTubTrack", d.tubId);
    check(`owner: ${d.key} Legionella action created`, !!d.legAction?.id, "missing");
    check(`owner: ${d.key} HotTub action created`, !!d.tubAction?.id, "missing");
  }
  const { alpha, beta } = departments;

  // ── Users: one staff member per department, plus a second account-wide admin
  const createUser = async (label, role, departmentId) => {
    const email = `water-dept-${label}-${ts}@test.local`;
    const created = await owner("POST", "/users", {
      name: `Water ${label}`, email, password: "password-456", role, clientId,
      ...(departmentId ? { departmentId } : {}),
    });
    expectStatus(`owner: create ${label}`, created, [200, 201]);
    return login(email, "password-456");
  };
  const alphaStaff = await createUser("alpha-staff", "client_staff", alpha.departmentId);
  const betaStaff = await createUser("beta-staff", "client_staff", beta.departmentId);
  const admin = await createUser("admin", "client_admin", null);

  const leaks = (data, marker) => JSON.stringify(data ?? null).includes(marker);
  const ids = rows => new Set((Array.isArray(rows) ? rows : []).map(row => row.id));

  // ── Department-scoped sessions see only their own department ────────────────
  for (const [session, own, other] of [[alphaStaff, alpha, beta], [betaStaff, beta, alpha]]) {
    const who = `${own.key} staff`;

    // Checks
    const leg = await session("GET", "/legionella");
    expectStatus(`${who}: GET /legionella`, leg, [200]);
    check(`${who}: Legionella list has own unsafe check only`,
      ids(leg.data).has(own.legId) && !ids(leg.data).has(other.legId) && !leaks(leg.data, other.marker),
      "own check missing or other department's check visible");
    const tub = await session("GET", "/hot-tub");
    expectStatus(`${who}: GET /hot-tub`, tub, [200]);
    check(`${who}: HotTub list has own unsafe check only`,
      ids(tub.data).has(own.tubId) && !ids(tub.data).has(other.tubId) && !leaks(tub.data, other.marker),
      "own check missing or other department's check visible");
    const otherTubFilter = await session("GET", `/hot-tub?siteId=${other.siteId}`);
    check(`${who}: HotTub list filtered to other site is empty`,
      otherTubFilter.status === 200 && Array.isArray(otherTubFilter.data) && otherTubFilter.data.length === 0,
      `status=${otherTubFilter.status} rows=${otherTubFilter.data?.length}`);

    // Status
    for (const [path, type] of [["legionella", "calorifier_temp"], ["hot-tub", "water_chemistry"]]) {
      const ownStatus = await session("GET", `/${path}/status?siteId=${own.siteId}`);
      check(`${who}: own ${path} status shows the failed reading`, ownStatus.status === 200 &&
        ownStatus.data?.find(row => row.checkType === type)?.lastResult === "fail",
        `status=${ownStatus.status} row=${JSON.stringify(ownStatus.data?.find?.(row => row.checkType === type))}`);
      expectStatus(`${who}: other department's ${path} status is forbidden`,
        await session("GET", `/${path}/status?siteId=${other.siteId}`), [403]);
    }

    // Compliance Hub action links
    const actions = await session("GET", "/compliance-hub/actions");
    expectStatus(`${who}: GET /compliance-hub/actions`, actions, [200]);
    const actionIds = ids(actions.data);
    check(`${who}: sees own Legionella and HotTub actions`,
      actionIds.has(own.legAction?.id) && actionIds.has(own.tubAction?.id), "own action missing");
    check(`${who}: does not see other department's water actions`,
      !actionIds.has(other.legAction?.id) && !actionIds.has(other.tubAction?.id) &&
      !(actions.data ?? []).some(a => [String(other.legId), String(other.tubId)].includes(a.sourceRecordId) &&
        ["LegionellaTrack", "HotTubTrack"].includes(a.sourceTrack)),
      "other department's action visible");

    // Updates to the other department's actions and checks are refused.
    for (const action of [other.legAction, other.tubAction]) {
      expectStatus(`${who}: cannot update other department's ${action?.sourceTrack} action`,
        await session("PATCH", `/compliance-hub/actions/${action?.id}`, { status: "in_progress", interimControl: `${who} leak` }), [403, 404]);
    }
    expectStatus(`${who}: cannot edit other department's HotTub check`,
      await session("PUT", `/hot-tub/${other.tubId}`, { result: "pass", phValue: 7.4, sanitiserLevel: 4 }), [403, 404]);
    expectStatus(`${who}: cannot edit other department's Legionella check`,
      await session("PUT", `/legionella/${other.legId}`, { result: "pass", temperature: 62 }), [403, 404]);
    expectStatus(`${who}: can update own Legionella action`,
      await session("PATCH", `/compliance-hub/actions/${own.legAction?.id}`, { status: "in_progress", interimControl: `${who} isolated outlet` }), [200]);

    // Dashboard alerts
    const dashboard = await session("GET", "/dashboard/summary");
    expectStatus(`${who}: GET /dashboard/summary`, dashboard, [200]);
    for (const trackId of ["legionella", "hot_tub"]) {
      const track = dashboard.data?.tracks?.find(t => t.trackId === trackId);
      check(`${who}: dashboard ${trackId} needs action for own unsafe reading`,
        track?.health === "action_required" && leaks(track?.items, own.marker), JSON.stringify(track)?.slice(0, 400));
    }
    check(`${who}: dashboard has no other-department water alerts`, !leaks(dashboard.data, other.marker),
      "other department's marker in dashboard summary");
    expectStatus(`${who}: other department's dashboard site is forbidden`,
      await session("GET", `/dashboard/summary?siteId=${other.siteId}`), [403]);

    // Reminders
    const reminders = await session("GET", "/check-reminders");
    expectStatus(`${who}: GET /check-reminders`, reminders, [200]);
    const actionRequired = (reminders.data ?? []).filter(r => r.status === "action_required");
    for (const module of ["legionella", "hot_tub"]) {
      check(`${who}: ${module} reminder for own unsafe reading`,
        actionRequired.some(r => r.module === module && leaks(r, own.marker)), JSON.stringify(actionRequired).slice(0, 400));
    }
    check(`${who}: reminders exclude the other department`,
      !leaks(reminders.data, other.marker) && !(reminders.data ?? []).some(r => r.siteId === other.siteId),
      "other department's site or reading in reminders");
  }

  // The refused updates left the other department's records as they were.
  const afterActions = await owner("GET", "/compliance-hub/actions");
  const after = id => (afterActions.data ?? []).find(a => a.id === id);
  for (const d of [alpha, beta]) {
    check(`owner: ${d.key} HotTub action untouched by the other department`,
      after(d.tubAction?.id)?.status === "open" && !String(after(d.tubAction?.id)?.interimControl ?? "").includes("leak"),
      JSON.stringify(after(d.tubAction?.id)));
    check(`owner: ${d.key} Legionella action updated only by its own department`,
      after(d.legAction?.id)?.status === "in_progress" && after(d.legAction?.id)?.interimControl === `${d.key} staff isolated outlet`,
      JSON.stringify(after(d.legAction?.id)));
  }
  const ownerTubRows = (await owner("GET", "/hot-tub")).data ?? [];
  const ownerLegRows = (await owner("GET", "/legionella")).data ?? [];
  check("owner: both departments' unsafe checks still failed",
    [alpha, beta].every(d => ownerTubRows.find(row => row.id === d.tubId)?.result === "fail" &&
      ownerLegRows.find(row => row.id === d.legId)?.result === "fail"), "a check changed");

  // ── Account-wide managers still see both departments ───────────────────────
  for (const [session, who] of [[owner, "owner"], [admin, "client admin"]]) {
    const leg = ids((await session("GET", "/legionella")).data);
    const tub = ids((await session("GET", "/hot-tub")).data);
    check(`${who}: sees both departments' unsafe checks`,
      [alpha.legId, beta.legId].every(id => leg.has(id)) && [alpha.tubId, beta.tubId].every(id => tub.has(id)), "check missing");
    for (const d of [alpha, beta]) {
      for (const [path, type] of [["legionella", "calorifier_temp"], ["hot-tub", "water_chemistry"]]) {
        const status = await session("GET", `/${path}/status?siteId=${d.siteId}`);
        check(`${who}: ${d.key} ${path} status shows the failed reading`, status.status === 200 &&
          status.data?.find(row => row.checkType === type)?.lastResult === "fail", `status=${status.status}`);
      }
    }
    const actions = ids((await session("GET", "/compliance-hub/actions")).data);
    check(`${who}: sees both departments' water actions`,
      [alpha.legAction, alpha.tubAction, beta.legAction, beta.tubAction].every(a => actions.has(a?.id)), "action missing");
    const dashboard = await session("GET", "/dashboard/summary");
    check(`${who}: dashboard alerts cover both departments`, dashboard.status === 200 &&
      ["legionella", "hot_tub"].every(trackId => {
        const track = dashboard.data?.tracks?.find(t => t.trackId === trackId);
        return track?.health === "action_required" && leaks(track?.items, alpha.marker) && leaks(track?.items, beta.marker);
      }), JSON.stringify(dashboard.data?.tracks?.filter(t => ["legionella", "hot_tub"].includes(t.trackId)))?.slice(0, 600));
    for (const d of [alpha, beta]) {
      expectStatus(`${who}: can open ${d.key} dashboard site`, await session("GET", `/dashboard/summary?siteId=${d.siteId}`), [200]);
    }
    const reminders = await session("GET", "/check-reminders");
    const actionRequired = (reminders.data ?? []).filter(r => r.status === "action_required");
    check(`${who}: reminders cover both departments' unsafe readings`, reminders.status === 200 &&
      ["legionella", "hot_tub"].every(module => [alpha, beta].every(d =>
        actionRequired.some(r => r.module === module && leaks(r, d.marker)))), JSON.stringify(actionRequired).slice(0, 600));
  }
  expectStatus("client admin: can update a department's HotTub action",
    await admin("PATCH", `/compliance-hub/actions/${beta.tubAction?.id}`, { status: "in_progress" }), [200]);

  console.log(`\nWater-safety department isolation: ${passed} checks passed, ${failures.length} failed.`);
  if (failures.length > 0) {
    console.error("\nFailures:");
    for (const f of failures) console.error(` - ${f}`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error("Test run crashed:", err);
  process.exit(1);
});
