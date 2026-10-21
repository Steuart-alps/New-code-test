// "Assigned to" people and the personal reminders: the assignee API and its
// checks on track actions and compliance checks, the due-tomorrow email to
// the person responsible (once a day, overdue on day 1 then weekly, group
// tasks on the bell only), and the Owner update (Mondays, or daily by
// setting; Managers see only their departments' sites).
//
// Runs the real app in-process against the fresh-schema harness's disposable
// database and calls the job directly with an injected clock and mailer.
// Synthetic secrets only; no application database, mail, push or storage. Run:
//   FRESH_SCHEMA_BASE=push bash tests/run-fresh-schema.sh tests/personal-reminders.mjs
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

process.env.SESSION_SECRET = "personal-reminders-test-secret-not-a-real-secret";
delete process.env.ENFORCE_CSRF;

const dir = path.dirname(fileURLToPath(import.meta.url));
const outDir = await mkdtemp(path.join(dir, ".build-personal-reminders-"));
let server;
let pool;
let passed = 0;
const ok = (message) => { passed++; console.log(`ok - ${message}`); };

try {
  const outfile = path.join(outDir, "entry.mjs");
  await build({
    entryPoints: [path.join(dir, "personal-reminders.entry.ts")],
    bundle: true, platform: "node", format: "esm", outfile, logLevel: "silent",
    external: ["sharp", "*.node", "pg-native", "pino", "pino-pretty", "@google-cloud/*", "@sentry/*", "nodemailer"],
    banner: { js: "import { createRequire as __testRequire } from 'node:module'; globalThis.require = __testRequire(import.meta.url);" },
  });
  const entry = await import(pathToFileURL(outfile).href);
  pool = entry.pool;
  const { app, runPersonalReminderJob, hashPassword } = entry;

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

  const password = "personal-reminders-fixture-password-123";
  const stamp = Date.now();
  async function register(label) {
    const request = session();
    const email = `personal-${label}-${stamp}@test.local`;
    const registered = await request("POST", "/auth/register", { name: `Owner ${label}`, email, password });
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
  const passwordHash = await hashPassword(password);
  async function joinBusiness(label, role, clientId, name) {
    const email = `personal-${label}-${stamp}@test.local`;
    const [row] = await q(
      `INSERT INTO users (email, password_hash, name, role, client_id) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [email, passwordHash, name, role, clientId],
    );
    return { email, userId: row.id, clientId, name };
  }

  // ── Fixtures ──────────────────────────────────────────────────────────────
  const owner = await register("owner-a");
  const A = owner.clientId;
  const tom = await joinBusiness("tom", "client_staff", A, "Tom Staff");
  const mia = await joinBusiness("mia", "client_manager", A, "Mia Manager");
  const viewer = await joinBusiness("viewer", "client_viewer", A, "Vic Viewer");
  const ownerB = await register("owner-b");
  const B = ownerB.clientId;
  const [redLion] = await q(`INSERT INTO sites (client_id, name) VALUES ($1, 'The Red Lion') RETURNING id`, [A]);
  const [blueBoar] = await q(`INSERT INTO sites (client_id, name) VALUES ($1, 'Blue Boar') RETURNING id`, [A]);
  const [otherSite] = await q(`INSERT INTO sites (client_id, name) VALUES ($1, 'Other Inn') RETURNING id`, [B]);
  // Mia manages the Bar department, which is the Blue Boar's; the Red Lion
  // belongs to the Kitchen department, which she can't see.
  const [bar] = await q(`INSERT INTO departments (client_id, name) VALUES ($1, 'Bar') RETURNING id`, [A]);
  const [kitchen] = await q(`INSERT INTO departments (client_id, name) VALUES ($1, 'Kitchen') RETURNING id`, [A]);
  await q(`UPDATE sites SET department_id = $1 WHERE id = $2`, [bar.id, blueBoar.id]);
  await q(`UPDATE sites SET department_id = $1 WHERE id = $2`, [kitchen.id, redLion.id]);
  await q(`UPDATE users SET department_id = $1 WHERE id = $2`, [bar.id, mia.userId]);
  await q(`UPDATE users SET department_id = $1 WHERE id = $2`, [kitchen.id, tom.userId]);

  const asOwner = await login(owner.email);
  const asTom = await login(tom.email);
  const asViewer = await login(viewer.email);

  // ── Assignee list ─────────────────────────────────────────────────────────
  {
    const all = await asOwner("GET", "/assignees");
    assert.equal(all.status, 200, all.text);
    const ids = all.data.map((person) => person.id);
    for (const id of [owner.userId, tom.userId, mia.userId]) assert.ok(ids.includes(id), `assignable: ${id}`);
    assert.ok(!ids.includes(viewer.userId), "read-only viewers can't be assigned");
    assert.ok(!ids.includes(ownerB.userId), "other businesses' people are never listed");
    const redLionPeople = (await asOwner("GET", `/assignees?siteId=${redLion.id}`)).data.map((person) => person.id);
    assert.ok(!redLionPeople.includes(mia.userId), "a Manager can't be given work at a site outside her departments");
    assert.ok((await asOwner("GET", `/assignees?siteId=${blueBoar.id}`)).data.some((person) => person.id === mia.userId));
    assert.equal((await asOwner("GET", `/assignees?siteId=${otherSite.id}`)).status, 404, "another business's site");
    assert.equal((await asViewer("GET", "/assignees")).status, 403, "viewers are read-only");
    ok("the assignee list is the business's active members who can see the site");
  }

  // ── Assigning track actions and compliance checks ─────────────────────────
  let tomAction;
  {
    const created = await asOwner("POST", "/track-actions", {
      module: "fire", title: "Replace fire door closer", severity: "action_required",
      siteId: redLion.id, dueDate: "2026-10-15", assigneeUserId: tom.userId,
    });
    assert.equal(created.status, 201, created.text);
    tomAction = created.data;
    assert.equal(tomAction.assigneeUserId, tom.userId);
    assert.equal(tomAction.ownerName, "Tom Staff", "picking a person also stores their name");

    for (const [assigneeUserId, label] of [[viewer.userId, "viewer"], [ownerB.userId, "other business"], [mia.userId, "can't see the site"]]) {
      const refused = await asOwner("POST", "/track-actions", {
        module: "fire", title: "Refused", severity: "monitor", siteId: redLion.id, assigneeUserId,
      });
      assert.equal(refused.status, 400, `${label}: ${refused.text}`);
    }

    const typed = await asOwner("POST", "/track-actions", {
      module: "fire", title: "Typed owner", severity: "monitor", siteId: blueBoar.id, ownerName: "Bob Builder",
    });
    assert.equal(typed.status, 201, typed.text);
    assert.equal(typed.data.assigneeUserId, null);
    assert.equal(typed.data.ownerName, "Bob Builder");

    const picked = await asOwner("PATCH", `/track-actions/${typed.data.id}`, { assigneeUserId: mia.userId });
    assert.equal(picked.status, 200, picked.text);
    assert.equal(picked.data.ownerName, "Mia Manager");
    const moved = await asOwner("PATCH", `/track-actions/${typed.data.id}`, { siteId: redLion.id });
    assert.equal(moved.status, 400, "moving to a site the person can't see is refused");
    const retyped = await asOwner("PATCH", `/track-actions/${typed.data.id}`, { ownerName: "Someone Else" });
    assert.equal(retyped.status, 200, retyped.text);
    assert.equal(retyped.data.assigneeUserId, null, "typing a different name unlinks the person");
    await q(`DELETE FROM track_actions WHERE id = $1`, [typed.data.id]);

    const check = await asOwner("POST", "/compliance-items", {
      title: "Gas safety certificate", status: "pending", priority: "high",
      siteId: blueBoar.id, dueDate: "2026-10-15T09:00:00.000Z", assigneeUserId: mia.userId,
    });
    assert.ok(check.status === 200 || check.status === 201, check.text);
    assert.equal(check.data.assigneeUserId, mia.userId);
    assert.equal(check.data.assignedTo, "Mia Manager");
    const allSites = await asOwner("POST", "/compliance-items", {
      title: "EICR", status: "pending", priority: "high", applyToAllSites: true, assigneeUserId: mia.userId,
    });
    assert.equal(allSites.status, 400, "every site's copy needs someone who can see every site");
    const cleared = await asOwner("PUT", `/compliance-items/${check.data.id}`, { assigneeUserId: null });
    assert.equal(cleared.status, 200, cleared.text);
    assert.equal(cleared.data.assigneeUserId, null);
    assert.equal(cleared.data.assignedTo, null, "clearing the person clears their name");
    await asOwner("PUT", `/compliance-items/${check.data.id}`, { assigneeUserId: mia.userId });
    ok("track actions and compliance checks take a person who can see the site, or a typed name");
  }

  // ── Due items for the reminder job ────────────────────────────────────────
  // 2026-10-14 is a Wednesday in BST (UTC+1); 07:15 UTC is 08:15 local.
  await q(`INSERT INTO track_actions (client_id, site_id, module, title, severity, status, due_date, assignee_user_id, owner_name)
           VALUES ($1, $2, 'fire', 'Overdue since yesterday', 'action_required', 'open', '2026-10-13', $3, 'Tom Staff'),
                  ($1, $2, 'fire', 'Overdue three days', 'action_required', 'open', '2026-10-11', $3, 'Tom Staff')`,
    [A, redLion.id, tom.userId]);
  await q(`INSERT INTO compliance_items (client_id, site_id, title, status, priority, due_date)
           VALUES ($1, $2, 'Lift LOLER inspection', 'pending', 'high', '2026-10-15T10:00:00Z')`, [A, redLion.id]);
  await q(`INSERT INTO tasks (client_id, site_id, title, assignee_role, recurrence, starts_on)
           VALUES ($1, $2, 'Stock take', 'client_staff', 'once', '2026-10-15')`, [A, redLion.id]);
  await q(`INSERT INTO staff_roster (client_id, name, email, active) VALUES ($1, 'Tom Staff', $2, true)`, [A, tom.email]);

  const sent = [];
  const send = async (message) => { sent.push(message); return { id: `test-${sent.length}` }; };
  const sendPush = async () => 0;
  const run = (iso) => runPersonalReminderJob({ now: new Date(iso), clientIds: [A, B], send, sendPush });
  const to = (email) => sent.filter((message) => message.to === email.toLowerCase());

  {
    const early = await run("2026-10-14T05:15:00Z");
    assert.equal(early.personalEmails + early.ownerUpdates, 0, "nothing before 08:00 local");

    const result = await run("2026-10-14T07:15:00Z");
    assert.equal(result.errors, 0);
    const [tomMail, ...tomExtra] = to(tom.email);
    assert.ok(tomMail, "Tom gets a due-tomorrow email");
    assert.equal(tomExtra.length, 0, "one email a day");
    assert.match(tomMail.subject, /^Due tomorrow: 1 item at /);
    assert.match(tomMail.html, /Replace fire door closer/);
    assert.match(tomMail.html, /Overdue since yesterday/, "overdue items appear the day after they were due");
    assert.doesNotMatch(tomMail.html, /Overdue three days/, "then only once a week");
    assert.doesNotMatch(tomMail.html, /Lift LOLER/, "unassigned items aren't Tom's");
    assert.doesNotMatch(tomMail.html, /Stock take/, "group tasks don't go by email");
    assert.ok(tomMail.idempotencyKey, "sent with a provider idempotency key");

    const [ownerMail] = to(owner.email);
    assert.ok(ownerMail, "the Owner hears about the unassigned check");
    assert.match(ownerMail.html, /Lift LOLER inspection/);
    assert.doesNotMatch(ownerMail.html, /Replace fire door closer/, "the Owner isn't sent Tom's work");
    assert.doesNotMatch(ownerMail.subject, /update/i, "no Owner update midweek");

    const [miaMail] = to(mia.email);
    assert.ok(miaMail, "Mia's gas check is due tomorrow");
    assert.match(miaMail.html, /Gas safety certificate/);

    const [bell] = await q(`SELECT * FROM user_notifications WHERE user_id = $1 AND kind = 'task_due'`, [tom.userId]);
    assert.ok(bell, "a group task due tomorrow goes on the group's bell");
    assert.match(bell.title, /Stock take/);
    assert.equal((await q(`SELECT 1 FROM user_notifications WHERE user_id = $1 AND kind = 'task_due'`, [owner.userId])).length, 0,
      "Owners aren't in the Staff group");
    assert.equal(to(ownerB.email).length, 0, "business B has nothing due");

    const count = sent.length;
    const again = await run("2026-10-14T08:15:00Z");
    assert.equal(again.personalEmails + again.ownerUpdates, 0);
    assert.equal(sent.length, count, "a second run the same day sends nothing again");
    ok("due-tomorrow emails go once a day to the person responsible; group tasks go on the bell");
  }

  // ── Owner update on Monday ────────────────────────────────────────────────
  {
    sent.length = 0;
    await q(`UPDATE track_actions SET due_date = '2026-10-20' WHERE id = $1`, [tomAction.id]);
    await q(`INSERT INTO track_actions (client_id, site_id, module, title, severity, status, due_date)
             VALUES ($1, $2, 'fire', 'Kitchen extinguisher missing', 'urgent', 'open', '2026-10-21')`, [A, redLion.id]);
    const result = await run("2026-10-19T07:15:00Z");
    assert.equal(result.errors, 0);
    const [update, ...extra] = to(owner.email);
    assert.ok(update, "the Owner gets the weekly update");
    assert.equal(extra.length, 0, "the Owner's own reminders are folded into the update");
    assert.match(update.subject, /^Weekly update for /);
    assert.match(update.html, /Overdue/);
    assert.match(update.html, /Overdue three days[\s\S]*Tom Staff/, "overdue items say who has them");
    assert.match(update.html, /Replace fire door closer/, "due this week");
    assert.match(update.html, /No one assigned[\s\S]*Kitchen extinguisher missing/);
    assert.match(update.html, /Done in the last 7 days/);

    const managerMails = to(mia.email);
    assert.equal(managerMails.length, 1);
    assert.match(managerMails[0].subject, /^Weekly update for /, "Managers get an update too");
    assert.doesNotMatch(managerMails[0].html, /Kitchen extinguisher missing|Overdue three days/,
      "a Manager's update leaves out sites outside her departments");
    assert.match(managerMails[0].html, /Gas safety certificate/);
    ok("Mondays bring one Owner update with the Owner's own reminders folded in; Managers see their sites");
  }

  // ── Owner update setting ──────────────────────────────────────────────────
  {
    assert.equal((await asOwner("PUT", "/settings", { ownerUpdateFrequency: "hourly" })).status, 400);
    assert.equal((await asTom("PUT", "/settings", { ownerUpdateFrequency: "daily" })).status, 403, "only Owners change it");
    const saved = await asOwner("PUT", "/settings", { ownerUpdateFrequency: "daily" });
    assert.equal(saved.status, 200, saved.text);
    assert.equal(saved.data.ownerUpdateFrequency, "daily");
    sent.length = 0;
    await run("2026-10-20T07:15:00Z");
    const [update] = to(owner.email);
    assert.ok(update, "a daily Owner update on a Tuesday");
    assert.match(update.subject, /^Daily update for /);
    ok("Owners can switch the update to daily");
  }

  console.log(`\n${passed} personal reminder checks passed`);
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end().catch(() => {});
  await rm(outDir, { recursive: true, force: true });
}
