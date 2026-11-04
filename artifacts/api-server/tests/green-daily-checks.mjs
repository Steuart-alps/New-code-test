// GreenTrack daily checks: the greenkeeping shed opening and closing
// checklists (saved, submitted, failed items to actions), the team that does
// them at each site (matched by "green" in a department's name, or chosen),
// every machine's pre-start check or "not in use" mark, and how they are
// counted on their own: the dashboard's GreenTrack card, "Today by
// department", and the 11:00 / 21:00 reminders to the team's Managers. Also
// that a shed checklist never counts as a site's DailyTrack AM / PM, and
// tenant isolation.
//
// Runs the real app in-process against the fresh-schema harness's disposable
// database and calls the reminder job with an injected clock. Run:
//   pnpm --filter @workspace/api-server run test:green-daily-checks
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

process.env.SESSION_SECRET = "green-daily-checks-test-secret-not-a-real-secret";
delete process.env.ENFORCE_CSRF;

const dir = path.dirname(fileURLToPath(import.meta.url));
const outDir = await mkdtemp(path.join(dir, ".build-green-daily-checks-"));
let server;
let pool;
let passed = 0;
const ok = (message) => { passed++; console.log(`ok - ${message}`); };

try {
  const outfile = path.join(outDir, "entry.mjs");
  await build({
    entryPoints: [path.join(dir, "green-daily-checks.entry.ts")],
    bundle: true, platform: "node", format: "esm", outfile, logLevel: "silent",
    external: ["sharp", "*.node", "pg-native", "pino", "pino-pretty", "@google-cloud/*", "@sentry/*", "nodemailer"],
    banner: { js: "import { createRequire as __testRequire } from 'node:module'; globalThis.require = __testRequire(import.meta.url);" },
  });
  const entry = await import(pathToFileURL(outfile).href);
  pool = entry.pool;
  const { app, runTrackReminderJob, hashPassword } = entry;

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
  const expect = (result, statuses, label) => {
    assert.ok(statuses.includes(result.status), `${label}: ${result.status} ${result.text}`);
    return result.data;
  };

  const password = "green-daily-fixture-password-123";
  const stamp = Date.now();
  async function register(label) {
    const request = session();
    const email = `green-daily-${label}-${stamp}@test.local`;
    const registered = await request("POST", "/auth/register", { name: `Green ${label}`, email, password });
    assert.equal(registered.status, 200, registered.text);
    assert.equal((await request("GET", `/auth/verify-email?token=${encodeURIComponent(registered.data.verificationToken)}`)).status, 200);
    const [row] = await q(`SELECT client_id FROM users WHERE id = $1`, [registered.data.user.id]);
    return { email, userId: registered.data.user.id, clientId: row.client_id };
  }
  async function login(email) {
    const request = session();
    expect(await request("POST", "/auth/login", { email, password }), [200], `login ${email}`);
    return request;
  }
  const passwordHash = await hashPassword(password);
  async function colleague(label, role, clientId, departmentId) {
    const email = `green-daily-${label}-${stamp}@test.local`;
    const [row] = await q(
      `INSERT INTO users (email, password_hash, name, role, client_id, department_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [email, passwordHash, `Green ${label}`, role, clientId, departmentId],
    );
    return { email, userId: row.id };
  }

  // ── Fixtures: a golf club and a hotel in business A; business B ─────────────
  const ownerA = await register("owner-a");
  const A = ownerA.clientId;
  const ownerB = await register("owner-b");
  const asOwner = await login(ownerA.email);
  const asOther = await login(ownerB.email);
  const golf = expect(await asOwner("POST", "/sites", { name: "Golf Club", seedStarterChecks: false }), [200, 201], "golf site").id;
  const hotel = expect(await asOwner("POST", "/sites", { name: "Hotel", seedStarterChecks: false }), [200, 201], "hotel site").id;
  const greenkeeping = expect(await asOwner("POST", "/departments", { name: "Greenkeeping", siteId: golf }), [200, 201], "dept");
  const kitchen = expect(await asOwner("POST", "/departments", { name: "Kitchen", siteId: hotel }), [200, 201], "dept");
  const headGreenkeeper = await colleague("head-greenkeeper", "client_manager", A, greenkeeping.id);
  const greenkeeper = await colleague("greenkeeper", "client_staff", A, greenkeeping.id);
  const asGreenkeeper = await login(greenkeeper.email);
  const asHead = await login(headGreenkeeper.email);

  // ── The team ───────────────────────────────────────────────────────────────
  let team = expect(await asOwner("GET", `/green-track/shed-team?siteId=${golf}`), [200], "golf team");
  assert.equal(team.departmentId, greenkeeping.id, JSON.stringify(team));
  assert.equal(team.chosen, false, "matched by name");
  team = expect(await asOwner("GET", `/green-track/shed-team?siteId=${hotel}`), [200], "hotel team");
  assert.equal(team.departmentId, null, "the hotel has no greenkeeping team");
  assert.deepEqual(team.departments.map((d) => d.name), ["Kitchen"]);
  expect(await asOwner("PUT", "/green-track/shed-team", { siteId: golf, departmentId: kitchen.id }), [400], "a department at another site");
  expect(await asGreenkeeper("PUT", "/green-track/shed-team", { siteId: golf, departmentId: greenkeeping.id }), [403], "staff cannot choose");
  team = expect(await asOwner("PUT", "/green-track/shed-team", { siteId: golf, departmentId: greenkeeping.id }), [200], "choose");
  assert.equal(team.chosen, true);
  ok("a site's shed checks go to its greenkeeping department, matched by name or chosen by the Owner");

  // ── Machines and pre-start checks ──────────────────────────────────────────
  const machine = async (name, type, siteId) => expect(await asOwner("POST", "/green-track/machines", { name, type, siteId }), [201], name).id;
  const mower = await machine("Greens mower", "ride_on_cylinder", golf);
  const tractor = await machine("Compact tractor", "tractor", golf);
  const strimmer = await machine("Hotel strimmer", "edger_strimmer", hotel);
  let day = expect(await asGreenkeeper("GET", `/green-track/pre-start?siteId=${golf}`), [200], "pre-start");
  const today = day.date;
  assert.match(today, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(day.machines.map((m) => m.name).sort(), ["Compact tractor", "Greens mower"], "only the golf club's machines");
  assert.equal(day.todo, 2);
  expect(await asGreenkeeper("POST", "/green-track/pre-use-checks", { machineId: mower, checkDate: today, fluidLevelsOk: true }), [201], "mower check");
  const mark = expect(await asGreenkeeper("POST", "/green-track/pre-start/not-in-use", { machineId: tractor, checkDate: today, reason: "Away for repair" }), [201], "tractor N/A");
  expect(await asGreenkeeper("POST", "/green-track/pre-start/not-in-use", { machineId: tractor, checkDate: today }), [200], "repeat N/A keeps the first");
  expect(await asGreenkeeper("POST", "/green-track/pre-start/not-in-use", { machineId: mower, checkDate: today }), [409], "a checked machine is not N/A");
  day = expect(await asGreenkeeper("GET", `/green-track/pre-start?siteId=${golf}`), [200], "pre-start");
  assert.deepEqual(Object.fromEntries(day.machines.map((m) => [m.name, m.status])), { "Greens mower": "checked", "Compact tractor": "not_in_use" });
  assert.equal(day.todo, 0);
  assert.equal(day.machines.find((m) => m.machineId === tractor).notInUseReason, "Away for repair");
  expect(await asGreenkeeper("DELETE", `/green-track/pre-start/not-in-use/${mark.id}`), [204], "undo N/A");
  day = expect(await asGreenkeeper("GET", `/green-track/pre-start?siteId=${golf}`), [200], "pre-start");
  assert.equal(day.todo, 1, "the tractor is to do again");
  expect(await asGreenkeeper("POST", "/green-track/pre-start/not-in-use", { machineId: tractor, checkDate: today }), [201], "tractor N/A again");
  const tomorrow = new Date(`${today}T12:00:00Z`); tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  expect(await asGreenkeeper("POST", "/green-track/pre-start/not-in-use", { machineId: tractor, checkDate: tomorrow.toISOString().slice(0, 10) }), [400, 409, 422], "no future N/A");
  ok("every machine is checked or marked not in use; a mark can be undone, never for a checked machine or a future day");

  // ── Shed checklists ────────────────────────────────────────────────────────
  const items = (results) => results.map((result, i) => ({
    label: `Item ${i + 1}`, checked: result !== "fail", result, ...(result === "fail" ? { notes: "Extinguisher missing" } : {}),
  }));
  const draft = expect(await asGreenkeeper("POST", "/green-track/shed-checks", {
    siteId: golf, checklistType: "greenkeeping_opening", checkDate: today, items: [{ label: "Alarm off", checked: false }],
  }), [201], "draft");
  expect(await asGreenkeeper("PUT", `/green-track/shed-checks/${draft.id}`, { submittedAt: new Date().toISOString() }), [400], "unanswered items");
  const opening = expect(await asGreenkeeper("PUT", `/green-track/shed-checks/${draft.id}`, {
    items: items(["pass", "pass", "na"]), completedBy: "Sam", submittedAt: new Date().toISOString(),
  }), [200], "submit opening");
  assert.ok(opening.submittedAt);
  expect(await asGreenkeeper("PUT", `/green-track/shed-checks/${draft.id}`, { items: items(["pass"]) }), [409], "submitted is final");
  expect(await asGreenkeeper("POST", "/green-track/shed-checks", {
    siteId: golf, checklistType: "kitchen_opening", checkDate: today,
  }), [400], "only shed checklists here");
  const listed = expect(await asGreenkeeper("GET", `/green-track/shed-checks?siteId=${golf}&date=${today}`), [200], "list");
  assert.deepEqual(listed.map((c) => c.checklistType), ["greenkeeping_opening"]);
  const am = expect(await asOwner("GET", `/daily-track-am?siteId=${golf}&date=${today}`), [200], "AM list");
  assert.equal(am.length, 0, "the shed checklist is not a DailyTrack AM checklist");
  ok("shed checklists save, refuse an incomplete submit and stay separate from DailyTrack");

  // ── Dashboard: counted on their own ────────────────────────────────────────
  let summary = expect(await asOwner("GET", "/dashboard/summary"), [200], "summary");
  const outstandingGolf = summary.checklistTotals.outstanding.find((site) => site.siteId === golf);
  assert.equal(outstandingGolf?.am, true, "a shed checklist does not complete the site's AM checklist");
  let card = summary.tracks.find((t) => t.trackId === "green");
  assert.equal(card.status, "attention", JSON.stringify(card));
  assert.match(card.badge, /1 shed checklist to do/);
  assert.match(card.badge, /1 machine not checked today/, "the hotel strimmer");
  const closingItem = card.items.find((i) => /shed closing checks not done/i.test(i.detail));
  assert.equal(closingItem?.label, "Golf Club");
  assert.equal(closingItem?.path, `/green-track?tab=daily&siteId=${golf}`, "one click opens the site's daily checks");
  assert.ok(!card.items.some((i) => /shed opening/i.test(i.detail)), "the submitted opening checklist is done");
  assert.ok(!card.items.some((i) => i.label === "Hotel" && /shed/i.test(i.detail)), "no shed checks expected at the hotel");
  assert.ok(card.items.some((i) => i.label === "Hotel strimmer" && i.path === `/green-track?tab=daily&siteId=${hotel}`));
  ok("the GreenTrack card lists outstanding shed checklists and machines, linking to the site's daily checks");

  // ── Today by department ────────────────────────────────────────────────────
  const todayCard = expect(await asOwner("GET", "/dashboard/today-by-department"), [200], "today by department");
  const golfGroup = todayCard.groups.find((g) => g.siteId === golf);
  const greenRow = golfGroup.rows.find((r) => r.name === "Greenkeeping");
  assert.deepEqual({ done: greenRow.done, todo: greenRow.todo, failed: greenRow.failed }, { done: 2, todo: 1, failed: 0 },
    `opening done, machines done, closing to do: ${JSON.stringify(greenRow)}`);
  assert.equal(greenRow.items[0].label, "Greenkeeping shed closing checks");
  assert.equal(greenRow.items[0].path, `/green-track?tab=daily&siteId=${golf}`);
  const hotelGroup = todayCard.groups.find((g) => g.siteId === hotel);
  assert.ok(!hotelGroup.rows.some((r) => r.items.some((i) => /Greenkeeping|pre-start/.test(i.label))), "nothing at the hotel");
  const headView = expect(await asHead("GET", "/dashboard/today-by-department"), [200], "manager view");
  assert.ok(headView.groups.find((g) => g.siteId === golf)?.rows.some((r) => r.name === "Greenkeeping" && r.todo === 1));
  ok("Today by department lists the shed checks and pre-start checks under the Greenkeeping team");

  // ── Due times: the site's Managers set them, other sites' Managers cannot ───
  const dueTimes = (as, siteId, body) => as("PUT", `/sites/${siteId}/checklist-due-times`, body);
  const setDue = expect(await dueTimes(asHead, golf, { openingChecksDue: "5:30", closingChecksDue: "17:00", closingReminderAt: "20:00" }), [200], "manager sets golf times");
  assert.deepEqual([setDue.openingChecksDue, setDue.closingChecksDue, setDue.closingReminderAt], ["05:30", "17:00", "20:00"]);
  expect(await dueTimes(asHead, hotel, { closingChecksDue: "20:00" }), [403], "a site the Manager's department cannot see");
  expect(await dueTimes(asGreenkeeper, golf, { closingChecksDue: "20:00" }), [403], "staff");
  expect(await dueTimes(asOther, golf, { closingChecksDue: "20:00" }), [403], "other business");
  expect(await dueTimes(asOwner, golf, { openingChecksDue: null }), [200], "owner puts opening back to the default");
  ok("the greenkeeping Manager sets the golf club's due times; Staff and other sites are refused");

  // ── Reminders: at the site's reminder times, to the team's Managers ────────
  const runJob = (iso) => runTrackReminderJob({ now: new Date(iso), clientIds: [A, ownerB.clientId], sendPush: async () => 0, skipPurge: true });
  const shedNotes = () => q(`SELECT user_id, kind, site_id, link_path, title, body FROM user_notifications
    WHERE client_id = ANY($1) AND kind LIKE 'green_greenkeeping%' ORDER BY id`, [[A, ownerB.clientId]]);
  // 11:30Z is 11:30 (GMT) or 12:30 (BST) in London: the AM window.
  assert.equal((await runJob(`${today}T11:30:00Z`)).errors, 0);
  assert.deepEqual(await shedNotes(), [], "the opening checklist is done: no AM reminder");
  // 21:15Z is 21:15 (GMT) or 22:15 (BST): the PM window.
  assert.equal((await runJob(`${today}T21:15:00Z`)).errors, 0);
  const notes = await shedNotes();
  assert.equal(notes.length, 1, JSON.stringify(notes));
  assert.deepEqual(
    { user: notes[0].user_id, kind: notes[0].kind, site: notes[0].site_id, link: notes[0].link_path },
    { user: headGreenkeeper.userId, kind: "green_greenkeeping_closing", site: golf, link: `/green-track?tab=daily&siteId=${golf}` },
  );
  assert.match(notes[0].title, /Greenkeeping shed closing checks not done — Golf Club/);
  assert.match(notes[0].body, /\(due by 17:00\)/);
  ok("the closing checklist is chased after its 20:00 reminder time to the Greenkeeping Manager only");

  // ── A failed item becomes a GreenTrack action ──────────────────────────────
  const closing = expect(await asGreenkeeper("POST", "/green-track/shed-checks", {
    siteId: golf, checklistType: "greenkeeping_closing", checkDate: today, items: items(["pass", "fail"]), submittedAt: new Date().toISOString(),
  }), [201], "submit closing with a failed item");
  const actions = await q(`SELECT module, title FROM track_actions WHERE client_id = $1 AND source_record_id = $2 AND source_kind LIKE 'daily_checklist_item:%'`, [A, closing.id]);
  assert.deepEqual(actions, [{ module: "green", title: "Failed check: Item 2" }]);
  summary = expect(await asOwner("GET", "/dashboard/summary"), [200], "summary");
  card = summary.tracks.find((t) => t.trackId === "green");
  assert.ok(card.items.some((i) => /closing checks submitted with a failed item/i.test(i.detail)), JSON.stringify(card.items));
  ok("a failed shed item opens a GreenTrack action and shows on the dashboard");

  // ── Tenant isolation ───────────────────────────────────────────────────────
  expect(await asOther("GET", `/green-track/shed-checks/${closing.id}`), [404], "other business cannot read");
  expect(await asOther("PUT", `/green-track/shed-checks/${draft.id}`, { items: items(["pass"]) }), [404], "other business cannot edit");
  expect(await asOther("POST", "/green-track/pre-start/not-in-use", { machineId: strimmer, checkDate: today }), [404], "other business's machine");
  expect(await asOther("GET", `/green-track/shed-team?siteId=${golf}`), [404], "other business's site");
  expect(await asOther("POST", "/green-track/shed-checks", { siteId: golf, checklistType: "greenkeeping_opening", checkDate: today }), [403], "other business's site");
  const otherDay = expect(await asOther("GET", "/green-track/pre-start"), [200], "other pre-start");
  assert.equal(otherDay.total, 0);
  ok("another business sees and changes none of it");

  console.log(`green daily checks: ${passed} passed`);
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end().catch(() => {});
  await rm(outDir, { recursive: true, force: true });
}
