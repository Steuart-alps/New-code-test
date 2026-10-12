// Compliance content regressions. Run through test:compliance-content.
//  - Recurring compliance checks: completing a check with a repeat interval
//    records the completion and reopens it due interval months later; checks
//    without an interval keep the one-off behaviour.
//  - Starter content: no invented due dates, business-type specific items,
//    and site seeding is opt-in and does not duplicate unassigned checks.
//  - RIDDOR category: reporting deadline and overdue state.
//  - Legionella healthcare (55°C) and calorifier return (50°C) defaults, and
//    the KitchenTrack jurisdiction default from the Compliance Hub nation.
import { createFixtureOwnership, resolveRunId } from "./fixture-ownership.mjs";

const BASE = process.env.API_BASE;
if (!BASE) throw new Error("API_BASE is required");
const ownership = createFixtureOwnership({ runId: resolveRunId(), suite: "compliance-content" });
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
  return async (method, path, body) => {
    const response = await fetch(`${BASE}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    return { status: response.status, data: await response.json().catch(() => null) };
  };
}

async function tenant(label, businessType) {
  const request = session();
  const email = `compliance-content-${label}-${ownership.runId}@test.local`;
  const registered = await request("POST", "/auth/register", {
    name: `${label} Manager`, email, password: "password-123", ...(businessType ? { businessType } : {}),
  });
  check(`${label}: register`, [200, 201].includes(registered.status), String(registered.status));
  if (!registered.data?.verificationToken) return null;
  ownership.trackRegisteredUser();
  await request("GET", `/auth/verify-email?token=${encodeURIComponent(registered.data.verificationToken)}`);
  const loggedIn = await request("POST", "/auth/login", { email, password: "password-123" });
  check(`${label}: login`, loggedIn.status === 200, String(loggedIn.status));
  const me = await request("GET", "/auth/me");
  ownership.trackClient((me.data?.user ?? me.data)?.clientId);
  return loggedIn.status === 200 ? request : null;
}

const isoDay = (d) => new Date(d).toISOString().slice(0, 10);
function addMonthsUtc(date, months) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(date.getUTCDate(), last));
  return d;
}
function daysAgo(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}
function plusDays(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

async function recurrence(owner) {
  const pastDue = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
  const recurring = await owner("POST", "/compliance-items", { title: "Gas safety check", frequencyMonths: 12, dueDate: pastDue });
  check("recurrence: create recurring check", recurring.status === 201 && recurring.data?.frequencyMonths === 12, JSON.stringify(recurring.data));
  const id = recurring.data?.id;

  const completed = await owner("PATCH", `/compliance-items/${id}/status`, { status: "completed" });
  const completedAt = completed.data?.completedAt ? new Date(completed.data.completedAt) : null;
  check("recurrence: completing reopens the check as pending",
    completed.status === 200 && completed.data?.status === "pending" && completedAt !== null, JSON.stringify(completed.data));
  check("recurrence: next due date is completion date plus the interval",
    completedAt && isoDay(completed.data?.dueDate) === isoDay(addMonthsUtc(completedAt, 12)),
    `${completed.data?.dueDate} vs completed ${completed.data?.completedAt}`);

  const audit = await owner("GET", `/audit-events?entityType=compliance_item&entityId=${id}`);
  check("recurrence: completion is recorded in the audit history",
    audit.status === 200 && (audit.data ?? []).some((e) => e.action === "status_changed"
      && e.metadata?.recurringCompletion?.nextDueDate && e.after?.status === "pending"),
    JSON.stringify(audit.data));

  const oneOff = await owner("POST", "/compliance-items", { title: "One-off survey", dueDate: pastDue });
  const oneOffDone = await owner("PATCH", `/compliance-items/${oneOff.data?.id}/status`, { status: "completed" });
  check("recurrence: a check without an interval stays completed",
    oneOffDone.status === 200 && oneOffDone.data?.status === "completed" && isoDay(oneOffDone.data?.dueDate) === isoDay(pastDue),
    JSON.stringify(oneOffDone.data));

  // Adding an interval to an already-completed check counts from its recorded completion.
  const withInterval = await owner("PUT", `/compliance-items/${oneOff.data?.id}`, { status: "completed", frequencyMonths: 6 });
  check("recurrence: adding an interval to a completed check reopens it from its completion date",
    withInterval.status === 200 && withInterval.data?.status === "pending"
      && withInterval.data?.completedAt === oneOffDone.data?.completedAt
      && isoDay(withInterval.data?.dueDate) === isoDay(addMonthsUtc(new Date(oneOffDone.data?.completedAt), 6)),
    JSON.stringify(withInterval.data));

  check("recurrence: fractional interval rejected",
    (await owner("POST", "/compliance-items", { title: "Bad interval", frequencyMonths: 1.5 })).status === 400);
  check("recurrence: zero interval rejected",
    (await owner("POST", "/compliance-items", { title: "Bad interval", frequencyMonths: 0 })).status === 400);
}

async function starterContent(careHome, plain) {
  const items = (await careHome("GET", "/compliance-items")).data ?? [];
  const byTitle = new Map(items.map((i) => [i.title, i]));
  check("starter: seeded checks carry no invented due date", items.length > 0 && items.every((i) => i.dueDate == null),
    JSON.stringify(items.filter((i) => i.dueDate).map((i) => i.title)));
  check("starter: core legal items present",
    ["Fire Risk Assessment Review", "Asbestos Management Survey & Register Review", "Employers' Liability Insurance Certificate"]
      .every((t) => byTitle.has(t)));
  check("starter: care home gets 6-monthly hoist and sling examination",
    byTitle.get("Patient Hoists & Slings — Thorough Examination")?.frequencyMonths === 6);
  check("starter: care home EICR interval is 5 years",
    byTitle.get("Electrical Installation Condition Report (EICR)")?.frequencyMonths === 60);
  check("starter: holiday-park items are not seeded for a care home",
    !byTitle.has("Let Caravans & Lodges — Annual Gas Safety Check") && !byTitle.has("Playground Equipment — Annual Inspection"));
  check("starter: legionella risk assessment has no fixed two-year review",
    !/two-yearly/i.test(byTitle.get("Legionella Risk Assessment")?.description ?? "two-yearly"));

  const plainItems = (await plain("GET", "/compliance-items")).data ?? [];
  check("starter: no hoist check without the care-home business type",
    !plainItems.some((i) => i.title.startsWith("Patient Hoists")));
  check("starter: EICR interval left to the business without a business type",
    plainItems.find((i) => i.title.startsWith("Electrical Installation Condition Report"))?.frequencyMonths == null);

  const quiet = await careHome("POST", "/sites", { name: "Annexe" });
  const afterQuiet = (await careHome("GET", "/compliance-items")).data ?? [];
  check("starter: Add Site does not seed checks unless asked",
    quiet.status === 201 && !afterQuiet.some((i) => i.siteId === quiet.data?.id));

  const seeded = await careHome("POST", "/sites", { name: "Main house", seedStarterChecks: true });
  const afterSeed = (await careHome("GET", "/compliance-items")).data ?? [];
  check("starter: first seeded site takes the unassigned starter checks instead of copying them",
    seeded.status === 201 && afterSeed.length === items.length
      && afterSeed.filter((i) => i.siteId === seeded.data?.id).length === items.length,
    `before=${items.length} after=${afterSeed.length}`);

  const second = await careHome("POST", "/sites", { name: "Second house", seedStarterChecks: true });
  const afterSecond = (await careHome("GET", "/compliance-items")).data ?? [];
  check("starter: a further seeded site gets its own copies",
    afterSecond.filter((i) => i.siteId === second.data?.id).length === items.length);
}

async function riddor(owner) {
  const base = {
    location: "Kitchen", description: "Slipped on wet floor", involvedName: "A Person", reportedBy: "Manager",
    riddorRationale: "Assessed against RIDDOR 2013",
  };
  const specifiedDate = daysAgo(20);
  const specified = await owner("POST", "/incidents", {
    ...base, incidentDate: specifiedDate, riddorReportable: true, riddorCategory: "specified_injury",
  });
  check("riddor: specified injury past 10 days is overdue",
    specified.status === 201 && specified.data?.riddorDeadline?.state === "overdue"
      && specified.data.riddorDeadline.reportBy === plusDays(specifiedDate, 10)
      && specified.data.riddorDeadline.notifyWithoutDelay === true,
    JSON.stringify(specified.data?.riddorDeadline ?? specified.data));

  const today = daysAgo(0);
  const over7 = await owner("POST", "/incidents", {
    ...base, incidentDate: today, riddorReportable: true, riddorCategory: "over_7_day_injury",
  });
  check("riddor: over-7-day injury is due within 15 days",
    over7.status === 201 && over7.data?.riddorDeadline?.state === "due"
      && over7.data.riddorDeadline.reportBy === plusDays(today, 15) && over7.data.riddorDeadline.notifyWithoutDelay === false,
    JSON.stringify(over7.data?.riddorDeadline ?? over7.data));

  const over3 = await owner("POST", "/incidents", {
    ...base, incidentDate: today, riddorReportable: false, riddorCategory: "over_3_day_record_only",
  });
  check("riddor: over-3-day injury is record only", over3.status === 201 && over3.data?.riddorDeadline?.state === "record_only",
    JSON.stringify(over3.data));

  const disease = await owner("POST", "/incidents", {
    ...base, incidentDate: today, riddorReportable: true, riddorCategory: "occupational_disease",
  });
  check("riddor: occupational disease is reported on diagnosis",
    disease.status === 201 && disease.data?.riddorDeadline?.state === "on_diagnosis" && disease.data.riddorDeadline.reportBy === null);

  check("riddor: a reportable category must be marked reportable",
    (await owner("POST", "/incidents", { ...base, incidentDate: today, riddorReportable: false, riddorCategory: "death" })).status === 400);
  check("riddor: unknown category rejected",
    (await owner("POST", "/incidents", { ...base, incidentDate: today, riddorReportable: true, riddorCategory: "minor" })).status === 400);

  const reported = await owner("PUT", `/incidents/${specified.data?.id}`, {
    reportedToHse: true, hseReference: "RIDDOR-1", hseReportDate: today,
    submittedAt: new Date().toISOString(), submissionEvidence: "Receipt 1", riddorRationale: "Submitted online",
  });
  check("riddor: reporting clears the overdue state", reported.status === 200 && reported.data?.riddorDeadline?.state === "reported",
    JSON.stringify(reported.data));

  const list = await owner("GET", "/incidents");
  check("riddor: list includes the deadline", (list.data ?? []).some((i) => i.id === over7.data?.id && i.riddorDeadline?.reportBy));
  const history = await owner("GET", `/incidents/${over7.data?.id}/riddor-history`);
  check("riddor: decision history records the category",
    (history.data ?? []).some((e) => e.riddorCategory === "over_7_day_injury"), JSON.stringify(history.data));
}

async function waterAndFood(careHome, plain) {
  const day = daysAgo(0);
  const hot = (request, temperature, extra = {}) => request("POST", "/legionella", {
    checkType: "hot_sentinel_temp", checkDate: day, result: "pass", temperature, performedBy: "Tester", ...extra,
  });
  check("legionella: healthcare hot outlet below 55°C fails", (await hot(careHome, 53)).data?.result === "fail");
  check("legionella: other hot outlet at 53°C passes", (await hot(plain, 53)).data?.result === "pass");
  const calorifier = (location, temperature) => plain("POST", "/legionella", {
    checkType: "calorifier_temp", checkDate: day, result: "pass", temperature, location, performedBy: "Tester",
  });
  check("legionella: calorifier return at 52°C passes", (await calorifier("Calorifier 1 return", 52)).data?.result === "pass");
  check("legionella: calorifier flow at 58°C fails", (await calorifier("Calorifier 1 flow", 58)).data?.result === "fail");

  const before = await plain("GET", "/food-safety/config");
  check("kitchen: default jurisdiction is England/Wales without a hub nation",
    before.data?.food_jurisdiction === "england_wales" && before.data?.food_reheating_limit === "Above 75°C",
    `${before.data?.food_jurisdiction} ${before.data?.food_reheating_limit}`);
  check("kitchen: cooking label states only the core temperature", before.data?.food_cooking_limit === "75°C or above (core)");
  const profile = await plain("PUT", "/compliance-hub/profile", {
    nation: "scotland", operationType: "Restaurant", responsiblePersonName: "Jo Manager", responsiblePersonRole: "Owner",
    reviewCadence: "Annual", nextReviewDate: plusDays(day, 365), competentAppointments: [],
  });
  check("kitchen: save Scottish hub profile", [200, 201].includes(profile.status), String(profile.status));
  const after = await plain("GET", "/food-safety/config");
  check("kitchen: default jurisdiction follows the Scottish hub nation",
    after.data?.food_jurisdiction === "scotland" && after.data?.food_reheating_limit === "Above 82°C",
    `${after.data?.food_jurisdiction} ${after.data?.food_reheating_limit}`);
}

async function main() {
  try {
    const careHome = await tenant("carehome", "care_home_healthcare");
    const plain = await tenant("plain");
    if (!careHome || !plain) {
      process.exitCode = 1;
      return;
    }
    await recurrence(plain);
    await starterContent(careHome, plain);
    await riddor(plain);
    await waterAndFood(careHome, plain);
  } finally {
    await ownership.cleanup();
  }
  console.log(`${passed} compliance-content checks passed, ${failures.length} failed.`);
  if (failures.length) process.exit(1);
}

main().catch((error) => { console.error(error); process.exit(1); });
