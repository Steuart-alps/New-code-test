// Monthly staff roster check (lib/rosterChecks.ts). Run through
// test:roster-check (disposable database and API).
//  - A business with a staff roster gets one monthly check per site, given to
//    the site's one Manager, else the Managers group; archived checks are not
//    recreated.
//  - The check stays open all month; No / N/A are recorded on the task, Yes
//    only by uploading the roster (the answer is required).
//  - The upload previews new starters and leavers by name, writes nothing on
//    preview, marks leavers as left (records kept), adds new starters, lists
//    the training they need and records the check in the same request.
//  - Managers can update only their own site's roster; the check keeps its
//    site, schedule and link when edited.
//  - Reminders (lib/dueItems.ts): an unanswered check stays due all month;
//    an answered one is not listed.
import assert from "node:assert/strict";
import { collectDueItems, createTenant, createUser, pool } from "./approval-workflow-fixtures.mjs";

function londonToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
const month = `${londonToday().slice(0, 7)}-01`;

async function rosterChecks(owner) {
  const all = await owner.request("GET", "/tasks?scope=all");
  assert.equal(all.status, 200, JSON.stringify(all.data));
  return all.data.tasks.filter((task) => task.module === "roster_check");
}

/** Roster checks are created in the background after a roster change. */
async function waitForChecks(owner, count) {
  for (let i = 0; i < 50; i++) {
    const checks = await rosterChecks(owner);
    if (checks.length >= count) return checks;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return rosterChecks(owner);
}

async function main() {
  const owner = await createTenant("roster-check");
  const siteA = (await owner.request("POST", "/sites", { name: "Clubhouse" })).data;
  const siteB = (await owner.request("POST", "/sites", { name: "Lodge" })).data;
  assert.ok(siteA?.id && siteB?.id);
  const bar = await owner.request("POST", "/departments", { name: "Bar", siteId: siteA.id });
  assert.equal(bar.status, 201, JSON.stringify(bar.data));
  const manager = await createUser(owner, { role: "client_manager", departmentId: bar.data.id, name: "Morgan Manager" });

  assert.deepEqual(await rosterChecks(owner), [], "no roster, no roster check");

  const add = async (name, siteId) => {
    const created = await owner.request("POST", "/staff-roster", { name, siteId });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    return created.data.id;
  };
  const ann = await add("Ann Leaver", siteA.id);
  await add("Ben Stays", siteA.id);
  await add("Cat Lodge", siteB.id);

  let checks = await waitForChecks(owner, 2);
  assert.equal(checks.length, 2, "one roster check per site");
  const checkA = checks.find((task) => task.siteId === siteA.id);
  const checkB = checks.find((task) => task.siteId === siteB.id);
  assert.equal(checkA.recurrence, "monthly");
  assert.equal(checkA.startsOn, month, "starts with this month");
  assert.equal(checkA.assigneeUserId, manager.userId, "the site's one Manager answers it");
  assert.equal(checkB.assigneeRole, "managers", "no Manager of its own: the Managers group");
  assert.equal(checkA.occurrenceDate, month);
  assert.equal(checkA.dueOnDate, true, "open any day of the month");

  const mine = await manager.request("GET", "/tasks?scope=mine");
  assert.equal(mine.status, 200, JSON.stringify(mine.data));
  assert.ok(mine.data.tasks.some((task) => task.id === checkA.id && !task.completion), "on the Manager's list");

  // An answer is required, and Yes only comes with the roster.
  const complete = (who, id, body) => who.request("POST", `/tasks/${id}/complete`, { date: month, ...body });
  assert.equal((await complete(manager, checkA.id, {})).status, 400);
  assert.equal((await complete(manager, checkA.id, { answer: "yes" })).status, 400);

  // Training at the site: what a new starter will need.
  await pool.query(
    `INSERT INTO train_track_records (client_id, site_id, record_type, staff_name, staff_roster_id, training_type, provider, completed_date)
     VALUES ($1, $2, 'certificate', 'Ann Leaver', $3, 'Food Hygiene Level 2', 'Course Co', CURRENT_DATE),
            ($1, $4, 'certificate', 'Cat Lodge', NULL, 'Lodge-only course', 'Course Co', CURRENT_DATE)`,
    [owner.clientId, siteA.id, ann, siteB.id],
  );

  // Managers update only their own site, one site at a time.
  const rows = [
    { name: "Ben Stays" },
    { name: "Dan Starter", jobTitle: "Barista" },
  ];
  const reconcile = (who, body) => who.request("POST", "/staff-roster/reconcile", body);
  assert.equal((await reconcile(manager, { rows, siteId: siteB.id })).status, 403, "not another site");
  assert.equal((await reconcile(manager, { rows, siteId: null })).status, 403, "not the whole business");
  assert.equal((await reconcile(manager, { rows, siteId: siteA.id, rosterCheck: { taskId: checkB.id, date: month } })).status, 400,
    "the check must be for the same site");

  const preview = await reconcile(manager, { rows, siteId: siteA.id, preview: true, rosterCheck: { taskId: checkA.id, date: month } });
  assert.equal(preview.status, 200, JSON.stringify(preview.data));
  assert.deepEqual(preview.data.people.created, [{ name: "Dan Starter", jobTitle: "Barista" }]);
  assert.deepEqual(preview.data.people.deactivated.map((p) => p.name), ["Ann Leaver"]);
  assert.equal(preview.data.summary.matchedByName, 1, "Ben matched by name without a payroll ID");
  let roster = await owner.request("GET", "/staff-roster?includeInactive=true");
  assert.equal(roster.data.find((row) => row.id === ann).active, true, "preview writes nothing");
  assert.equal((await rosterChecks(owner)).find((task) => task.id === checkA.id).completion, null, "preview leaves the check open");

  const saved = await reconcile(manager, { rows, siteId: siteA.id, preview: false, rosterCheck: { taskId: checkA.id, date: month } });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.deepEqual(saved.data.newStarters.map((p) => p.name), ["Dan Starter"]);
  assert.deepEqual(saved.data.trainingNeeded, ["Food Hygiene Level 2"], "the site's certificates, not other sites'");
  assert.equal(saved.data.rosterCheck.recorded, true);
  roster = await owner.request("GET", "/staff-roster?includeInactive=true");
  const annAfter = roster.data.find((row) => row.id === ann);
  assert.equal(annAfter.active, false, "the leaver is marked as left");
  assert.ok(roster.data.some((row) => row.name === "Dan Starter" && row.active && row.site_id === siteA.id), "the new starter joins the site");
  assert.ok(roster.data.some((row) => row.name === "Cat Lodge" && row.active), "another site's staff are untouched");
  const kept = await pool.query("SELECT count(*)::int AS n FROM train_track_records WHERE staff_roster_id = $1", [ann]);
  assert.equal(kept.rows[0].n, 1, "the leaver's training record is kept");

  checks = await rosterChecks(owner);
  const doneA = checks.find((task) => task.id === checkA.id);
  assert.match(doneA.completion?.note ?? "", /1 new starter \(Dan Starter\).*1 left \(Ann Leaver\)/);
  assert.equal(doneA.completion.completedByName, "Morgan Manager");

  // No / N/A, once a month.
  const na = await complete(owner, checkB.id, { answer: "na" });
  assert.equal(na.status, 201, JSON.stringify(na.data));
  assert.equal(na.data.note, "Not applicable");
  assert.equal((await complete(owner, checkB.id, { answer: "no" })).status, 409, "already answered this month");
  assert.equal((await reconcile(owner, { rows: [{ name: "Cat Lodge" }], siteId: siteB.id, preview: false, rosterCheck: { taskId: checkB.id, date: month } })).data?.rosterCheck?.recorded, false,
    "an answered check is not recorded twice");

  // Only the roster check takes an answer.
  const plain = await owner.request("POST", "/tasks", { title: "Restock first aid", recurrence: "once", startsOn: londonToday(), assigneeRole: "managers", siteId: siteA.id });
  assert.equal(plain.status, 201, JSON.stringify(plain.data));
  assert.equal((await owner.request("POST", `/tasks/${plain.data.id}/complete`, { date: londonToday(), answer: "no" })).status, 400);

  // Editing keeps the check's site, schedule and link; only ComplyTrack makes one.
  const edited = await owner.request("PATCH", `/tasks/${checkA.id}`, {
    title: "Staff roster check", module: "firetrack", siteId: siteB.id, recurrence: "daily", startsOn: "2026-01-05", assigneeUserId: owner.userId, assigneeRole: null,
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.data));
  assert.equal(edited.data.module, "roster_check");
  assert.equal(edited.data.siteId, siteA.id);
  assert.equal(edited.data.recurrence, "monthly");
  assert.equal(edited.data.assigneeUserId, owner.userId, "who answers it can change");
  assert.equal((await owner.request("PATCH", `/tasks/${plain.data.id}`, { module: "roster_check" })).status, 400);

  // An archived check stays archived.
  assert.equal((await owner.request("PATCH", `/tasks/${checkB.id}`, { active: false })).status, 200);
  await add("Eve Later", siteB.id);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const all = await rosterChecks(owner);
  assert.equal(all.filter((task) => task.siteId === siteB.id).length, 1, "not recreated");

  // Reminders: unanswered all month (A's is answered), then next month's.
  const day = (d) => `${month.slice(0, 8)}${d}`;
  const nextMonth = (() => { const d = new Date(`${month}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + 1); return d.toISOString().slice(0, 10); })();
  const dueFor = async (today) => (await collectDueItems(owner.clientId, today, new Date())).items
    .filter((item) => item.module === "tasks" && item.title === "Staff roster check");
  await owner.request("PATCH", `/tasks/${checkB.id}`, { active: true });
  await pool.query("DELETE FROM task_completions WHERE task_id = $1", [checkB.id]);
  let due = await dueFor(day(20));
  assert.deepEqual(due.map((item) => [item.id, item.dueDate]), [[`task:${checkB.id}:${month}`, month]], "B unanswered on the 20th; A answered");
  due = await dueFor(`${nextMonth.slice(0, 8)}05`);
  assert.deepEqual(due.map((item) => item.id).sort(), [`task:${checkA.id}:${nextMonth}`, `task:${checkB.id}:${nextMonth}`].sort(), "next month both are due again");
  assert.equal((await owner.request("PATCH", `/tasks/${checkB.id}`, { active: false })).status, 200);

  console.log("Roster check tests passed.");
}

main().then(() => pool.end()).catch(async (error) => {
  console.error(error);
  await pool.end().catch(() => {});
  process.exit(1);
});
