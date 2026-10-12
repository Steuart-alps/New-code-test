// Setup wizard and staff tasks. Run through test:setup-tasks (self-booted API).
//  - Setup: state, business type + hub nation, module picks, starter-check
//    selection with real due dates (claim / create / remove-untouched / keep
//    edited), completion, tenant isolation and viewer read-only.
//  - Tasks: one-off and recurring occurrences, "mine" vs "all", staff can only
//    complete their own or their role's tasks (today/yesterday), managers
//    manage, department scoping, tenant isolation and viewer read-only.
import { createFixtureOwnership, resolveRunId } from "./fixture-ownership.mjs";

const BASE = process.env.API_BASE;
if (!BASE) throw new Error("API_BASE is required");
const ownership = createFixtureOwnership({ runId: resolveRunId(), suite: "setup-tasks" });
let passed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) passed++;
  else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.error(`FAIL: ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function session() {
  let cookie = "";
  const call = async (method, path, body) => {
    const response = await fetch(`${BASE}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    return { status: response.status, data: await response.json().catch(() => null) };
  };
  return call;
}

async function owner(label, businessType) {
  const call = session();
  const email = `setup-tasks-${label}-${ownership.runId}@test.local`;
  const registered = await call("POST", "/auth/register", { name: `${label} Owner`, email, password: "password-123", ...(businessType ? { businessType } : {}) });
  check(`${label}: register`, [200, 201].includes(registered.status), String(registered.status));
  ownership.trackRegisteredUser();
  await call("GET", `/auth/verify-email?token=${encodeURIComponent(registered.data?.verificationToken ?? "")}`);
  const login = await call("POST", "/auth/login", { email, password: "password-123" });
  check(`${label}: login`, login.status === 200, String(login.status));
  const me = await call("GET", "/auth/me");
  call.clientId = (me.data?.user ?? me.data)?.clientId;
  ownership.trackClient(call.clientId);
  return call;
}

async function member(admin, label, role, extra = {}) {
  const call = session();
  const email = `setup-tasks-${label}-${ownership.runId}@test.local`;
  const created = await admin("POST", "/users", { name: `${label} person`, email, password: "password-456", role, clientId: admin.clientId, ...extra });
  check(`${label}: create ${role}`, [200, 201].includes(created.status), JSON.stringify(created.data));
  ownership.trackRegisteredUser();
  if (extra.isDepartmentManager) {
    const flagged = await admin("PUT", `/users/${created.data?.id}`, { isDepartmentManager: true });
    check(`${label}: make department manager`, flagged.status === 200, JSON.stringify(flagged.data));
  }
  const login = await call("POST", "/auth/login", { email, password: "password-456" });
  check(`${label}: login`, login.status === 200, String(login.status));
  call.id = created.data?.id;
  return call;
}

const isoDay = (value) => (value ? new Date(value).toISOString().slice(0, 10) : null);
function londonToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
function plusDays(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const LEGAL_CORE = [
  "Fire Risk Assessment Review", "Fire Alarm Maintenance", "Emergency Light Maintenance", "Fire Extinguishers Maintenance",
  "Electrical Installation Condition Report (EICR)", "Legionella Risk Assessment",
  "Asbestos Management Survey & Register Review", "Employers' Liability Insurance Certificate",
];

async function setupWizard(a, b, viewer) {
  const state = await a("GET", "/setup/state");
  check("setup: new business needs setup", state.status === 200 && state.data?.needsSetup === true && state.data?.canManage === true, JSON.stringify(state.data)?.slice(0, 300));
  const starter = state.data?.starterChecks ?? [];
  check("setup: legal core starter titles exist and are ticked by default",
    LEGAL_CORE.every((t) => starter.some((c) => c.title === t && c.core === true)), JSON.stringify(starter.map((c) => c.title)));
  check("setup: signup starter checks are offered as untouched", starter.find((c) => c.title === "Fire Risk Assessment Review")?.state === "untouched");
  check("setup: modules offered during trial", (state.data?.modules?.available ?? []).includes("firetrack"));

  // Step 1: business type + nation (hub profile created with editable defaults).
  const business = await a("PUT", "/setup/business", { businessType: "care_home_healthcare", nation: "scotland" });
  check("setup: save business type and nation", business.status === 200, JSON.stringify(business.data));
  const profile = await a("GET", "/compliance-hub/profile");
  check("setup: nation saved to the Compliance Hub profile", profile.data?.nation === "scotland", JSON.stringify(profile.data));
  check("setup: rejects an unknown business type", (await a("PUT", "/setup/business", { businessType: "spaceport" })).status === 400);
  const afterType = await a("GET", "/setup/state");
  check("setup: business type drives the starter list",
    afterType.data?.businessType === "care_home_healthcare"
      && afterType.data?.starterChecks?.find((c) => c.title.startsWith("Patient Hoists"))?.state === "missing");
  // Changing just the nation keeps the rest of an existing profile.
  await a("PUT", "/setup/business", { nation: "wales" });
  check("setup: nation update keeps the existing profile", (await a("GET", "/compliance-hub/profile")).data?.nation === "wales");

  // Step 2: first site through the existing sites API.
  const site = await a("POST", "/sites", { name: "Main house", address: "1 High Street", seedStarterChecks: false });
  check("setup: create first site", site.status === 201, JSON.stringify(site.data));

  // Step 3: modules.
  check("setup: save picked modules", (await a("PUT", "/setup/modules", { modules: ["firetrack", "kitchentrack"] })).status === 200);
  check("setup: reject unknown modules", (await a("PUT", "/setup/modules", { modules: ["notatrack"] })).status === 400);
  check("setup: picked modules persist", JSON.stringify((await a("GET", "/setup/state")).data?.modules?.picked) === JSON.stringify(["firetrack", "kitchentrack"]));
  // Dashboard: modules not picked (and not started) are flagged for the
  // collapsed "Other modules" section; picked ones and started ones are not.
  const dashTracks = (await a("GET", "/dashboard/summary")).data?.tracks ?? [];
  const dashTrack = (id) => dashTracks.find((t) => t.trackId === id);
  check("setup: picked modules stay in the dashboard list",
    dashTrack("kitchen")?.otherModule !== true && dashTrack("fire")?.otherModule !== true && dashTrack("daily_am")?.otherModule !== true,
    JSON.stringify(dashTracks.map((t) => [t.trackId, t.health, t.otherModule])));
  const unpicked = dashTracks.filter((t) => t.enabled && t.health === "not_started"
    && !["kitchen", "fire", "daily_am", "daily_pm", "safe"].includes(t.trackId));
  check("setup: unpicked, not-started modules go under Other modules",
    unpicked.length > 0 && unpicked.every((t) => t.otherModule === true),
    JSON.stringify(dashTracks.map((t) => [t.trackId, t.health, t.otherModule])));
  check("setup: started or failing modules are never moved",
    dashTracks.filter((t) => t.health !== "not_started" || !t.enabled).every((t) => t.otherModule !== true));

  // Step 4: starter checks. Edit one seeded check first: it must be left alone.
  const items = (await a("GET", "/compliance-items")).data ?? [];
  const goodsLift = items.find((i) => i.title === "Goods Lift — Thorough Examination");
  await a("PUT", `/compliance-items/${goodsLift?.id}`, { notes: "We have a goods lift" });
  const applied = await a("POST", "/setup/starter-checks", {
    siteId: site.data?.id,
    removeUnticked: true,
    checks: [
      { title: "Fire Risk Assessment Review", lastDone: "2026-01-31" },
      { title: "Patient Hoists & Slings — Thorough Examination", lastDone: "2026-06-10" },
      { title: "Electrical Appliance Testing (PAT)", nextDue: "2026-12-01" },
      { title: "Employers' Liability Insurance Certificate" },
    ],
  });
  check("setup: apply starter checks", applied.status === 200 && applied.data?.updated === 3 && applied.data?.created === 1 && applied.data?.kept === 0 && applied.data?.removed > 0,
    JSON.stringify(applied.data));
  const after = (await a("GET", "/compliance-items")).data ?? [];
  const byTitle = new Map(after.map((i) => [i.title, i]));
  const fra = byTitle.get("Fire Risk Assessment Review");
  check("setup: due date is last service plus the interval", isoDay(fra?.dueDate) === "2027-01-31" && fra?.siteId === site.data?.id, JSON.stringify(fra));
  check("setup: last service recorded", isoDay(fra?.completedAt) === "2026-01-31" && /31 Jan 2026/.test(fra?.notes ?? ""), JSON.stringify(fra));
  const hoist = byTitle.get("Patient Hoists & Slings — Thorough Examination");
  check("setup: missing business-type check is added with a real due date", isoDay(hoist?.dueDate) === "2026-12-10" && hoist?.frequencyMonths === 6, JSON.stringify(hoist));
  check("setup: check without an interval takes the next due date", isoDay(byTitle.get("Electrical Appliance Testing (PAT)")?.dueDate) === "2026-12-01");
  const insurance = byTitle.get("Employers' Liability Insurance Certificate");
  check("setup: ticked check without a date moves to the site undated", insurance?.dueDate == null && insurance?.siteId === site.data?.id, JSON.stringify(insurance));
  check("setup: unticked untouched starter checks are removed", !byTitle.has("Passenger Lift — Thorough Examination"));
  check("setup: edited starter checks are never removed", byTitle.get("Goods Lift — Thorough Examination")?.notes === "We have a goods lift");
  check("setup: unknown starter title rejected",
    (await a("POST", "/setup/starter-checks", { checks: [{ title: "Rocket engine service" }] })).status === 400);

  // Tenant isolation.
  check("setup isolation: other tenant cannot use this site",
    (await b("POST", "/setup/starter-checks", { siteId: site.data?.id, checks: [] })).status === 400);
  check("setup isolation: other tenant cannot read this state", (await b("GET", `/setup/state?clientId=${a.clientId}`)).status === 403);
  check("setup isolation: other tenant cannot change this business",
    (await b("PUT", "/setup/business", { clientId: a.clientId, businessType: "retail" })).status === 403);
  check("setup isolation: other tenant still needs setup", (await b("GET", "/setup/state")).data?.needsSetup === true);

  // Viewer read-only.
  const viewerState = await viewer("GET", "/setup/state");
  check("setup viewer: can read summary without management data", viewerState.status === 200 && viewerState.data?.canManage === false && !viewerState.data?.starterChecks);
  check("setup viewer: cannot change business", (await viewer("PUT", "/setup/business", { businessType: "retail" })).status === 403);
  check("setup viewer: cannot apply starter checks", (await viewer("POST", "/setup/starter-checks", { checks: [] })).status === 403);
  check("setup viewer: cannot complete setup", (await viewer("POST", "/setup/complete", {})).status === 403);

  check("setup: finish later", (await a("POST", "/setup/defer", {})).status === 200);
  const deferred = (await a("GET", "/setup/state")).data;
  check("setup: deferred still needs setup", deferred?.needsSetup === true && !!deferred?.deferredAt);
  const done = await a("POST", "/setup/complete", {});
  check("setup: complete", done.status === 200 && !!done.data?.setupCompletedAt);
  check("setup: completed business no longer needs setup", (await a("GET", "/setup/state")).data?.needsSetup === false);
  return site.data?.id;
}

async function tasks(a, b, siteId) {
  const today = londonToday();
  const staff1 = await member(a, "staff1", "client_staff");
  const staff2 = await member(a, "staff2", "client_staff");
  const viewer = await member(a, "viewer2", "client_viewer");

  const daily = await a("POST", "/tasks", { title: "Kitchen opening checklist", recurrence: "daily", startsOn: plusDays(today, -3), assigneeRole: "client_staff", siteId, module: "kitchentrack" });
  check("tasks: manager creates a daily role task", daily.status === 201, JSON.stringify(daily.data));
  const oneOff = await a("POST", "/tasks", { title: "Replace first-aid kit", recurrence: "once", startsOn: plusDays(today, -2), assigneeUserId: staff2.id });
  check("tasks: manager creates a one-off person task", oneOff.status === 201, JSON.stringify(oneOff.data));
  const weekly = await a("POST", "/tasks", { title: "Weekly fire alarm test", recurrence: "weekly", startsOn: plusDays(today, -7), assigneeRole: "managers", module: "firetrack" });
  check("tasks: manager creates a weekly managers task", weekly.status === 201);
  const future = await a("POST", "/tasks", { title: "Monthly ladder check", recurrence: "monthly", startsOn: plusDays(today, 1), assigneeRole: "client_staff" });
  check("tasks: create a task that starts tomorrow", future.status === 201);
  check("tasks: must be assigned to a person or a role",
    (await a("POST", "/tasks", { title: "Nobody", recurrence: "daily", startsOn: today })).status === 400);
  check("tasks: cannot be assigned to both a person and a role",
    (await a("POST", "/tasks", { title: "Both", recurrence: "daily", startsOn: today, assigneeRole: "client_staff", assigneeUserId: staff1.id })).status === 400);
  check("tasks: viewers cannot be assignees",
    (await a("POST", "/tasks", { title: "Viewer", recurrence: "daily", startsOn: today, assigneeUserId: viewer.id })).status === 400);

  const mine1 = await staff1("GET", `/tasks?scope=mine&date=${today}`);
  const ids1 = (mine1.data?.tasks ?? []).map((t) => t.id);
  check("tasks: staff see their role's daily task today", mine1.status === 200 && ids1.includes(daily.data?.id), JSON.stringify(mine1.data));
  check("tasks: staff do not see other people's or managers' tasks", !ids1.includes(oneOff.data?.id) && !ids1.includes(weekly.data?.id));
  check("tasks: tasks that start later are not due today", !ids1.includes(future.data?.id));
  const mine2 = await staff2("GET", "/tasks?scope=mine");
  const overdue = (mine2.data?.tasks ?? []).find((t) => t.id === oneOff.data?.id);
  check("tasks: open one-off task stays on the list as overdue", overdue?.overdue === true && overdue?.occurrenceDate === plusDays(today, -2), JSON.stringify(overdue));
  const adminMine = await a("GET", `/tasks?scope=mine&date=${today}`);
  check("tasks: managers group gets the weekly task on its weekday", (adminMine.data?.tasks ?? []).some((t) => t.id === weekly.data?.id && t.dueOnDate));

  check("tasks: staff cannot list every task", (await staff1("GET", "/tasks?scope=all")).status === 403);
  check("tasks: staff cannot create tasks",
    (await staff1("POST", "/tasks", { title: "Mine", recurrence: "daily", startsOn: today, assigneeRole: "client_staff" })).status === 403);
  check("tasks: staff cannot edit tasks", (await staff1("PATCH", `/tasks/${daily.data?.id}`, { title: "Changed" })).status === 403);
  check("tasks: staff cannot complete someone else's task",
    (await staff1("POST", `/tasks/${oneOff.data?.id}/complete`, { date: plusDays(today, -2) })).status === 403);
  const done = await staff1("POST", `/tasks/${daily.data?.id}/complete`, { date: today });
  check("tasks: staff complete their role's task", done.status === 201 && done.data?.completedBy === staff1.id && !!done.data?.completedAt, JSON.stringify(done.data));
  check("tasks: an occurrence is completed once", (await staff2("POST", `/tasks/${daily.data?.id}/complete`, { date: today })).status === 409);
  check("tasks: cannot complete a future occurrence", (await staff1("POST", `/tasks/${daily.data?.id}/complete`, { date: plusDays(today, 1) })).status === 400);
  check("tasks: staff cannot complete older occurrences", (await staff1("POST", `/tasks/${daily.data?.id}/complete`, { date: plusDays(today, -2) })).status === 403);
  check("tasks: staff can complete yesterday's occurrence", (await staff1("POST", `/tasks/${daily.data?.id}/complete`, { date: plusDays(today, -1) })).status === 201);
  check("tasks: managers can record older occurrences", (await a("POST", `/tasks/${daily.data?.id}/complete`, { date: plusDays(today, -2) })).status === 201);
  check("tasks: a date the task does not fall on is rejected", (await a("POST", `/tasks/${weekly.data?.id}/complete`, { date: plusDays(today, -1) })).status === 400);
  const afterDone = (await staff2("GET", `/tasks?scope=mine&date=${today}`)).data?.tasks ?? [];
  check("tasks: completion is shown with who did it",
    afterDone.find((t) => t.id === daily.data?.id)?.completion?.completedByName === "staff1 person", JSON.stringify(afterDone));
  check("tasks: staff complete their overdue one-off task", (await staff2("POST", `/tasks/${oneOff.data?.id}/complete`, { date: plusDays(today, -2) })).status === 201);
  check("tasks: a completed overdue task leaves the list",
    !((await staff2("GET", "/tasks?scope=mine")).data?.tasks ?? []).some((t) => t.id === oneOff.data?.id));

  // Viewers: read-only.
  const viewerAll = await viewer("GET", "/tasks?scope=all");
  check("tasks viewer: can read every task", viewerAll.status === 200 && (viewerAll.data?.tasks ?? []).length >= 4);
  check("tasks viewer: cannot complete", (await viewer("POST", `/tasks/${daily.data?.id}/complete`, { date: today })).status === 403);
  check("tasks viewer: cannot create", (await viewer("POST", "/tasks", { title: "V", recurrence: "daily", startsOn: today, assigneeRole: "client_staff" })).status === 403);
  check("tasks viewer: cannot edit", (await viewer("PATCH", `/tasks/${daily.data?.id}`, { active: false })).status === 403);

  // Tenant isolation.
  const bAll = await b("GET", "/tasks?scope=all");
  check("tasks isolation: other tenant sees none of these tasks", bAll.status === 200 && !(bAll.data?.tasks ?? []).some((t) => t.id === daily.data?.id));
  check("tasks isolation: other tenant cannot edit", (await b("PATCH", `/tasks/${daily.data?.id}`, { title: "Hijack" })).status === 404);
  check("tasks isolation: other tenant cannot complete", (await b("POST", `/tasks/${weekly.data?.id}/complete`, { date: today })).status === 404);
  check("tasks isolation: other tenant cannot use this site",
    (await b("POST", "/tasks", { title: "X", recurrence: "daily", startsOn: today, assigneeRole: "client_staff", siteId })).status === 400);
  check("tasks isolation: other tenant cannot assign these staff",
    (await b("POST", "/tasks", { title: "X", recurrence: "daily", startsOn: today, assigneeUserId: staff1.id })).status === 400);
  check("tasks isolation: explicit foreign clientId is refused", (await b("GET", `/tasks?scope=all&clientId=${a.clientId}`)).status === 403);
  check("tasks isolation: assignee list excludes other tenants",
    !((await b("GET", "/tasks/assignees")).data ?? []).some((u) => u.id === staff1.id));

  // Department scoping.
  const kitchen = await a("POST", "/departments", { name: `Kitchen ${ownership.runId.slice(0, 8)}` });
  const rooms = await a("POST", "/departments", { name: `Rooms ${ownership.runId.slice(0, 8)}` });
  const deptSite = await a("POST", "/sites", { name: "Kitchen block", departmentId: kitchen.data?.id, seedStarterChecks: false });
  check("tasks dept: setup", kitchen.status === 201 && rooms.status === 201 && deptSite.status === 201, JSON.stringify([kitchen.data, rooms.data, deptSite.data]));
  const manager = await member(a, "deptmanager", "client_staff", { departmentId: kitchen.data?.id, isDepartmentManager: true });
  const roomsStaff = await member(a, "roomsstaff", "client_staff", { departmentId: rooms.data?.id });
  const deptTask = await manager("POST", "/tasks", { title: "Probe calibration", recurrence: "daily", startsOn: today, assigneeRole: "client_staff", siteId: deptSite.data?.id });
  check("tasks dept: department manager creates a task for their site", deptTask.status === 201, JSON.stringify(deptTask.data));
  check("tasks dept: department manager cannot set business-wide tasks",
    (await manager("POST", "/tasks", { title: "All", recurrence: "daily", startsOn: today, assigneeRole: "client_staff" })).status === 400);
  check("tasks dept: department manager cannot set tasks on other sites",
    (await manager("POST", "/tasks", { title: "Other", recurrence: "daily", startsOn: today, assigneeRole: "client_staff", siteId })).status === 400);
  check("tasks dept: department manager cannot edit tasks outside their department",
    (await manager("PATCH", `/tasks/${daily.data?.id}`, { title: "Changed" })).status === 403);
  check("tasks dept: cannot assign someone whose department cannot see the site",
    (await a("POST", "/tasks", { title: "Wrong dept", recurrence: "daily", startsOn: today, assigneeUserId: roomsStaff.id, siteId: deptSite.data?.id })).status === 400);
  const roomsMine = (await roomsStaff("GET", `/tasks?scope=mine&date=${today}`)).data?.tasks ?? [];
  check("tasks dept: staff do not get tasks for another department's site", !roomsMine.some((t) => t.id === deptTask.data?.id));
  check("tasks dept: staff cannot complete another department's task",
    (await roomsStaff("POST", `/tasks/${deptTask.data?.id}/complete`, { date: today })).status === 404);

  // Archive.
  check("tasks: manager archives a task", (await a("PATCH", `/tasks/${daily.data?.id}`, { active: false })).status === 200);
  check("tasks: archived tasks leave My tasks",
    !((await staff1("GET", `/tasks?scope=mine&date=${today}`)).data?.tasks ?? []).some((t) => t.id === daily.data?.id));
  check("tasks: archived tasks cannot be completed", (await a("POST", `/tasks/${daily.data?.id}/complete`, { date: plusDays(today, -3) })).status === 409);
}

async function main() {
  try {
    const a = await owner("a");
    const b = await owner("b");
    const viewer = await member(a, "viewer1", "client_viewer");
    const siteId = await setupWizard(a, b, viewer);
    await tasks(a, b, siteId);
  } finally {
    await ownership.cleanup();
  }
  console.log(`${passed} setup-tasks checks passed, ${failures.length} failed.`);
  if (failures.length) process.exit(1);
}

main().catch((error) => { console.error(error); process.exit(1); });
