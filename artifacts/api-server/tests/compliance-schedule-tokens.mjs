// Compliance visit-scheduling links are stored as digests.
//
// Runs the real API against a disposable database with synthetic keys and
// captured mail (NODE_ENV=test outbox; no provider is ever called). Covers:
//   - new issuance: the item stores only a SHA-256 digest; the queued draft
//     holds a placeholder plus an encrypted credential, and the contractor
//     only receives the link once a manager approves the draft;
//   - the delivered link works, a re-issued reminder invalidates it, and the
//     digest presented as a bearer token is rejected;
//   - concurrent bookings: exactly one wins, one confirmation is queued (for
//     approval) and the link is consumed;
//   - tenant ownership: another tenant cannot approve or see the draft, and
//     no API response or export carries the token or digest;
//   - legacy migration on restart: raw tokens become digests, raw links in
//     pending and historical drafts are scrubbed, the originally delivered
//     link still works and dispatch reproduces it exactly; replay is a no-op.
//
// Run only through tests/run-compliance-schedule-tokens.sh.
import crypto from "node:crypto";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { build } from "esbuild";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(testsDir, "..");
const dbName = new URL(process.env.DATABASE_URL ?? "postgres://x/none").pathname.slice(1);
if (!dbName.startsWith("ct_schedule_")) throw new Error(`Refusing to run against database "${dbName}": use run-compliance-schedule-tokens.sh`);
const OUTBOX = process.env.FIXTRACK_TEST_EMAIL_OUTBOX;
if (!OUTBOX) throw new Error("FIXTRACK_TEST_EMAIL_OUTBOX is required");
const PORT = process.env.TEST_PORT;
const BASE = `http://127.0.0.1:${PORT}/api`;
const APP = process.env.PUBLIC_APP_URL;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

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
    entryPoints: [path.join(testsDir, "compliance-schedule-tokens.entry.ts")],
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
  // Ready, or degraded only for lack of optional providers (no Stripe keys):
  // either way runtime migrations have completed.
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
  const email = `schedule-${label}-${Date.now()}-${Math.random()}@test.local`;
  const registered = await request("POST", "/auth/register", { name: `${label} manager`, email, password: "password-123" });
  if (!registered.data?.verificationToken) throw new Error(`${label}: registration returned no verification token (${registered.status})`);
  await request("GET", `/auth/verify-email?token=${encodeURIComponent(registered.data.verificationToken)}`);
  const login = await request("POST", "/auth/login", { email, password: "password-123" });
  if (login.status !== 200) throw new Error(`${label}: login failed (${login.status})`);
  return request;
}

const inDays = (days) => new Date(Date.now() + days * 86_400_000).toISOString();
async function complianceItem(request, label, dueInDays = 10) {
  const contractor = await request("POST", "/contractors", { name: `Gas engineer ${label}`, email: `gas-${label}-${Date.now()}@contractor.test` });
  const item = await request("POST", "/compliance-items", {
    title: `Gas safety ${label}`, contractorId: contractor.data?.id, dueDate: inDays(dueInDays), leadTimeDays: 30,
  });
  if (item.status !== 201) throw new Error(`${label}: create item failed (${item.status}) ${JSON.stringify(item.data)}`);
  return item.data.id;
}

const outbox = async () => (await readFile(OUTBOX, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
const scheduleLinks = (text) => [...String(text ?? "").matchAll(/\/schedule\/([^\s"'<>]+)/g)].map((m) => m[1]);

async function main() {
  await writeFile(OUTBOX, "");
  const { outDir, lib } = await bundle();
  const { db, sql, pool, digestBearerToken, decryptTokenPayload } = lib;
  const rows = async (query) => (await db.execute(query)).rows;
  const itemRow = async (id) => (await rows(sql`SELECT schedule_token, schedule_token_hash, visit_scheduled_at FROM compliance_items WHERE id=${id}`))[0];
  const queueRows = async (id) => rows(sql`SELECT * FROM contractor_email_queue WHERE entity_type='compliance' AND entity_id=${id} ORDER BY id`);
  try {
    await startServer();
    const owner = await tenant("owner");
    const foreign = await tenant("foreign");

    // ── New issuance ────────────────────────────────────────────────────────
    const itemId = await complianceItem(owner, "issue");
    const queued = await owner("POST", `/notifications/send-reminder/${itemId}`);
    check("issue: reminder queued for manager approval", queued.status === 200 && queued.data?.queued === true, JSON.stringify(queued.data));
    let stored = await itemRow(itemId);
    check("issue: item stores a SHA-256 digest only", stored.schedule_token === null && /^[0-9a-f]{64}$/.test(stored.schedule_token_hash ?? ""), JSON.stringify(stored));
    let [draft] = await queueRows(itemId);
    const draftText = [draft.subject, draft.body_html, draft.body_text, JSON.stringify(draft.email_preview_json)].join("\n");
    check("issue: draft holds a placeholder, never the raw link",
      !UUID.test(draftText) && draftText.includes("/schedule/{{BOOKED_TOKEN}}"), draftText.slice(0, 300));
    const payload = decryptTokenPayload(draft.encrypted_token_payload);
    check("issue: credential travels encrypted with the draft and matches the digest",
      UUID.test(payload.booked ?? "") && digestBearerToken(payload.booked) === stored.schedule_token_hash);
    check("issue: nothing is delivered before approval", (await outbox()).length === 0);

    // Only a manager of the owning tenant can release it.
    const foreignApprove = await foreign("POST", `/fix-track/contractor-email-queue/${draft.id}/approve-and-send`);
    check("tenant: another tenant cannot approve the draft", [404, 409].includes(foreignApprove.status), String(foreignApprove.status));
    const foreignQueue = await foreign("GET", "/fix-track/contractor-email-queue");
    check("tenant: another tenant cannot see the draft", !JSON.stringify(foreignQueue.data ?? "").includes(`"id":${draft.id},`));
    check("tenant: foreign link lookup reveals nothing", (await outbox()).length === 0);

    const approved = await owner("POST", `/fix-track/contractor-email-queue/${draft.id}/approve-and-send`);
    check("issue: manager approval dispatches", approved.status === 200, JSON.stringify(approved.data));
    let mail = (await outbox()).at(-1);
    const [link] = scheduleLinks(mail?.html);
    check("issue: delivered HTML carries the real link", UUID.test(link ?? "") && mail.html.includes(`${APP}/schedule/${link}`));
    check("issue: delivered text carries the same link", scheduleLinks(mail?.text).every((l) => l === link) && scheduleLinks(mail?.text).length === 1);
    check("issue: delivered link is the issued credential", link === payload.booked);

    const viewed = await publicApi("GET", `/notifications/public/schedule/${link}`);
    check("link: delivered link opens the scheduling page", viewed.status === 200 && viewed.data?.itemTitle === "Gas safety issue", JSON.stringify(viewed.data));
    check("link: digest is not a bearer credential (GET)",
      (await publicApi("GET", `/notifications/public/schedule/${stored.schedule_token_hash}`)).status === 404);
    check("link: digest is not a bearer credential (POST)",
      (await publicApi("POST", `/notifications/public/schedule/${stored.schedule_token_hash}`, { date: inDays(5) })).status === 404);
    check("link: an unknown token is rejected", (await publicApi("GET", `/notifications/public/schedule/${crypto.randomUUID()}`)).status === 404);

    // No API response or export carries the token or its digest.
    const list = await owner("GET", "/compliance-items");
    const one = await owner("GET", `/compliance-items/${itemId}`);
    const exposed = JSON.stringify([list.data, one.data]);
    check("api: compliance items never expose scheduling credentials",
      list.status === 200 && !exposed.includes(stored.schedule_token_hash) && !exposed.includes(link) && !/scheduleToken/.test(exposed));

    // ── Concurrent one-time booking ─────────────────────────────────────────
    const attempts = await Promise.all([3, 4, 5, 6, 7].map((days) =>
      publicApi("POST", `/notifications/public/schedule/${link}`, { date: inDays(days) })));
    const winners = attempts.filter((a) => a.status === 200);
    check("booking: exactly one concurrent submission wins", winners.length === 1, attempts.map((a) => a.status).join(","));
    check("booking: the others are told the link is no longer valid", attempts.filter((a) => a.status === 404).length === 4);
    stored = await itemRow(itemId);
    check("booking: link consumed and the winning date recorded",
      stored.schedule_token_hash === null && stored.visit_scheduled_at !== null
        && new Date(stored.visit_scheduled_at).toISOString() === new Date(winners[0]?.data?.scheduledFor).toISOString());
    const confirmations = (await queueRows(itemId)).filter((row) => row.subject.startsWith("Visit Confirmed"));
    check("booking: exactly one confirmation, awaiting approval", confirmations.length === 1 && confirmations[0].status === "pending");
    check("booking: a used link cannot be reopened", (await publicApi("GET", `/notifications/public/schedule/${link}`)).status === 404);
    check("booking: nothing extra delivered", (await outbox()).length === 1);

    // ── Re-issue invalidates the previous link ──────────────────────────────
    const rotateId = await complianceItem(owner, "rotate", 12);
    await owner("POST", `/notifications/send-reminder/${rotateId}`);
    [draft] = await queueRows(rotateId);
    await owner("POST", `/fix-track/contractor-email-queue/${draft.id}/approve-and-send`);
    const [firstLink] = scheduleLinks((await outbox()).at(-1)?.html);
    const retried = await owner("POST", `/notifications/send-reminder/${rotateId}`);
    check("rotate: a retried cycle queues nothing", retried.data?.queued === false);
    check("rotate: …and leaves the delivered link valid", (await publicApi("GET", `/notifications/public/schedule/${firstLink}`)).status === 200);
    const moved = await owner("PUT", `/compliance-items/${rotateId}`, { dueDate: inDays(20) });
    check("rotate: due date changed", moved.status === 200, String(moved.status));
    await owner("POST", `/notifications/send-reminder/${rotateId}`);
    const rotated = (await queueRows(rotateId)).find((row) => row.status === "pending");
    await owner("POST", `/fix-track/contractor-email-queue/${rotated.id}/approve-and-send`);
    const [secondLink] = scheduleLinks((await outbox()).at(-1)?.html);
    check("rotate: new cycle issues a different link", secondLink && secondLink !== firstLink);
    check("rotate: the superseded link is invalid", (await publicApi("GET", `/notifications/public/schedule/${firstLink}`)).status === 404);
    check("rotate: the new link works", (await publicApi("GET", `/notifications/public/schedule/${secondLink}`)).status === 200);

    // ── Legacy rows written by the previous release ─────────────────────────
    const legacyId = await complianceItem(owner, "legacy", 9);
    const historyId = await complianceItem(owner, "history", 8);
    const [legacyItem] = await rows(sql`SELECT client_id, contractor_id FROM compliance_items WHERE id=${legacyId}`);
    const legacyToken = crypto.randomUUID();
    const historyToken = crypto.randomUUID();
    await stopServer();
    await db.execute(sql`UPDATE compliance_items SET schedule_token=${legacyToken}, schedule_token_hash=NULL WHERE id=${legacyId}`);
    await db.execute(sql`UPDATE compliance_items SET schedule_token=${historyToken}, schedule_token_hash=NULL WHERE id=${historyId}`);
    const legacyDraft = async (entityId, token, status) => {
      const legacyLink = `${APP}/schedule/${token}`;
      const html = `<p>Hello</p><a href="${legacyLink}">Propose a Visit Date</a>`;
      const text = `Pick a suitable visit date here:\n${legacyLink}\n`;
      await db.execute(sql`INSERT INTO contractor_email_queue
        (client_id, entity_type, entity_id, contractor_id, email_type, mode, status, to_email, subject, body_html, body_text,
         cc_json, email_preview_json, idempotency_key)
        VALUES (${legacyItem.client_id}, 'compliance', ${entityId}, ${legacyItem.contractor_id}, 'reminder', 'assign', ${status},
          'legacy@contractor.test', 'Compliance Check Reminder', ${html}, ${text}, '[]'::jsonb,
          ${JSON.stringify({ subject: "Compliance Check Reminder", html, text })}::jsonb, ${`legacy-${entityId}-${status}`})`);
      return { html, text };
    };
    const original = await legacyDraft(legacyId, legacyToken, "pending");
    await legacyDraft(historyId, historyToken, "sent");

    await startServer();
    const migrated = await itemRow(legacyId);
    check("migration: raw token replaced by its digest",
      migrated.schedule_token === null && migrated.schedule_token_hash === digestBearerToken(legacyToken), JSON.stringify(migrated));
    check("migration: historical item migrated too", (await itemRow(historyId)).schedule_token_hash === digestBearerToken(historyToken));
    const [rawLeft] = await rows(sql`SELECT count(*)::int AS n FROM compliance_items WHERE schedule_token IS NOT NULL`);
    check("migration: no raw scheduling token remains", rawLeft.n === 0);
    const scrubbed = await rows(sql`SELECT subject, body_html, body_text, email_preview_json::text AS preview, encrypted_token_payload
      FROM contractor_email_queue WHERE entity_id IN (${legacyId}, ${historyId}) AND entity_type='compliance'`);
    check("migration: pending and historical drafts no longer hold the raw link",
      scrubbed.length === 2 && scrubbed.every((row) => ![row.subject, row.body_html, row.body_text, row.preview].join("").match(UUID)
        && row.body_html.includes("{{BOOKED_TOKEN}}") && row.encrypted_token_payload));
    check("migration: the delivered original link still works",
      (await publicApi("GET", `/notifications/public/schedule/${legacyToken}`)).status === 200);

    const [pendingLegacy] = (await queueRows(legacyId)).filter((row) => row.status === "pending");
    const legacySend = await owner("POST", `/fix-track/contractor-email-queue/${pendingLegacy.id}/approve-and-send`);
    mail = (await outbox()).at(-1);
    check("migration: approved legacy draft is delivered exactly as originally rendered",
      legacySend.status === 200 && mail.html === original.html && mail.text === original.text);

    // Replay: a further restart changes nothing.
    const snapshot = async () => (await rows(sql`SELECT md5(string_agg(t::text, '|' ORDER BY t::text)) AS d FROM (
        SELECT id::text || coalesce(schedule_token, '-') || coalesce(schedule_token_hash, '-') AS t FROM compliance_items
        UNION ALL SELECT id::text || subject || body_html || coalesce(body_text, '') || coalesce(encrypted_token_payload, '') FROM contractor_email_queue) x`))[0].d;
    const before = await snapshot();
    await stopServer();
    await startServer();
    check("replay: restart leaves digests and drafts untouched", await snapshot() === before);
    check("replay: original link still works after replay", (await publicApi("GET", `/notifications/public/schedule/${legacyToken}`)).status === 200);
    const booked = await publicApi("POST", `/notifications/public/schedule/${legacyToken}`, { date: inDays(4) });
    check("replay: original link books once", booked.status === 200);
    check("replay: and only once", (await publicApi("POST", `/notifications/public/schedule/${legacyToken}`, { date: inDays(4) })).status === 404);
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
