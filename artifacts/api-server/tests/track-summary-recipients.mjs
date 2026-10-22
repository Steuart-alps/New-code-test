// Track summary recipient preview: GET /settings/track-summary-recipients
// shows each track's automatic matches, named assignments and senior
// fallback for the caller's own business only, previews unsaved choices
// without saving them, and names exactly the addresses the daily job emails.
//
// Runs the real app in-process against the fresh-schema harness's disposable
// database and calls the daily job directly with a capturing sender.
// Synthetic secrets only; no application database, mail, push or storage. Run:
//   bash tests/run-fresh-schema.sh tests/track-summary-recipients.mjs
//   FRESH_SCHEMA_BASE=push bash tests/run-fresh-schema.sh tests/track-summary-recipients.mjs
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

process.env.SESSION_SECRET = "track-summary-recipients-test-secret-not-real";
delete process.env.ENFORCE_CSRF;

const dir = path.dirname(fileURLToPath(import.meta.url));
const outDir = await mkdtemp(path.join(dir, ".build-track-summary-recipients-"));
let server;
let pool;
let passed = 0;
const ok = (message) => { passed++; console.log(`ok - ${message}`); };

try {
  const outfile = path.join(outDir, "entry.mjs");
  await build({
    entryPoints: [path.join(dir, "track-summary-recipients.entry.ts")],
    bundle: true, platform: "node", format: "esm", outfile, logLevel: "silent",
    external: ["sharp", "*.node", "pg-native", "pino", "pino-pretty", "@google-cloud/*", "@sentry/*", "nodemailer"],
    banner: { js: "import { createRequire as __testRequire } from 'node:module'; globalThis.require = __testRequire(import.meta.url);" },
  });
  const entry = await import(pathToFileURL(outfile).href);
  pool = entry.pool;
  const { app, runTrackActionReminderJob, hashPassword } = entry;

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

  const password = "track-summary-fixture-password-123";
  const stamp = Date.now();
  async function register(label) {
    const request = session();
    const email = `track-summary-${label}-${stamp}@test.local`;
    const registered = await request("POST", "/auth/register", { name: `Summary ${label}`, email, password });
    assert.equal(registered.status, 200, registered.text);
    assert.equal((await request("GET", `/auth/verify-email?token=${encodeURIComponent(registered.data.verificationToken)}`)).status, 200);
    const [row] = await q(`SELECT client_id FROM users WHERE id = $1`, [registered.data.user.id]);
    return { email, userId: registered.data.user.id, clientId: row.client_id };
  }
  async function login(email) {
    const request = session();
    const result = await request("POST", "/auth/login", { email, password });
    assert.equal(result.status, 200, result.text);
    return request;
  }
  // Registration is limited per IP, so colleagues are inserted directly.
  const passwordHash = await hashPassword(password);
  async function addUser(label, role, clientId, extra = {}) {
    const email = `track-summary-${label}-${stamp}@test.local`;
    const [row] = await q(
      `INSERT INTO users (email, password_hash, name, role, client_id, department_id,
         is_department_manager, is_maintenance_manager, all_departments, active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [email, passwordHash, `Summary ${label}`, role, clientId, extra.departmentId ?? null,
        extra.departmentManager ?? false, extra.maintenanceManager ?? false, extra.allDepartments ?? false, extra.active ?? true],
    );
    for (const departmentId of extra.extraDepartmentIds ?? []) {
      await q(`INSERT INTO user_departments (user_id, department_id) VALUES ($1, $2)`, [row.id, departmentId]);
    }
    return { email, userId: row.id, name: `Summary ${label}` };
  }
  const department = async (clientId, name) =>
    (await q(`INSERT INTO departments (client_id, name) VALUES ($1, $2) RETURNING id`, [clientId, name]))[0].id;

  // ── Fixtures ────────────────────────────────────────────────────────────
  const ownerA = await register("owner-a");
  const A = ownerA.clientId;
  const ownerB = await register("owner-b");
  const B = ownerB.clientId;
  assert.notEqual(A, B);
  const kitchen = await department(A, "Kitchen");
  const housekeeping = await department(A, "Housekeeping");
  const maintenance = await department(A, "Maintenance");
  const leisure = await department(A, "Leisure");
  const grounds = await department(A, "Grounds");
  const kitchenB = await department(B, "Kitchen");

  const admin = await addUser("admin-a", "client_admin", A);
  const chef = await addUser("chef-a", "client_staff", A, { departmentId: kitchen, departmentManager: true });
  const cook = await addUser("cook-a", "client_staff", A, { departmentId: kitchen }); // not designated
  await addUser("housekeeper-a", "client_staff", A, { departmentId: housekeeping }); // not designated
  const fixer = await addUser("fixer-a", "client_staff", A, { departmentId: maintenance, maintenanceManager: true });
  // A Manager (head of department) over two departments needs no flag.
  const hod = await addUser("hod-a", "client_manager", A, { departmentId: leisure, extraDepartmentIds: [grounds] });
  await addUser("viewer-a", "client_viewer", A, { departmentId: kitchen, departmentManager: true });
  const leaver = await addUser("leaver-a", "client_staff", A, { departmentId: kitchen, departmentManager: true, active: false });
  const chefB = await addUser("chef-b", "client_staff", B, { departmentId: kitchenB, departmentManager: true });
  const staff = await addUser("staff-a", "client_staff", A);
  const viewer = await addUser("viewer2-a", "client_viewer", A);

  const asAdmin = await login(admin.email);
  const asStaff = await login(staff.email);
  const asViewer = await login(viewer.email);
  const asOwnerB = await login(ownerB.email);
  const preview = async (request = asAdmin, routing) => {
    const query = routing === undefined ? "" : `?routing=${encodeURIComponent(typeof routing === "string" ? routing : JSON.stringify(routing))}`;
    return request("GET", `/settings/track-summary-recipients${query}`);
  };
  const track = (body, module) => body.tracks.find((item) => item.module === module);
  const emails = (people) => people.map((person) => person.email).sort();

  // ── Automatic matches, department managers and senior fallback ─────────
  const automatic = await preview();
  assert.equal(automatic.status, 200, automatic.text);
  assert.equal(automatic.data.senior.source, "users");
  assert.deepEqual(emails(automatic.data.senior.recipients), [admin.email, ownerA.email].sort(),
    "senior management is the account's active Owners");
  {
    const kitchenTrack = track(automatic.data, "kitchen");
    assert.equal(kitchenTrack.enabled, true);
    assert.equal(kitchenTrack.mode, "automatic");
    assert.deepEqual(kitchenTrack.departments.map((item) => item.name), ["Kitchen"]);
    assert.deepEqual(emails(kitchenTrack.departments[0].managers), [chef.email],
      "only active, designated admin/staff managers count; not ordinary staff, viewers or leavers");
    assert.equal(kitchenTrack.seniorOnly, false);
    const chefRow = kitchenTrack.recipients.find((recipient) => recipient.email === chef.email);
    assert.deepEqual(chefRow.via, ["department"]);
    assert.equal(chefRow.name, chef.name);
    assert.equal(chefRow.departmentName, "Kitchen");
    assert.deepEqual(kitchenTrack.recipients.find((recipient) => recipient.email === admin.email).via, ["senior"]);
    assert.deepEqual(emails(kitchenTrack.recipients), [admin.email, ownerA.email, chef.email].sort());
    ok("an automatic track lists its matched department and designated manager beside senior management");

    const hotTub = track(automatic.data, "hot_tub");
    assert.deepEqual(hotTub.departments.map((item) => [item.name, emails(item.managers)]),
      [["Housekeeping", []], ["Maintenance", [fixer.email]], ["Leisure", [hod.email]]]);
    assert.deepEqual(emails(hotTub.recipients), [admin.email, ownerA.email, fixer.email, hod.email].sort());
    ok("a matched department with no eligible manager is reported, and maintenance managers count");

    const tree = track(automatic.data, "tree");
    assert.deepEqual(tree.departments.map((item) => [item.name, emails(item.managers)]),
      [["Maintenance", [fixer.email]], ["Grounds", [hod.email]]]);
    const hodRow = tree.recipients.find((recipient) => recipient.email === hod.email);
    assert.deepEqual(hodRow.via, ["department"]);
    assert.equal(hodRow.departmentName, "Leisure, Grounds");
    ok("a Manager receives the tracks of every department they manage, beyond their first");

    const train = track(automatic.data, "train");
    assert.equal(train.mode, "automatic");
    assert.deepEqual(train.departments, []);
    assert.equal(train.seniorOnly, true);
    assert.deepEqual(emails(train.recipients), [admin.email, ownerA.email].sort());
    ok("a track with no department match falls back to senior management only");

    const everyone = JSON.stringify(automatic.data);
    for (const outsider of [chefB.email, ownerB.email, "Summary viewer-a", leaver.email, cook.email]) {
      assert.ok(!everyone.includes(outsider), `${outsider} is never listed`);
    }
    ok("no other business's people, viewers, leavers or undesignated staff appear");
  }

  // ── Unsaved choices are previewed, client-scoped and not saved ─────────
  {
    const draft = { kitchen: { managerIds: [cook.userId, chefB.userId, leaver.userId], departmentIds: [kitchenB] } };
    const result = await preview(asAdmin, draft);
    assert.equal(result.status, 200, result.text);
    const kitchenTrack = track(result.data, "kitchen");
    assert.equal(kitchenTrack.mode, "custom");
    assert.deepEqual(emails(kitchenTrack.namedManagers), [cook.email], "a named manager need not be designated");
    assert.equal(kitchenTrack.unavailableNamedCount, 2, "another business's user and a leaver are skipped");
    assert.deepEqual(kitchenTrack.departments, [], "another business's department matches nothing");
    assert.deepEqual(kitchenTrack.recipients.find((recipient) => recipient.email === cook.email).via, ["named"]);
    assert.deepEqual(emails(kitchenTrack.recipients), [admin.email, ownerA.email, cook.email].sort());
    assert.ok(!JSON.stringify(result.data).includes(chefB.email));
    assert.equal(track(result.data, "pest").mode, "automatic", "other tracks stay automatic");
    const [saved] = await q(`SELECT value FROM app_settings WHERE client_id = $1 AND key = 'trackSummaryRouting'`, [A]);
    assert.equal(saved, undefined, "previewing saves nothing");
    ok("unsaved named assignments preview with ids from other accounts or leavers skipped");

    const emptyCustom = await preview(asAdmin, { kitchen: { managerIds: [], departmentIds: [] } });
    const custom = track(emptyCustom.data, "kitchen");
    assert.equal(custom.mode, "custom");
    assert.equal(custom.seniorOnly, true);
    assert.deepEqual(emails(custom.recipients), [admin.email, ownerA.email].sort());
    ok("a customised track with nobody chosen goes to senior management only");

    const both = await preview(asAdmin, { kitchen: { managerIds: [chef.userId], departmentIds: [kitchen] } });
    assert.deepEqual(track(both.data, "kitchen").recipients.find((recipient) => recipient.email === chef.email).via,
      ["named", "department"], "a manager both named and matched is listed once with both reasons");
    ok("a manager named and matched by department is one recipient");
  }

  // ── A Manager over every department ────────────────────────────────────
  {
    const everyDepartment = await addUser("all-depts-a", "client_manager", A, { allDepartments: true });
    const result = await preview();
    for (const module of ["kitchen", "hot_tub", "tree"]) {
      const row = track(result.data, module).recipients.find((recipient) => recipient.email === everyDepartment.email);
      assert.deepEqual(row?.via, ["department"], `${module} reaches a Manager over every department`);
      assert.equal(row.departmentName, "All departments");
    }
    assert.ok(!track(result.data, "train").recipients.some((recipient) => recipient.email === everyDepartment.email),
      "a track with no matched department still goes to senior management only");
    await q(`UPDATE users SET active = false WHERE id = $1`, [everyDepartment.userId]);
    ok("a Manager over every department receives every matched track");
  }

  // ── Who may see it ─────────────────────────────────────────────────────
  assert.equal((await preview(asStaff)).status, 403, "staff cannot read recipient emails");
  assert.equal((await preview(asViewer)).status, 403, "viewers cannot read recipient emails");
  const cross = await asOwnerB("GET", `/settings/track-summary-recipients?clientId=${A}`);
  assert.notEqual(cross.status, 200, "an unlinked consultant cannot preview another business");
  const own = await preview(asOwnerB);
  assert.equal(own.status, 200, own.text);
  assert.ok(!JSON.stringify(own.data).includes(admin.email), "a business sees only its own people");
  assert.deepEqual(emails(track(own.data, "kitchen").recipients.filter((recipient) => recipient.via.includes("department"))),
    [chefB.email]);
  ok("only admins and consultants of the business can preview it");
  for (const bad of ["not json", "[1,2]", "42"]) {
    assert.equal((await preview(asAdmin, bad)).status, 400, `rejects routing ${bad}`);
  }
  ok("malformed routing is rejected");

  // ── Notification email as senior management ────────────────────────────
  {
    const saved = await asAdmin("PUT", "/settings", { notificationEmail: "duty-manager@test.local" });
    assert.equal(saved.status, 200, saved.text);
    const result = await preview();
    assert.equal(result.data.senior.source, "notification_email");
    assert.deepEqual(result.data.senior.recipients, [
      { userId: null, name: null, email: "duty-manager@test.local", departmentName: null },
    ]);
    assert.deepEqual(emails(track(result.data, "train").recipients), ["duty-manager@test.local"]);
    ok("a notification email replaces the admins as senior management");
  }

  // ── The preview names exactly who the daily job emails ─────────────────
  {
    const routing = { kitchen: { managerIds: [cook.userId], departmentIds: [kitchen] }, fire: { managerIds: [], departmentIds: [] } };
    const saved = await asAdmin("PUT", "/settings", { trackSummaryRouting: JSON.stringify(routing) });
    assert.equal(saved.status, 200, saved.text);
    const result = await preview();
    const expected = new Map();
    for (const item of result.data.tracks.filter((entry) => entry.enabled)) {
      for (const recipient of item.recipients) {
        expected.set(recipient.email.toLowerCase(), (expected.get(recipient.email.toLowerCase()) ?? 0) + 1);
      }
    }
    // Earlier businesses in this disposable database must not be emailed
    // for real; the job sees only the two fixture businesses.
    const sent = [];
    const outcome = await runTrackActionReminderJob({
      send: async (message) => { sent.push(message); },
      sendPush: async () => {},
    });
    assert.equal(outcome.errors, 0);
    const sentToA = sent.filter((message) => message.clientId === A);
    const actual = new Map(sentToA.map((message) => [
      message.to.toLowerCase(),
      Number(/Daily track summary: (\d+) track/.exec(message.subject)?.[1]),
    ]));
    assert.deepEqual([...actual.keys()].sort(), [...expected.keys()].sort(),
      "the job emails exactly the previewed addresses");
    for (const [email, count] of expected) {
      assert.equal(actual.get(email), count, `${email} gets the previewed number of tracks`);
    }
    assert.ok(actual.has(cook.email.toLowerCase()) && actual.has(chef.email.toLowerCase()));
    ok("preview and the daily job agree on every recipient and their tracks");
  }

  console.log(`Track summary recipients: ${passed} checks passed.`);
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end().catch(() => {});
  await rm(outDir, { recursive: true, force: true });
}
