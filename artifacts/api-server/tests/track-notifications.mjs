// Track owners and in-app notifications: owner resolution (site owner ->
// module owner -> business admins), the owner API's tenant and role checks,
// the notification list/read API's user and business scoping, and the
// hourly reminder job creating deduplicated notifications (never email).
//
// Runs the real app in-process against the fresh-schema harness's disposable
// database and calls the reminder job directly with an injected clock.
// Synthetic secrets only; no application database, mail, push or storage. Run:
//   bash tests/run-fresh-schema.sh tests/track-notifications.mjs
//   FRESH_SCHEMA_BASE=push bash tests/run-fresh-schema.sh tests/track-notifications.mjs
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

if (process.env.NODE_ENV !== "test" || process.env.FRESH_SCHEMA_TEST !== "1" || !process.env.DATABASE_URL) {
  throw new Error("Run through tests/run-fresh-schema.sh: a disposable database is required");
}
if (!/[?&]host=\//.test(process.env.DATABASE_URL)) {
  throw new Error("Refusing to run: DATABASE_URL is not the harness's private Unix-socket database");
}

process.env.SESSION_SECRET = "track-notifications-test-secret-not-a-real-secret";
delete process.env.ENFORCE_CSRF;

const dir = path.dirname(fileURLToPath(import.meta.url));
const outDir = await mkdtemp(path.join(dir, ".build-track-notifications-"));
let server;
let pool;
let passed = 0;
const ok = (message) => { passed++; console.log(`ok - ${message}`); };

try {
  const outfile = path.join(outDir, "entry.mjs");
  await build({
    entryPoints: [path.join(dir, "track-notifications.entry.ts")],
    bundle: true, platform: "node", format: "esm", outfile, logLevel: "silent",
    external: ["sharp", "*.node", "pg-native", "pino", "pino-pretty", "@google-cloud/*", "@sentry/*", "nodemailer"],
    banner: { js: "import { createRequire as __testRequire } from 'node:module'; globalThis.require = __testRequire(import.meta.url);" },
  });
  const entry = await import(pathToFileURL(outfile).href);
  pool = entry.pool;
  const { app, resolveTrackOwnerIds, runTrackReminderJob, hashPassword } = entry;

  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const q = async (text, values) => (await pool.query(text, values)).rows;

  function session() {
    let cookie = "";
    return async (method, urlPath, body) => {
      const response = await fetch(`${base}${urlPath}`, {
        method,
        headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
      const setCookie = response.headers.get("set-cookie");
      if (setCookie) cookie = setCookie.split(";")[0];
      const text = await response.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = null; }
      return { status: response.status, text, data };
    };
  }

  const password = "track-notify-fixture-password-123";
  const stamp = Date.now();
  async function register(label) {
    const request = session();
    const email = `track-notify-${label}-${stamp}@test.local`;
    const registered = await request("POST", "/auth/register", { name: `Notify ${label}`, email, password });
    assert.equal(registered.status, 200, registered.text);
    assert.equal((await request("GET", `/auth/verify-email?token=${encodeURIComponent(registered.data.verificationToken)}`)).status, 200);
    const userId = registered.data.user.id;
    const [row] = await q(`SELECT client_id FROM users WHERE id = $1`, [userId]);
    return { email, userId, clientId: row.client_id };
  }
  async function login(email) {
    const request = session();
    const result = await request("POST", "/auth/login", { email, password });
    assert.equal(result.status, 200, result.text);
    return request;
  }
  // Registration is limited to five per IP, so colleagues are inserted directly.
  const passwordHash = await hashPassword(password);
  async function joinBusiness(label, role, clientId) {
    const email = `track-notify-${label}-${stamp}@test.local`;
    const [row] = await q(
      `INSERT INTO users (email, password_hash, name, role, client_id) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [email, passwordHash, `Notify ${label}`, role, clientId],
    );
    return { email, userId: row.id, clientId };
  }

  // ── Fixtures: business A (owner, admin, staff, viewer, linked consultant), business B ──
  const ownerA = await register("owner-a");
  const A = ownerA.clientId;
  const admin = await joinBusiness("admin-a", "client_admin", A);
  const staff = await joinBusiness("staff-a", "client_staff", A);
  const viewer = await joinBusiness("viewer-a", "client_viewer", A);
  const linked = await register("consultant-c"); // own business, linked to A
  await q(`INSERT INTO consultant_clients (user_id, client_id) VALUES ($1, $2)`, [linked.userId, A]);
  const ownerB = await register("owner-b");
  const B = ownerB.clientId;
  assert.notEqual(A, B);
  const [site1] = await q(`INSERT INTO sites (client_id, name) VALUES ($1, 'The Red Lion') RETURNING id`, [A]);
  const [site2] = await q(`INSERT INTO sites (client_id, name) VALUES ($1, 'Blue Boar') RETURNING id`, [A]);
  const [siteB] = await q(`INSERT INTO sites (client_id, name) VALUES ($1, 'Other Inn') RETURNING id`, [B]);

  const asOwnerA = await login(ownerA.email);
  const asAdmin = await login(admin.email);
  const asStaff = await login(staff.email);
  const asViewer = await login(viewer.email);
  const asLinked = await login(linked.email);
  const asOwnerB = await login(ownerB.email);
  const sorted = (ids) => [...ids].sort((a, b) => a - b);
  const fallbackA = sorted([ownerA.userId, admin.userId, linked.userId]);

  // ── Owner resolution fallback ──────────────────────────────────────────
  assert.deepEqual(sorted(await resolveTrackOwnerIds(A, "daily_am", site1.id)), fallbackA,
    "no owner: admins, the self-signup owner and linked consultants; never staff or viewers");
  ok("no owner set: reminders resolve to the business's admins and consultants");

  const setOwner = await asOwnerA("PUT", "/track-owners", { module: "daily_am", userId: staff.userId });
  assert.equal(setOwner.status, 200, setOwner.text);
  assert.equal(setOwner.data.siteId, null);
  assert.deepEqual(await resolveTrackOwnerIds(A, "daily_am", site1.id), [staff.userId]);
  assert.deepEqual(await resolveTrackOwnerIds(A, "daily_am", site2.id), [staff.userId]);
  ok("module-wide owner applies to every site");

  const override = await asAdmin("PUT", "/track-owners", { module: "daily_am", siteId: site2.id, userId: admin.userId });
  assert.equal(override.status, 200, override.text);
  assert.deepEqual(await resolveTrackOwnerIds(A, "daily_am", site2.id), [admin.userId]);
  assert.deepEqual(await resolveTrackOwnerIds(A, "daily_am", site1.id), [staff.userId]);
  const replaced = await asAdmin("PUT", "/track-owners", { module: "daily_am", siteId: site2.id, userId: admin.userId });
  assert.equal(replaced.data.id, override.data.id, "setting again replaces, not duplicates");
  ok("site owner overrides the module owner; replace is idempotent");

  await q(`UPDATE users SET active = false WHERE id = $1`, [staff.userId]);
  assert.deepEqual(sorted(await resolveTrackOwnerIds(A, "daily_am", site1.id)), fallbackA);
  await q(`UPDATE users SET active = true WHERE id = $1`, [staff.userId]);
  const [dept] = await q(`INSERT INTO departments (client_id, name) VALUES ($1, 'Bar') RETURNING id`, [A]);
  const [dept2] = await q(`INSERT INTO departments (client_id, name) VALUES ($1, 'Kitchen') RETURNING id`, [A]);
  await q(`UPDATE users SET department_id = $1 WHERE id = $2`, [dept.id, staff.userId]);
  await q(`UPDATE sites SET department_id = $1 WHERE id = $2`, [dept2.id, site1.id]);
  assert.deepEqual(sorted(await resolveTrackOwnerIds(A, "daily_am", site1.id)), fallbackA,
    "an owner who can't see the site's department falls through");
  await q(`UPDATE sites SET department_id = NULL WHERE id = $1`, [site1.id]);
  await q(`UPDATE users SET department_id = NULL WHERE id = $1`, [staff.userId]);
  ok("inactive or department-blocked owners fall through to the admins");

  // ── Owner API: validation, tenant and role checks ────────────────────────
  {
    const cases = [
      [asOwnerA, { module: "daily_am", userId: ownerB.userId }, 400, "user from another business"],
      [asOwnerA, { module: "daily_am", userId: viewer.userId }, 400, "read-only viewer"],
      [asOwnerA, { module: "daily_am", siteId: siteB.id, userId: staff.userId }, 400, "site from another business"],
      [asOwnerA, { module: "not_a_track", userId: staff.userId }, 400, "unknown module"],
      [asStaff, { module: "fire", userId: staff.userId }, 403, "staff cannot assign"],
      [asViewer, { module: "fire", userId: staff.userId }, 403, "viewer cannot assign"],
      [asOwnerB, { module: "fire", userId: staff.userId }, 400, "business B cannot assign A's user"],
    ];
    for (const [request, body, status, label] of cases) {
      const result = await request("PUT", "/track-owners", body);
      assert.equal(result.status, status, `${label}: ${result.text}`);
    }
    const crossTenant = await asOwnerA("PUT", `/track-owners?clientId=${B}`, { module: "fire", userId: ownerA.userId });
    assert.equal(crossTenant.status, 403, "a clientId the caller can't access is refused");
    const linkedSet = await asLinked("PUT", `/track-owners?clientId=${A}`, { module: "fire", userId: linked.userId });
    assert.equal(linkedSet.status, 200, `linked consultant manages A: ${linkedSet.text}`);
    const removeOther = await asOwnerB("DELETE", `/track-owners/${linkedSet.data.id}`);
    assert.equal(removeOther.status, 404, "another business can't remove A's owner");
    assert.equal((await asOwnerA("DELETE", `/track-owners/${linkedSet.data.id}`)).status, 204);

    const listStaff = await asStaff("GET", "/track-owners");
    assert.equal(listStaff.status, 200, listStaff.text);
    assert.deepEqual(listStaff.data.users, [], "colleague details only for admins");
    assert.ok(listStaff.data.owners.some((row) => row.module === "daily_am" && row.userId === staff.userId));
    const listAdmin = await asOwnerA("GET", "/track-owners");
    assert.ok(listAdmin.data.modules.find((m) => m.key === "daily_am")?.enabled, "trial businesses have every track");
    assert.deepEqual(sorted(listAdmin.data.users.map((u) => u.id)), sorted([ownerA.userId, admin.userId, staff.userId, linked.userId]));
    assert.ok(!listAdmin.data.users.some((u) => u.id === viewer.userId));
    const listB = await asOwnerB("GET", "/track-owners");
    assert.equal(listB.data.owners.length, 0, "business B sees none of A's owners");
    ok("owner API validates users/sites against the business and enforces roles");
  }

  // ── Reminder job: AM at 11:00 local, deduplicated ────────────────────────
  // 2026-10-13 is BST (UTC+1); accounts default to Europe/London.
  const at = (iso) => new Date(iso);
  const pushes = [];
  const sendPush = async (userIds, payload) => { pushes.push({ userIds, payload }); return 0; };
  const runJob = (iso) => runTrackReminderJob({ now: at(iso), clientIds: [A, B], sendPush, skipPurge: true });
  const notificationsFor = (userId) => q(
    `SELECT * FROM user_notifications WHERE user_id = $1 ORDER BY id`, [userId]);

  // Site 1 used the AM and PM checklists recently; site 2 never has, but has its own AM owner.
  await q(`INSERT INTO daily_checklists (client_id, site_id, checklist_type, check_date, submitted_at)
           VALUES ($1, $2, 'kitchen_opening', '2026-10-10', now()), ($1, $2, 'kitchen_closing', '2026-10-10', now())`, [A, site1.id]);
  // Business B: AM done today on mobile, so nothing is due there.
  await q(`INSERT INTO daily_checklist_submissions (client_id, site_id, checklist_date, type, submitted_at)
           VALUES ($1, $2, '2026-10-12', 'am', now()), ($1, $2, '2026-10-13', 'am', now()),
                  ($1, $2, '2026-10-14', 'am', now())`, [B, siteB.id]);

  {
    const early = await runJob("2026-10-13T07:00:00Z"); // 08:00 London: no phase
    assert.equal(early.notificationsCreated, 0);
    const amRun = await runJob("2026-10-13T10:30:00Z"); // 11:30 London
    assert.equal(amRun.errors, 0);
    assert.equal(amRun.notificationsCreated, 2, JSON.stringify(amRun));
    const [staffNote] = await notificationsFor(staff.userId);
    assert.equal(staffNote.kind, "daily_am");
    assert.equal(staffNote.site_id, site1.id);
    assert.equal(staffNote.client_id, A);
    assert.equal(staffNote.title, "AM checklist not done — The Red Lion");
    assert.equal(staffNote.link_path, "/daily-track-am");
    assert.equal(staffNote.dedupe_key, `daily_am:site:${site1.id}:2026-10-13`);
    const [adminNote] = await notificationsFor(admin.userId);
    assert.equal(adminNote.site_id, site2.id, "site override owner gets site 2");
    assert.equal((await q(`SELECT count(*)::int AS n FROM user_notifications WHERE client_id = $1`, [B]))[0].n, 0,
      "business B finished its AM checklist (mobile store)");
    assert.equal(pushes.length, 2, "one push per new notification");
    assert.equal(pushes[0].payload.data.route, "/checks/daily");

    const again = await runJob("2026-10-13T11:30:00Z"); // 12:30, still in the window
    assert.equal(again.notificationsCreated, 0, "deduplicated per owner, kind, site and day");
    assert.equal(pushes.length, 2, "no repeat push");
    const late = await runJob("2026-10-13T14:30:00Z"); // 15:30: AM window over
    assert.equal(late.notificationsCreated, 0);
    ok("AM reminder: one notification per site owner, deduplicated, pushed once");

    // Completing site 2's AM the next day means no reminder for it then.
    await q(`INSERT INTO daily_checklists (client_id, site_id, checklist_type, check_date, submitted_at)
             VALUES ($1, $2, 'premises_opening', '2026-10-14', now())`, [A, site2.id]);
    const nextDay = await runJob("2026-10-14T10:05:00Z");
    assert.equal(nextDay.notificationsCreated, 1, "only site 1 is outstanding on the 14th");
    const staffNotes = await notificationsFor(staff.userId);
    assert.equal(staffNotes.at(-1).dedupe_key, `daily_am:site:${site1.id}:2026-10-14`);
    ok("a submitted checklist is not chased; each day gets its own reminder");
  }

  // ── PM checklist and kitchen diary at 21:00 local ───────────────────────
  {
    await q(`INSERT INTO food_safety_records (client_id, site_id, record_date, submitted_at)
             VALUES ($1, $2, '2026-10-11', now())`, [A, site1.id]);
    const before = pushes.length;
    const pmRun = await runJob("2026-10-13T20:15:00Z"); // 21:15 London
    assert.equal(pmRun.errors, 0);
    // Site 1 only (site 2 never used PM or the diary): PM + diary, each to 3 admins.
    assert.equal(pmRun.notificationsCreated, 6, JSON.stringify(pmRun));
    const rows = await q(`SELECT kind, site_id, user_id FROM user_notifications
                          WHERE client_id = $1 AND kind IN ('daily_pm', 'kitchen_diary') ORDER BY kind, user_id`, [A]);
    assert.deepEqual(sorted(rows.filter((r) => r.kind === "daily_pm").map((r) => r.user_id)), fallbackA);
    assert.deepEqual(sorted(rows.filter((r) => r.kind === "kitchen_diary").map((r) => r.user_id)), fallbackA);
    assert.ok(rows.every((r) => r.site_id === site1.id));
    assert.equal(pushes.length - before, 6);
    ok("PM checklist and kitchen diary reminders go to the admins when no owner is set");
  }

  // ── Overdue checks at 09:00 local ───────────────────────────────────────
  {
    assert.equal((await asOwnerA("PUT", "/track-owners", { module: "compliance", userId: staff.userId })).status, 200);
    await q(`INSERT INTO compliance_items (client_id, title, status, due_date) VALUES
             ($1, 'Gas safety certificate', 'pending', '2026-10-01'),
             ($1, 'EICR', 'completed', '2026-10-01'),
             ($1, 'LOLER inspection', 'pending', '2026-12-01')`, [A]);
    await q(`INSERT INTO track_actions (client_id, site_id, module, title, severity, status, due_date) VALUES
             ($1, $2, 'fire', 'Replace fire door closer', 'action_required', 'open', '2026-10-05'),
             ($1, $2, 'fire', 'Not due yet', 'action_required', 'open', '2026-10-20')`, [A, site1.id]);
    await q(`INSERT INTO track_actions (client_id, site_id, module, title, severity, status, due_date,
               resolved_by, resolved_by_name, resolver_signature, resolved_at)
             VALUES ($1, $2, 'fire', 'Already fixed', 'action_required', 'resolved', '2026-10-05',
               $3, 'Notify admin', 'data:image/png;base64,AAAA', now())`, [A, site1.id, admin.userId]);
    const overdueRun = await runJob("2026-10-13T08:10:00Z"); // 09:10 London
    assert.equal(overdueRun.errors, 0);
    const compliance = await q(`SELECT * FROM user_notifications WHERE client_id = $1 AND kind = 'overdue_compliance'`, [A]);
    assert.equal(compliance.length, 1, "compliance owner only");
    assert.equal(compliance[0].user_id, staff.userId);
    assert.equal(compliance[0].site_id, null);
    assert.match(compliance[0].title, /^1 compliance check overdue — /);
    assert.equal(compliance[0].body, "Overdue: Gas safety certificate.");
    assert.equal(compliance[0].link_path, "/external");
    assert.equal(compliance[0].dedupe_key, `overdue_compliance:client:${A}:2026-10-13`);
    const fire = await q(`SELECT * FROM user_notifications WHERE client_id = $1 AND kind = 'overdue_actions_fire'`, [A]);
    assert.deepEqual(sorted(fire.map((r) => r.user_id)), fallbackA);
    assert.equal(fire[0].title, "1 FireTrack action overdue — The Red Lion");
    assert.equal(fire[0].body, "Overdue: Replace fire door closer.");
    assert.equal(fire[0].link_path, "/fire-safety");
    const repeat = await runJob("2026-10-13T09:10:00Z");
    assert.equal(repeat.notificationsCreated, 0);
    ok("overdue compliance checks and track actions go to the module owner (or admins), once a day");
  }

  // ── FireTrack checks due today or tomorrow, at 09:00 local ──────────────
  {
    // Weekly alarm due tomorrow, monthly emergency lighting due today, the
    // 6-monthly drill due tomorrow; the extinguisher check is not due yet.
    await q(`INSERT INTO fire_safety_checks (client_id, site_id, check_type, check_date, result, call_point, night_staff) VALUES
             ($1, $2, 'alarm', '2026-10-09', 'pass', 'CP1', NULL),
             ($1, $2, 'emergency_lights', '2026-09-15', 'pass', NULL, NULL),
             ($1, $2, 'fire_drill', '2026-04-19', 'pass', NULL, 'included'),
             ($1, $2, 'extinguishers', '2026-10-14', 'pass', NULL, NULL)`, [A, site1.id]);
    const dueFire = async (day) => q(`SELECT * FROM user_notifications WHERE client_id = $1 AND kind = 'due_fire'
                                       AND dedupe_key LIKE $2`, [A, `%:${day}`]);
    // The day before the emergency lighting test is due, only it is mentioned.
    assert.equal((await runJob("2026-10-14T08:20:00Z")).errors, 0); // 09:20 London
    const dayBefore = await dueFire("2026-10-14");
    assert.deepEqual(sorted(dayBefore.map((r) => r.user_id)), fallbackA, "the fire owner (here the admins) is reminded");
    assert.equal(dayBefore[0].title, "1 FireTrack check due tomorrow — The Red Lion");
    assert.equal(dayBefore[0].body, "Due tomorrow: Emergency lighting flick test.");

    const dueRun = await runJob("2026-10-15T08:20:00Z");
    assert.equal(dueRun.errors, 0);
    const due = await dueFire("2026-10-15");
    assert.deepEqual(sorted(due.map((r) => r.user_id)), fallbackA);
    assert.ok(due.every((r) => r.site_id === site1.id), "only the site with checks due");
    assert.equal(due[0].title, "3 FireTrack checks due today — The Red Lion");
    assert.equal(due[0].body, "Due today: Emergency lighting flick test. Due tomorrow: Alarm test, Fire drill.");
    assert.equal(due[0].link_path, "/fire-safety");
    assert.equal(due[0].dedupe_key, `due_fire:site:${site1.id}:2026-10-15`);
    assert.equal((await runJob("2026-10-15T09:20:00Z")).notificationsCreated, 0, "once a day");
    ok("FireTrack checks due today or tomorrow remind the owner the day before");
  }

  // ── Notification API: scoped to the user and the active business ─────────
  {
    const staffList = await asStaff("GET", "/notifications");
    assert.equal(staffList.status, 200, staffList.text);
    const staffRows = await q(`SELECT id FROM user_notifications WHERE user_id = $1 AND client_id = $2`, [staff.userId, A]);
    assert.equal(staffList.data.notifications.length, staffRows.length);
    assert.equal(staffList.data.unreadCount, staffRows.length);
    assert.ok(staffList.data.notifications.every((n) => staffRows.some((r) => r.id === n.id)), "only the user's own rows");
    const ids = staffList.data.notifications.map((n) => n.id);
    assert.deepEqual(ids, [...ids].sort((a, b) => b - a), "newest first");
    const first = staffList.data.notifications[0];
    assert.ok(first.title && first.linkPath && first.createdAt && first.readAt === null);

    const adminRow = (await notificationsFor(admin.userId))[0];
    assert.equal((await asStaff("POST", `/notifications/${adminRow.id}/read`, {})).status, 404, "can't read a colleague's");
    assert.equal((await asOwnerB("POST", `/notifications/${first.id}/read`, {})).status, 404, "another business can't");
    const bList = await asOwnerB("GET", "/notifications");
    assert.equal(bList.data.notifications.length, 0);
    assert.equal(bList.data.unreadCount, 0);
    assert.equal((await asOwnerB("GET", `/notifications?clientId=${A}`)).status, 403);
    assert.equal((await asViewer("POST", "/notifications/read-all", {})).status, 403, "viewers are read-only");

    // The linked consultant sees A's reminders only while working in A.
    const linkedInA = await asLinked("GET", `/notifications?clientId=${A}`);
    assert.ok(linkedInA.data.notifications.length > 0);
    const linkedHome = await asLinked("GET", "/notifications");
    assert.equal(linkedHome.data.notifications.length, 0, "the consultant's own business has none");

    const read = await asStaff("POST", `/notifications/${first.id}/read`, {});
    assert.equal(read.status, 200, read.text);
    const afterOne = await asStaff("GET", "/notifications");
    assert.equal(afterOne.data.unreadCount, staffRows.length - 1);
    assert.ok(afterOne.data.notifications.find((n) => n.id === first.id).readAt);
    const all = await asStaff("POST", "/notifications/read-all", {});
    assert.equal(all.status, 200);
    assert.equal(all.data.updated, staffRows.length - 1);
    assert.equal((await asStaff("GET", "/notifications")).data.unreadCount, 0);
    const adminStill = await asAdmin("GET", "/notifications");
    assert.ok(adminStill.data.unreadCount > 0, "marking read is per user");
    ok("notification list and read endpoints are scoped to the user and business");
  }

  // ── Never email ─────────────────────────────────────────────────────────
  {
    const capture = process.env.TEST_EMAIL_CAPTURE_PATH;
    if (capture) {
      const { readFile } = await import("node:fs/promises");
      const text = await readFile(capture, "utf8").catch(() => "");
      assert.ok(!/checklist not done|overdue —/i.test(text), "reminders are not emailed");
    }
    ok("the reminder job sends no email");
  }

  console.log(`Track notifications: ${passed} checks passed.`);
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end().catch(() => {});
  await rm(outDir, { recursive: true, force: true });
}
