// Compliance reminder cycles: an obsolete pending draft is never sent.
//
// Runs the real API against a disposable database with a synthetic key and
// captured mail (NODE_ENV=test outbox; no provider is ever called). Covers:
//   - editing the due date, changing the contractor, completing or deleting
//     a check, or a certificate moving the due date supersedes only *pending*
//     reminder drafts of the old cycle; sending/sent/cancelled drafts stay;
//   - approval and edit-and-send recheck the current due date and state under
//     lock, withdraw a stale draft (409) and deliver nothing;
//   - concurrent edits racing the scheduler and racing approval never leave a
//     stale pending draft or a delivered reminder masking the new cycle;
//   - links: a delivered link stays valid across the edit and a newly queued
//     cycle, a superseded draft's link never becomes valid, and delivering
//     the new cycle replaces the old link;
//   - manager approval and tenant boundaries are unchanged;
//   - drafts from the previous release get their cycle on restart.
//
// Run only through tests/run-compliance-reminder-cycles.sh.
import crypto from "node:crypto";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { build } from "esbuild";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(testsDir, "..");
const dbName = new URL(process.env.DATABASE_URL ?? "postgres://x/none").pathname.slice(1);
if (!dbName.startsWith("ct_remcycle_")) throw new Error(`Refusing to run against database "${dbName}": use run-compliance-reminder-cycles.sh`);
const OUTBOX = process.env.FIXTRACK_TEST_EMAIL_OUTBOX;
if (!OUTBOX) throw new Error("FIXTRACK_TEST_EMAIL_OUTBOX is required");
const PORT = process.env.TEST_PORT;
const BASE = `http://127.0.0.1:${PORT}/api`;

let passed = 0;
const failures = [];
function check(name, condition, detail = "") {
  if (condition) passed++;
  else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.error(`FAIL: ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function bundle() {
  const outDir = await mkdtemp(path.join(testsDir, ".build-"));
  const outFile = path.join(outDir, "entry.mjs");
  await build({
    entryPoints: [path.join(testsDir, "compliance-reminder-cycles.entry.ts")],
    bundle: true, platform: "node", format: "esm", outfile: outFile, logLevel: "silent",
    external: ["pg-native", "pino", "pino-pretty", "resend", "@google-cloud/*", "nodemailer"],
    banner: { js: "import { createRequire as __r } from 'node:module';\nglobalThis.require = __r(import.meta.url);" },
  });
  return { outDir, lib: await import(new URL(`file://${outFile}`).href) };
}

let server = null;
async function startServer() {
  server = spawn("node", ["--enable-source-maps", "dist/index.mjs"], {
    cwd: serverDir, env: { ...process.env, NODE_ENV: "test", PORT }, stdio: ["ignore", "ignore", "inherit"],
  });
  const exited = new Promise((_, reject) => server.once("exit", (code) => reject(new Error(`API exited (${code}) during startup`))));
  const ready = (async () => {
    for (;;) {
      const status = await fetch(`http://127.0.0.1:${PORT}/readyz`).then((r) => r.json()).then((b) => b.status, () => null);
      if (status === "ok" || status === "degraded") return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  })();
  await Promise.race([ready, exited]);
}
async function stopServer() {
  if (!server) return;
  const done = new Promise((resolve) => server.once("exit", resolve));
  server.kill("SIGTERM");
  await done;
  server = null;
}

function session() {
  let cookie = "";
  return async (method, route, body) => {
    const response = await fetch(`${BASE}${route}`, {
      method,
      headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    return { status: response.status, data: await response.json().catch(() => null) };
  };
}
const publicApi = session();

async function tenant(label) {
  const request = session();
  const email = `reminder-${label}-${Date.now()}-${Math.random()}@test.local`;
  const registered = await request("POST", "/auth/register", { name: `${label} manager`, email, password: "password-123" });
  if (!registered.data?.verificationToken) throw new Error(`${label}: registration returned no verification token (${registered.status})`);
  await request("GET", `/auth/verify-email?token=${encodeURIComponent(registered.data.verificationToken)}`);
  const login = await request("POST", "/auth/login", { email, password: "password-123" });
  if (login.status !== 200) throw new Error(`${label}: login failed (${login.status})`);
  return request;
}
async function userSession(owner, label, role, clientId) {
  const email = `reminder-${label}-${Date.now()}-${Math.random()}@test.local`;
  const created = await owner("POST", "/users", { name: `${label} user`, email, password: "password-123", role, clientId });
  if (created.status !== 201) throw new Error(`${label}: create user failed (${created.status})`);
  const request = session();
  await request("POST", "/auth/login", { email, password: "password-123" });
  return request;
}

const inDays = (days) => new Date(Date.now() + days * 86_400_000).toISOString();
const cycleOf = (iso) => new Date(iso).toISOString().slice(0, 10);
const outbox = async () => (await readFile(OUTBOX, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
const scheduleLink = (html) => String(html ?? "").match(/\/schedule\/([0-9a-f-]{36})/)?.[1] ?? null;

async function main() {
  await writeFile(OUTBOX, "");
  const { outDir, lib } = await bundle();
  const { db, sql, pool, decryptTokenPayload } = lib;
  const rows = async (query) => (await db.execute(query)).rows;
  try {
    await startServer();
    const owner = await tenant("owner");
    const foreign = await tenant("foreign");
    const me = await owner("GET", "/auth/me");
    const clientId = me.data?.user?.clientId ?? me.data?.client?.id;
    const staff = await userSession(owner, "staff", "client_staff", clientId);

    let fixture = 0;
    const contractor = async () => (await owner("POST", "/contractors", {
      name: `Engineer ${++fixture}`, email: `engineer-${fixture}-${Date.now()}@contractor.test`,
    })).data.id;
    const item = async (dueInDays = 10) => {
      const created = await owner("POST", "/compliance-items", {
        title: `Gas safety ${++fixture}`, contractorId: await contractor(), dueDate: inDays(dueInDays), leadTimeDays: 30,
      });
      if (created.status !== 201) throw new Error(`create item failed (${created.status})`);
      return created.data.id;
    };
    const drafts = async (itemId) => rows(sql`SELECT id, status, reminder_cycle, superseded_reason, superseded_at, encrypted_token_payload
      FROM contractor_email_queue WHERE entity_type='compliance' AND entity_id=${itemId} AND idempotency_key LIKE 'reminder-%' ORDER BY id`);
    const itemState = async (itemId) => (await rows(sql`SELECT to_char(due_date, 'YYYY-MM-DD') AS cycle, notification_sent_at, schedule_token_hash
      FROM compliance_items WHERE id=${itemId}`))[0];
    const queue = async (itemId) => {
      const r = await owner("POST", `/notifications/send-reminder/${itemId}`);
      return r.data?.queued === true;
    };
    const approve = (request, id) => request("POST", `/fix-track/contractor-email-queue/${id}/approve-and-send`);
    const pendingOf = async (itemId) => (await drafts(itemId)).filter((d) => d.status === "pending");

    // ── Due-date edit supersedes the pending draft of the old cycle ─────────
    const a = await item(10);
    check("edit: reminder queued", await queue(a));
    const [oldDraft] = await pendingOf(a);
    check("edit: draft records its cycle", oldDraft?.reminder_cycle === (await itemState(a)).cycle);
    const moved = await owner("PUT", `/compliance-items/${a}`, { dueDate: inDays(20) });
    check("edit: due date changed", moved.status === 200, String(moved.status));
    let [after] = (await drafts(a)).filter((d) => d.id === oldDraft.id);
    check("edit: pending draft superseded with a reason",
      after.status === "superseded" && after.superseded_reason === "Due date changed" && after.superseded_at !== null, JSON.stringify(after));
    const stale = await approve(owner, oldDraft.id);
    check("edit: the superseded draft cannot be approved", stale.status === 409);
    check("edit: nothing delivered", (await outbox()).length === 0);
    const inbox = await owner("GET", "/fix-track/contractor-email-queue");
    check("edit: superseded draft leaves the approval inbox", !inbox.data?.some?.((d) => d.id === oldDraft.id));
    check("edit: a new cycle can be drafted", await queue(a));
    const [newDraft] = await pendingOf(a);
    check("edit: new draft is on the current cycle", newDraft?.reminder_cycle === (await itemState(a)).cycle && newDraft.reminder_cycle === cycleOf(inDays(20)));
    check("approval: staff cannot approve", (await approve(staff, newDraft.id)).status === 403);
    check("approval: another tenant cannot approve", [404, 409].includes((await approve(foreign, newDraft.id)).status));
    check("approval: another tenant cannot edit the check", (await foreign("PUT", `/compliance-items/${a}`, { dueDate: inDays(25) })).status === 404);
    check("approval: current draft is sent by its manager", (await approve(owner, newDraft.id)).status === 200 && (await outbox()).length === 1);
    check("approval: the cycle is marked notified", (await itemState(a)).notification_sent_at !== null);
    // A further date change re-opens reminders for the new cycle.
    await owner("PUT", `/compliance-items/${a}`, { dueDate: inDays(22) });
    check("edit: a delivered cycle no longer suppresses the new one", (await itemState(a)).notification_sent_at === null);
    check("edit: sent drafts are never superseded", (await drafts(a)).find((d) => d.id === newDraft.id)?.status === "sent");

    // ── Approval rechecks state the edit path did not (any other writer) ────
    const b = await item(10);
    await queue(b);
    const [bDraft] = await pendingOf(b);
    await db.execute(sql`UPDATE compliance_items SET due_date = due_date + interval '7 days' WHERE id=${b}`);
    const recheck = await approve(owner, bDraft.id);
    check("recheck: approval of a stale draft is refused", recheck.status === 409 && recheck.data?.code === "reminder_superseded", JSON.stringify(recheck.data));
    check("recheck: and it is withdrawn, not left pending",
      (await drafts(b)).find((d) => d.id === bDraft.id)?.status === "superseded");
    await queue(b);
    const [bDraft2] = await pendingOf(b);
    await db.execute(sql`UPDATE compliance_items SET contractor_id=${await contractor()} WHERE id=${b}`);
    const edited = await owner("POST", `/fix-track/contractor-email-queue/${bDraft2.id}/edit-and-send`, { subject: "Reminder", bodyText: "Please book." });
    check("recheck: edit-and-send of a stale draft is refused", edited.status === 409 && edited.data?.code === "reminder_superseded");
    check("recheck: contractor change recorded", (await drafts(b)).find((d) => d.id === bDraft2.id)?.superseded_reason === "Contractor changed");
    check("recheck: still nothing extra delivered", (await outbox()).length === 1);

    // ── Complete, delete, cancel, and sending drafts ────────────────────────
    const c = await item(10);
    await queue(c);
    await owner("PATCH", `/compliance-items/${c}/status`, { status: "completed" });
    check("complete: pending reminder superseded", (await drafts(c))[0]?.superseded_reason === "Compliance check completed");
    check("complete: no reminder for a completed check", !(await queue(c)));
    const d = await item(10);
    await queue(d);
    const [dDraft] = await pendingOf(d);
    check("delete: check deleted", (await owner("DELETE", `/compliance-items/${d}`)).status === 204);
    check("delete: pending reminder superseded",
      (await rows(sql`SELECT superseded_reason FROM contractor_email_queue WHERE id=${dDraft.id}`))[0]?.superseded_reason === "Compliance check deleted");
    const e = await item(10);
    await queue(e);
    const [eDraft] = await pendingOf(e);
    await owner("POST", `/fix-track/contractor-email-queue/${eDraft.id}/cancel`);
    await owner("PUT", `/compliance-items/${e}`, { dueDate: inDays(15) });
    check("cancel: a cancelled draft stays cancelled", (await drafts(e))[0]?.status === "cancelled");
    const f = await item(10);
    await queue(f);
    const [fDraft] = await pendingOf(f);
    await db.execute(sql`UPDATE contractor_email_queue SET status='sending' WHERE id=${fDraft.id}`);
    await owner("PUT", `/compliance-items/${f}`, { dueDate: inDays(15) });
    check("sending: a draft being sent is never superseded", (await drafts(f))[0]?.status === "sending");
    check("sending: and a new cycle waits for it to settle", !(await queue(f)));

    // ── Certificate upload moves the due date ───────────────────────────────
    const g = await item(10);
    await queue(g);
    const cert = await owner("POST", `/items/${g}/certificates`, { name: "Gas certificate", expiryDate: inDays(365) });
    check("certificate: uploaded", cert.status === 201, String(cert.status));
    check("certificate: moved due date supersedes the pending reminder", (await drafts(g))[0]?.superseded_reason === "Due date changed");

    // ── Links follow the current cycle ───────────────────────────────────────
    // main issues a cycle's link when the reminder is queued; a superseded
    // draft is never sent, and the next cycle's link replaces its link.
    const h = await item(10);
    await queue(h);
    await approve(owner, (await pendingOf(h))[0].id);
    const delivered = scheduleLink((await outbox()).at(-1).html);
    check("links: delivered link works", (await publicApi("GET", `/notifications/public/schedule/${delivered}`)).status === 200);
    await owner("PUT", `/compliance-items/${h}`, { dueDate: inDays(18) });
    check("links: …still works after the due date changes", (await publicApi("GET", `/notifications/public/schedule/${delivered}`)).status === 200);
    await queue(h);
    const [hPending] = await pendingOf(h);
    const pendingLink = decryptTokenPayload(hPending.encrypted_token_payload).booked;
    await owner("PUT", `/compliance-items/${h}`, { dueDate: inDays(19) });
    check("links: the superseded draft is never delivered", (await drafts(h)).find((d) => d.id === hPending.id)?.status === "superseded"
      && !(await outbox()).some((mail) => mail.html.includes(pendingLink)));
    await queue(h);
    await approve(owner, (await pendingOf(h))[0].id);
    const replacement = scheduleLink((await outbox()).at(-1).html);
    check("links: the current cycle's link works and replaces the superseded one",
      (await publicApi("GET", `/notifications/public/schedule/${replacement}`)).status === 200
        && (await publicApi("GET", `/notifications/public/schedule/${pendingLink}`)).status === 404);

    // ── Edit racing the scheduler ───────────────────────────────────────────
    const raceItems = await Promise.all(Array.from({ length: 6 }, () => item(10)));
    for (let round = 0; round < 4; round++) {
      await Promise.all(raceItems.flatMap((id) => [
        owner("PUT", `/compliance-items/${id}`, { dueDate: inDays(11 + round) }),
        owner("POST", "/notifications/send-reminders"),
      ]));
    }
    await owner("POST", "/notifications/send-reminders");
    let staleLeft = 0, multiple = 0;
    for (const id of raceItems) {
      const pending = await pendingOf(id);
      const { cycle } = await itemState(id);
      if (pending.length > 1) multiple++;
      if (pending.some((p) => p.reminder_cycle !== cycle)) staleLeft++;
    }
    check("scheduler race: never more than one pending draft per check", multiple === 0);
    check("scheduler race: no pending draft for an obsolete date", staleLeft === 0, String(staleLeft));
    check("scheduler race: every check ends with a current-cycle draft",
      (await Promise.all(raceItems.map(pendingOf))).every((p) => p.length === 1));

    // ── Edit racing approval ────────────────────────────────────────────────
    let sentBeforeEdit = 0, withdrawn = 0, masked = 0, inconsistent = 0;
    for (let round = 0; round < 8; round++) {
      const id = await item(10);
      await queue(id);
      const [draft] = await pendingOf(id);
      const mailBefore = (await outbox()).length;
      const [edit, approval] = await Promise.all([
        owner("PUT", `/compliance-items/${id}`, { dueDate: inDays(30) }),
        approve(owner, draft.id),
      ]);
      const mailAfter = (await outbox()).length;
      const finalDraft = (await drafts(id)).find((row) => row.id === draft.id);
      if (edit.status !== 200) inconsistent++;
      if (approval.status === 200) {
        sentBeforeEdit++;
        if (finalDraft.status !== "sent" || mailAfter !== mailBefore + 1) inconsistent++;
      } else {
        withdrawn++;
        if (approval.status !== 409 || finalDraft.status !== "superseded" || mailAfter !== mailBefore) inconsistent++;
      }
      // Either way the new date still needs its own reminder.
      if ((await itemState(id)).notification_sent_at !== null) masked++;
    }
    check("approval race: each outcome is consistent (sent once, or withdrawn and not sent)", inconsistent === 0, `${sentBeforeEdit} sent, ${withdrawn} withdrawn`);
    check("approval race: a reminder for the old date never masks the new date", masked === 0, String(masked));

    // ── Drafts queued by the previous release ───────────────────────────────
    const legacy = await item(10);
    await queue(legacy);
    const [legacyDraft] = await pendingOf(legacy);
    await stopServer();
    await db.execute(sql`UPDATE contractor_email_queue SET reminder_cycle=NULL WHERE id=${legacyDraft.id}`);
    await startServer();
    check("migration: legacy draft gets its cycle from its idempotency key",
      (await drafts(legacy))[0]?.reminder_cycle === (await itemState(legacy)).cycle);
    await owner("PUT", `/compliance-items/${legacy}`, { dueDate: inDays(40) });
    check("migration: and is superseded like any other", (await drafts(legacy))[0]?.status === "superseded");
    const [constraint] = await rows(sql`SELECT convalidated FROM pg_constraint WHERE conname='contractor_email_queue_status_check'`);
    check("migration: status constraint validated", constraint?.convalidated === true);
  } finally {
    await stopServer().catch(() => {});
    await pool.end().catch(() => {});
    await rm(outDir, { recursive: true, force: true });
  }
  console.log(`${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exit(1);
}

main().catch(async (err) => {
  console.error(err);
  await stopServer().catch(() => {});
  process.exit(1);
});
