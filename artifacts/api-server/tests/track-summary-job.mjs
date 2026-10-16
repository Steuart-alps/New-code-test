// The whole daily track summary job, end to end, against a real database.
//
// Seeds one entitled business (departments, sites in different departments,
// senior admin, designated kitchen and maintenance managers, an ordinary cook,
// a viewer flagged as a manager, a deactivated admin, open and closed actions)
// plus a bystander business, then runs the real runTrackActionReminderJob
// with fake email and push senders and checks:
//   - one grouped email per eligible recipient, never to a viewer, ordinary
//     staff or a deactivated account;
//   - senior management covers every enabled track and every open action;
//   - a department manager sees their own department's and unassigned sites'
//     actions for their tracks, never another department's;
//   - a failed recipient is released and retried on the next run, while
//     recipients already emailed are not emailed again; a third run sends
//     nothing;
//   - the bystander business and every other existing business are neither
//     emailed nor changed (each run is scoped to this run's fixture ids), and
//     the fixtures are removed afterwards through the owned-fixture purge
//     (tests/fixture-ownership.mjs), which also clears their audit rows.
//
// Usage: bash tests/run-db-workflow.sh tests/track-summary-job.mjs
//    or: FRESH_SCHEMA_BASE=push bash tests/run-fresh-schema.sh tests/track-summary-job.mjs
// DATABASE_URL must point at a database with the runtime migrations applied.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { buildOwnedFixturePurgeSql, resolveRunId } from "./fixture-ownership.mjs";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set");

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const outDir = await mkdtemp(path.join(testsDir, ".build-track-summary-job-"));
let lib;
try {
  const outFile = path.join(outDir, "entry.mjs");
  await build({
    entryPoints: [path.join(testsDir, "track-summary-job.entry.ts")],
    bundle: true, platform: "node", format: "esm", outfile: outFile, logLevel: "silent",
    external: ["pg-native", "pino", "pino-pretty", "resend", "@google-cloud/*", "@sentry/*", "nodemailer"],
    banner: { js: `import { createRequire as __bannerCrReq } from 'node:module';\nglobalThis.require = __bannerCrReq(import.meta.url);` },
  });
  lib = await import(pathToFileURL(outFile).href);
} finally {
  await rm(outDir, { recursive: true, force: true });
}

const { runTrackActionReminderJob, pool } = lib;
const q = async (text, values) => (await pool.query(text, values)).rows;
const runId = resolveRunId();
const tag = `track-summary-job-${runId}`;
const fixtureClientIds = [];
let passed = 0;
const ok = (message) => { passed++; console.log(`ok - ${message}`); };

try {
  async function client(label) {
    // No trial end date: every service is entitled, so every track is enabled.
    const [row] = await q(
      `INSERT INTO clients (name, slug, active) VALUES ($1, $2, true) RETURNING id`,
      [`Track job ${label}`, `${tag}-${label}`]);
    fixtureClientIds.push(row.id);
    return row.id;
  }
  async function user(clientId, label, role, extra = {}) {
    const email = `${tag}-${label}@test.local`;
    const [row] = await q(
      `INSERT INTO users (email, password_hash, name, role, client_id, department_id,
         is_department_manager, is_maintenance_manager, active)
       VALUES ($1, 'x', $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [email, `Track job ${label}`, role, clientId, extra.departmentId ?? null,
        extra.departmentManager ?? false, extra.maintenanceManager ?? false, extra.active ?? true]);
    return { id: row.id, email };
  }
  const department = async (clientId, name) =>
    (await q(`INSERT INTO departments (client_id, name) VALUES ($1, $2) RETURNING id`, [clientId, name]))[0].id;
  const site = async (clientId, name, departmentId = null) =>
    (await q(`INSERT INTO sites (client_id, name, department_id) VALUES ($1, $2, $3) RETURNING id`,
      [clientId, name, departmentId]))[0].id;
  const action = (clientId, siteId, module, title, severity, extra = {}) => q(
    `INSERT INTO track_actions (client_id, site_id, module, title, severity, status, due_date,
       resolved_by, resolved_by_name, resolved_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CASE WHEN $8::int IS NULL THEN NULL ELSE now() END)`,
    [clientId, siteId, module, title, severity, extra.status ?? "open", extra.dueDate ?? null,
      extra.resolvedBy?.id ?? null, extra.resolvedBy ? "Track job admin" : null]);

  // ── The business under test ────────────────────────────────────────────
  const X = await client("main");
  const kitchenDept = await department(X, "Kitchen");
  const maintenanceDept = await department(X, "Maintenance");
  const kitchenSite = await site(X, "Kitchen block", kitchenDept);
  const plantSite = await site(X, "Plant room", maintenanceDept);
  const sharedSite = await site(X, "Main house");
  const admin = await user(X, "admin", "client_admin");
  const chef = await user(X, "chef", "client_staff", { departmentId: kitchenDept, departmentManager: true });
  const fixer = await user(X, "fixer", "client_staff", { departmentId: maintenanceDept, maintenanceManager: true });
  const cook = await user(X, "cook", "client_staff", { departmentId: kitchenDept });
  const viewer = await user(X, "viewer", "client_viewer", { departmentId: kitchenDept, departmentManager: true });
  const leaver = await user(X, "leaver", "client_admin", { active: false });
  await action(X, kitchenSite, "kitchen", "Fridge K above 8C", "urgent");
  await action(X, plantSite, "kitchen", "Fridge M door seal", "action_required");
  await action(X, plantSite, "hot_tub", "Tub M chlorine low", "urgent");
  await action(X, kitchenSite, "hot_tub", "Tub K cover torn", "action_required");
  await action(X, sharedSite, "fire", "Extinguisher U missing", "urgent");
  await action(X, kitchenSite, "kitchen", "Resolved K probe", "urgent", { status: "resolved", resolvedBy: admin });
  await action(X, kitchenSite, "kitchen", "Future K monitor", "monitor", { dueDate: "2999-01-01" });
  const openActions = ["Fridge K above 8C", "Fridge M door seal", "Tub M chlorine low", "Tub K cover torn", "Extinguisher U missing"];

  // ── A bystander business that must not be emailed or touched ───────────
  const Y = await client("bystander");
  const bystander = await user(Y, "bystander-admin", "client_admin");
  await action(Y, await site(Y, "Other site"), "kitchen", "Bystander fridge", "urgent");
  // An expired, unsent claim: an unscoped job would reclaim and send it.
  await q(`INSERT INTO track_summary_delivery (client_id, log_date, email, claim_token, claimed_at)
           VALUES ($1, CURRENT_DATE, $2, 'bystander-claim', now() - interval '1 hour')`, [Y, bystander.email]);

  // Everything outside the business under test, to prove the job leaves it alone.
  const othersBefore = await q(
    `SELECT id, client_id, email, sent_at, claim_token, claimed_at FROM track_summary_delivery
     WHERE client_id <> $1 ORDER BY id`, [X]);

  const sent = [];
  const pushes = [];
  let failFor = chef.email;
  const deps = {
    clientIds: [X],
    send: async (message) => {
      if (message.to === failFor) throw new Error("simulated provider failure");
      sent.push(message);
    },
    sendPush: async (userIds, payload) => { pushes.push({ userIds: [...userIds], payload }); },
  };

  // ── First run: the chef's email fails ──────────────────────────────────
  const first = await runTrackActionReminderJob(deps);
  assert.equal(first.clientsChecked, 1, "the run is scoped to the fixture business");
  assert.equal(first.emailsSent, 2);
  assert.equal(first.errors, 1, "the failed recipient is counted");
  assert.ok(sent.every((message) => message.clientId === X), "only the fixture business is emailed");
  const byRecipient = new Map(sent.map((message) => [message.to, message]));
  assert.equal(byRecipient.size, sent.length, "one grouped email per recipient");
  assert.deepEqual([...byRecipient.keys()].sort(), [admin.email, fixer.email].sort());
  ok("one grouped email per eligible recipient; viewers, ordinary staff and leavers get none");

  const enabledTracks = 20;
  const seniorMail = byRecipient.get(admin.email);
  assert.match(seniorMail.subject, new RegExp(`^Daily track summary: ${enabledTracks} tracks, ${openActions.length} actions$`));
  for (const title of openActions) assert.ok(seniorMail.text.includes(title), `senior sees ${title}`);
  for (const title of ["Resolved K probe", "Future K monitor", "Bystander fridge"]) {
    assert.ok(!seniorMail.text.includes(title), `senior never sees ${title}`);
  }
  ok("senior management covers every enabled track and every open action, nothing resolved or foreign");

  // Automatic matching: "Maintenance" is a default department for these
  // tracks, "Kitchen" for DailyTrack AM/PM and KitchenTrack.
  const maintenanceTracks = ["FireTrack", "LegionellaTrack", "AquaTrack", "PATtrack", "PestTrack", "FixTrack",
    "PremisesTrack", "TubTrack", "TreeTrack", "BikeTrack", "GreenTrack", "RoomTrack"];
  const fixerMail = byRecipient.get(fixer.email);
  assert.equal(fixerMail.subject, `Daily track summary: ${maintenanceTracks.length} tracks, 2 actions`);
  for (const label of maintenanceTracks) assert.ok(fixerMail.html.includes(`>${label}</a>`), `maintenance manager gets ${label}`);
  for (const label of ["KitchenTrack", "DailyTrack AM", "SafeTrack"]) {
    assert.ok(!fixerMail.html.includes(`>${label}</a>`), `maintenance manager does not get ${label}`);
  }
  assert.ok(fixerMail.text.includes("Tub M chlorine low") && fixerMail.text.includes("Extinguisher U missing"));
  for (const title of ["Tub K cover torn", "Fridge K above 8C", "Fridge M door seal"]) {
    assert.ok(!fixerMail.text.includes(title) && !fixerMail.html.includes(title), `maintenance manager never sees ${title}`);
  }
  ok("a department manager gets their matched tracks, with own-department and unassigned-site actions only");

  assert.deepEqual(pushes.map((push) => push.userIds.sort()).sort(),
    [[admin.id], [fixer.id]].sort(), "push goes to the emailed accounts only");
  const rowsAfterFirst = await q(
    `SELECT email, sent_at IS NOT NULL AS sent, claim_token IS NULL AS released FROM track_summary_delivery
     WHERE client_id = $1 ORDER BY email`, [X]);
  assert.deepEqual(rowsAfterFirst.map((row) => [row.email, row.sent]).sort(),
    [[admin.email, true], [fixer.email, true]].sort(), "the failed claim is released, the sent ones finalised");
  ok("sent recipients are finalised and the failed recipient's claim is released");

  // ── Second run: only the failed recipient is retried ───────────────────
  failFor = null;
  sent.length = 0;
  const second = await runTrackActionReminderJob(deps);
  assert.equal(second.emailsSent, 1);
  assert.equal(second.errors, 0);
  assert.deepEqual(sent.map((message) => message.to), [chef.email], "only the failed recipient is retried");
  const chefMail = sent[0];
  assert.equal(chefMail.subject, "Daily track summary: 3 tracks, 1 action");
  for (const label of ["DailyTrack AM", "DailyTrack PM", "KitchenTrack"]) {
    assert.ok(chefMail.html.includes(`>${label}</a>`), `kitchen manager gets ${label}`);
  }
  assert.ok(!chefMail.html.includes(">TubTrack</a>"), "kitchen manager does not get TubTrack");
  assert.ok(chefMail.text.includes("Fridge K above 8C"));
  for (const title of ["Fridge M door seal", "Tub K cover torn", "Tub M chlorine low"]) {
    assert.ok(!chefMail.text.includes(title) && !chefMail.html.includes(title), `kitchen manager never sees ${title}`);
  }
  ok("a failed recipient is retried on the next run without resending to the others");

  // ── Third run: nothing left to send ────────────────────────────────────
  sent.length = 0;
  const third = await runTrackActionReminderJob(deps);
  assert.equal(third.emailsSent, 0);
  assert.equal(sent.length, 0, "a rerun on the same day sends nothing");
  const finalRows = await q(
    `SELECT email FROM track_summary_delivery WHERE client_id = $1 AND sent_at IS NOT NULL AND claim_token IS NULL`, [X]);
  assert.deepEqual(finalRows.map((row) => row.email).sort(), [admin.email, chef.email, fixer.email].sort());
  ok("rerunning the same day sends nothing");

  // ── Nobody else was emailed or changed ─────────────────────────────────
  assert.ok(![...byRecipient.keys(), chef.email].includes(bystander.email));
  const othersAfter = await q(
    `SELECT id, client_id, email, sent_at, claim_token, claimed_at FROM track_summary_delivery
     WHERE client_id <> $1 ORDER BY id`, [X]);
  assert.deepEqual(othersAfter, othersBefore, "no other business's delivery state changed, the bystander's open claim included");
  for (const unexpected of [cook.email, viewer.email, leaver.email]) {
    assert.equal((await q(`SELECT count(*)::int AS n FROM track_summary_delivery WHERE email = $1`, [unexpected]))[0].n, 0);
  }
  ok("the bystander business and existing businesses are neither emailed nor changed");
} finally {
  if (fixtureClientIds.length > 0) {
    const cleanup = await pool.connect();
    try {
      await cleanup.query(buildOwnedFixturePurgeSql({ runId, clientIds: fixtureClientIds }));
    } catch (err) {
      await cleanup.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      cleanup.release();
    }
    const [left] = await q(
      `SELECT (SELECT count(*) FROM users WHERE client_id = ANY($1::int[]))
            + (SELECT count(*) FROM track_actions WHERE client_id = ANY($1::int[]))
            + (SELECT count(*) FROM track_summary_delivery WHERE client_id = ANY($1::int[]))
            + (SELECT count(*) FROM sites WHERE client_id = ANY($1::int[]))
            + (SELECT count(*) FROM departments WHERE client_id = ANY($1::int[]))::int AS n`, [fixtureClientIds]);
    assert.equal(Number(left.n), 0, "fixtures are removed");
  }
  await pool.end();
}
console.log(`Track summary job: ${passed} checks passed; fixtures removed.`);
