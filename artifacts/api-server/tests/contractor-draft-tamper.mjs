// Failure-path coverage for tampered or malformed contractor email drafts.
//
// Proves that altered key labels, IVs, authentication tags and ciphertext
// (including envelope downgrades), unknown keys and malformed decrypted
// payloads are refused explicitly; that preview and dispatch never reveal the
// credentials or call the provider for a damaged draft; and that failed sends
// restore the previous pending/approved state without consuming an approval
// or delivering twice.
//
// Run only through tests/run-contractor-draft-tamper.sh, which creates a
// disposable database, synthetic keys and a captured mail outbox, boots its
// own API server and drops the database afterwards.
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { build } from "esbuild";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.API_BASE;
const OUTBOX = process.env.FIXTRACK_TEST_EMAIL_OUTBOX;

// Never touch an application database or real secrets.
const dbName = new URL(process.env.DATABASE_URL ?? "postgres://x/none").pathname.slice(1);
if (!dbName.startsWith("ct_tamper_")) throw new Error(`Refusing to run against database "${dbName}": use run-contractor-draft-tamper.sh`);
if (process.env.CONTRACTOR_TOKEN_ENCRYPTION_KEY_VERSION !== "tamper-current") throw new Error("Synthetic keys are required");
if (!BASE || !OUTBOX) throw new Error("API_BASE and FIXTRACK_TEST_EMAIL_OUTBOX are set by the runner");

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
    entryPoints: [path.join(testsDir, "contractor-draft-tamper.entry.ts")],
    bundle: true, platform: "node", format: "esm", outfile: outFile, logLevel: "silent",
    external: ["pg-native", "pino", "pino-pretty", "resend", "@google-cloud/*", "nodemailer"],
    banner: { js: "import { createRequire as __r } from 'node:module';\nglobalThis.require = __r(import.meta.url);" },
  });
  return { outDir, lib: await import(new URL(`file://${outFile}`).href) };
}

// ── Envelope helpers (test-side, independent of the implementation) ────────
const CURRENT = { version: "tamper-current", secret: process.env.CONTRACTOR_TOKEN_ENCRYPTION_KEY };
const keyOf = (secret) => crypto.createHash("sha256").update(secret, "utf8").digest();
const b64 = (buffer) => Buffer.from(buffer).toString("base64url");
/** Encrypt arbitrary bytes as a well-formed v2 envelope with a real key. */
function seal(clearText, { version = CURRENT.version, secret = CURRENT.secret, envelope = "v2", aad = `${envelope}.${version}` } = {}) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", keyOf(secret), iv);
  if (aad) cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(clearText, "utf8"), cipher.final()]);
  return [envelope, version, b64(iv), b64(cipher.getAuthTag()), b64(ciphertext)].join(".");
}
const flip = (text) => {
  const bytes = Buffer.from(text, "base64url");
  bytes[0] ^= 0x01;
  return b64(bytes);
};
function alter(envelope, index, change) {
  const parts = envelope.split(".");
  parts[index] = change(parts[index]);
  return parts.join(".");
}

const token = () => crypto.randomBytes(32).toString("hex");
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

async function unitChecks(lib) {
  const { encryptTokenPayload, decryptTokenPayload, validateTokenPayload, TokenPayloadError } = lib;
  const payload = { booked: token(), completed: token() };
  const sealed = encryptTokenPayload(payload);
  check("unit: a healthy envelope round-trips", JSON.stringify(decryptTokenPayload(sealed)) === JSON.stringify(payload));
  check("unit: new envelopes use the current versioned format", sealed.startsWith("v2.tamper-current."));

  const reasonOf = (encoded) => {
    try {
      decryptTokenPayload(encoded);
      return "accepted";
    } catch (err) {
      const leaked = [payload.booked, payload.completed, CURRENT.secret, process.env.CONTRACTOR_TOKEN_ENCRYPTION_PREVIOUS_KEYS]
        .some((secret) => secret && String(err.message).includes(secret));
      if (leaked) return "leaked";
      return err instanceof TokenPayloadError ? err.reason : `untyped:${err.message}`;
    }
  };
  const cases = [
    // Key labels
    ["key label swapped to a retained previous key", alter(sealed, 1, () => "tamper-previous"), "integrity"],
    ["key label swapped to an unknown key", alter(sealed, 1, () => "tamper-missing"), "unknown_key"],
    ["key label with illegal characters", alter(sealed, 1, () => "bad label!"), "malformed"],
    ["key label removed", alter(sealed, 1, () => ""), "malformed"],
    ["key label relabelled as the legacy session key", alter(sealed, 1, () => "session-v1"), "integrity"],
    // IVs
    ["IV bit flipped", alter(sealed, 2, flip), "integrity"],
    ["IV truncated", alter(sealed, 2, (iv) => b64(Buffer.from(iv, "base64url").subarray(0, 11))), "malformed"],
    ["IV with non-base64url characters", alter(sealed, 2, (iv) => `${iv.slice(0, -1)}+`), "malformed"],
    // A 16-byte tag leaves 4 unused bits in its last character: setting one
    // gives a second spelling of the same bytes.
    ["tag in a non-canonical encoding", alter(sealed, 3, (tag) => `${tag.slice(0, -1)}${ALPHABET[ALPHABET.indexOf(tag.at(-1)) ^ 1]}`), "malformed"],
    // Authentication tags
    ["tag bit flipped", alter(sealed, 3, flip), "integrity"],
    ["tag truncated to 4 bytes (forgery shortcut)", alter(sealed, 3, (tag) => b64(Buffer.from(tag, "base64url").subarray(0, 4))), "malformed"],
    ["tag truncated to 12 bytes", alter(sealed, 3, (tag) => b64(Buffer.from(tag, "base64url").subarray(0, 12))), "malformed"],
    ["tag zeroed", alter(sealed, 3, () => b64(Buffer.alloc(16))), "integrity"],
    // Ciphertext
    ["ciphertext bit flipped", alter(sealed, 4, flip), "integrity"],
    ["ciphertext truncated", alter(sealed, 4, (c) => b64(Buffer.from(c, "base64url").subarray(0, 5))), "integrity"],
    ["ciphertext swapped from another draft", alter(sealed, 4, () => encryptTokenPayload({ quote: token() }).split(".")[4]), "integrity"],
    ["ciphertext empty", alter(sealed, 4, () => ""), "malformed"],
    // Downgrades
    ["v2 envelope relabelled v1 (drops associated data)", alter(sealed, 0, () => "v1"), "integrity"],
    ["v2 envelope stripped to the legacy three-part form", sealed.split(".").slice(2).join("."), "integrity"],
    ["unknown envelope version", alter(sealed, 0, () => "v3"), "malformed"],
    ["extra envelope part", `${sealed}.AAAA`, "malformed"],
    ["missing envelope part", sealed.split(".").slice(0, 4).join("."), "malformed"],
    ["empty envelope", "", "malformed"],
    ["oversized envelope", `v2.tamper-current.${"A".repeat(20_000)}`, "malformed"],
  ];
  for (const [name, encoded, expected] of cases) {
    const reason = reasonOf(encoded);
    check(`unit: ${name} → ${expected}`, reason === expected, `got ${reason}`);
  }

  // Validly encrypted, but not a credential payload.
  const shapes = [
    ["not JSON", "this is not json"],
    ["JSON null", "null"],
    ["array", JSON.stringify([token()])],
    ["empty object", "{}"],
    ["string", JSON.stringify("booked")],
    ["number value", JSON.stringify({ booked: 12345 })],
    ["nested object", JSON.stringify({ booked: { token: token() } })],
    ["unknown field", JSON.stringify({ booked: token(), admin: token() })],
    ["prototype key", `{"__proto__":{"booked":"${token()}"}}`],
    ["short token", JSON.stringify({ booked: "abc" })],
    ["token with markup", JSON.stringify({ booked: `${token()}"><script>` })],
    ["replacement-pattern token", JSON.stringify({ booked: `${"a".repeat(32)}$&` })],
    ["javascript portal URL", JSON.stringify({ portal: `javascript:alert(1)//contractor-portal/${token()}` })],
    ["portal URL to another path", JSON.stringify({ portal: `https://evil.example/steal/${token()}` })],
    ["portal URL with whitespace", JSON.stringify({ portal: `https://app.example/x y/contractor-portal/${token()}` })],
  ];
  for (const [name, clear] of shapes) {
    const reason = reasonOf(seal(clear));
    check(`unit: decrypted ${name} → payload_shape`, reason === "payload_shape", `got ${reason}`);
  }
  const parseLeak = (() => {
    // V8 quotes the source around an unexpected token in its message.
    try { decryptTokenPayload(seal(`{"booked":${payload.booked}}`)); return "accepted"; }
    catch (err) { return String(err.message); }
  })();
  check("unit: JSON errors never quote decrypted text", !parseLeak.includes(payload.booked.slice(0, 8)), parseLeak);

  let refusedEncrypt = 0;
  for (const bad of [{ booked: 1 }, { other: token() }, {}, { portal: "https://x/notportal" }]) {
    try { encryptTokenPayload(bad); } catch (err) { if (err instanceof TokenPayloadError) refusedEncrypt++; }
  }
  check("unit: bad shapes are never encrypted in the first place", refusedEncrypt === 4, String(refusedEncrypt));
  check("unit: legacy bare portal tokens remain valid", validateTokenPayload({ portal: token() }).portal?.length === 64);
  check("unit: full portal links are valid",
    !!validateTokenPayload({ portal: `https://app.example.com/contractor-portal/${token()}` }).portal);
}

// ── Route-level checks against the booted server ──────────────────────────
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
    const text = await response.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* non-JSON */ }
    return { status: response.status, data, text };
  };
}

const sentMail = async () => {
  const raw = await readFile(OUTBOX, "utf8").catch(() => "");
  return raw.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
};

async function routeChecks(lib) {
  const { db, sql, decryptTokenPayload, reencryptQueuedTokenPayloads } = lib;
  await writeFile(OUTBOX, "");
  const owner = session();
  const email = `tamper-${Date.now()}@test.local`;
  const registered = await owner("POST", "/auth/register", { name: "Tamper Manager", email, password: "password-123" });
  await owner("GET", `/auth/verify-email?token=${encodeURIComponent(registered.data?.verificationToken ?? "")}`);
  check("route: manager signs in", (await owner("POST", "/auth/login", { email, password: "password-123" })).status === 200);
  const me = await owner("GET", "/auth/me");
  const clientId = me.data?.user?.clientId;

  const contractor = await owner("POST", "/contractors", { name: "Tamper Contractor", email: `tamper-contractor-${Date.now()}@test.local` });
  async function queuedIssue(label, mode = "assign") {
    const issue = await owner("POST", "/fix-track/issues", {
      title: `Tamper ${label}`, issueType: "general", location: "Plant room", reportedBy: "Facilities",
      reportedDate: new Date().toISOString().slice(0, 10), contractorId: contractor.data?.id,
    });
    const requested = await owner("POST", `/fix-track/issues/${issue.data?.id}/request-send`, { mode });
    check(`route: ${label} queues a contractor draft`, requested.status === 200, String(requested.status));
    const [row] = (await db.execute(sql`SELECT * FROM contractor_email_queue WHERE client_id=${clientId}
      AND entity_type='fix_track' AND entity_id=${issue.data?.id} AND status='pending' ORDER BY id DESC LIMIT 1`)).rows;
    return { issueId: issue.data?.id, queueId: row.id, envelope: row.encrypted_token_payload };
  }
  const setEnvelope = (queueId, value) => db.execute(sql`UPDATE contractor_email_queue SET encrypted_token_payload=${value}
    WHERE id=${queueId} AND client_id=${clientId}`);
  const queueRow = async (queueId) => (await db.execute(sql`SELECT status, approved_by, approved_at, sent_by, last_error
    FROM contractor_email_queue WHERE id=${queueId}`)).rows[0];
  const issueState = async (issueId) => (await owner("GET", `/fix-track/issues/${issueId}`)).data?.emailRequestStatus;

  const healthy = await queuedIssue("healthy draft");
  const target = await queuedIssue("tampered draft");
  const secrets = Object.values(decryptTokenPayload(target.envelope));
  const reveals = (response) => secrets.some((secret) => response.text.includes(secret));
  const parts = target.envelope.split(".");
  const variants = [
    ["tag flipped", alter(target.envelope, 3, flip), 409, "draft_credentials_damaged"],
    ["IV flipped", alter(target.envelope, 2, flip), 409, "draft_credentials_damaged"],
    ["ciphertext flipped", alter(target.envelope, 4, flip), 409, "draft_credentials_damaged"],
    ["relabelled to a retained key", alter(target.envelope, 1, () => "tamper-previous"), 409, "draft_credentials_damaged"],
    ["downgraded to v1", alter(target.envelope, 0, () => "v1"), 409, "draft_credentials_damaged"],
    ["downgraded to legacy form", parts.slice(2).join("."), 409, "draft_credentials_damaged"],
    ["truncated tag", alter(target.envelope, 3, (tag) => b64(Buffer.from(tag, "base64url").subarray(0, 4))), 409, "draft_credentials_damaged"],
    ["unsafe decrypted shape", seal(JSON.stringify({ booked: `${"a".repeat(32)}$&`, completed: token() })), 409, "draft_credentials_damaged"],
    ["unknown key version", alter(target.envelope, 1, () => "tamper-missing"), 503, "draft_key_unavailable"],
  ];

  for (const [name, envelope, status, code] of variants) {
    await setEnvelope(target.queueId, envelope);
    const mailBefore = (await sentMail()).length;

    const list = await owner("GET", "/fix-track/contractor-email-queue");
    const listed = (list.data ?? []).find((row) => row.id === target.queueId);
    check(`route[${name}]: queue still lists`, list.status === 200 && (list.data ?? []).some((row) => row.id === healthy.queueId), String(list.status));
    check(`route[${name}]: draft flagged, not hydrated`, listed?.credentialsDamaged === true && JSON.stringify(listed?.emailPreviewJson ?? {}).includes("{{BOOKED_TOKEN}}"));
    check(`route[${name}]: preview reveals no credentials`, !reveals(list));

    const approve = await owner("POST", `/fix-track/contractor-email-queue/${target.queueId}/approve-and-send`);
    check(`route[${name}]: approve-and-send refused explicitly`, approve.status === status && approve.data?.code === code, `${approve.status} ${approve.text}`);
    check(`route[${name}]: refusal reveals no credentials`, !reveals(approve));
    const afterApprove = await queueRow(target.queueId);
    check(`route[${name}]: draft stays pending and unapproved`, afterApprove.status === "pending" && afterApprove.approved_by === null && afterApprove.sent_by === null, JSON.stringify(afterApprove));
    check(`route[${name}]: reason recorded without credentials`, !!afterApprove.last_error && !secrets.some((s) => afterApprove.last_error.includes(s)), afterApprove.last_error);

    const edit = await owner("PUT", `/fix-track/contractor-email-queue/${target.queueId}`, { subject: "Edited", bodyHtml: "<p>Edited</p>" });
    check(`route[${name}]: editing refused`, edit.status === status, String(edit.status));
    const editSend = await owner("POST", `/fix-track/contractor-email-queue/${target.queueId}/edit-and-send`, { subject: "Edited", bodyText: "Edited" });
    check(`route[${name}]: edit-and-send refused`, editSend.status === status, String(editSend.status));

    check(`route[${name}]: issue approval recorded`, (await owner("POST", `/fix-track/issues/${target.issueId}/approve-send`)).status === 200);
    const send = await owner("POST", `/fix-track/issues/${target.issueId}/send-to-contractor`);
    check(`route[${name}]: send-to-contractor refused`, send.status === status && send.data?.code === code, `${send.status} ${send.text}`);
    check(`route[${name}]: issue approval kept for a later retry`, await issueState(target.issueId) === "approved");
    const afterSend = await queueRow(target.queueId);
    check(`route[${name}]: queue row untouched by send attempt`, afterSend.status === "pending" && afterSend.approved_by === null, JSON.stringify(afterSend));
    check(`route[${name}]: no provider call`, (await sentMail()).length === mailBefore);

    // Return the issue to pending review for the next variant.
    await db.execute(sql`UPDATE fix_track_issues SET email_request_status='pending', email_approved_by=NULL, email_approved_at=NULL WHERE id=${target.issueId}`);
  }

  // Startup migrations skip a damaged row; a missing key still stops startup.
  await setEnvelope(target.queueId, alter(target.envelope, 3, flip));
  let skipped = "threw";
  try { skipped = String(await reencryptQueuedTokenPayloads(target.queueId)); } catch { /* recorded below */ }
  check("migration: a damaged draft is skipped, not fatal", skipped === "0", skipped);
  await setEnvelope(target.queueId, alter(target.envelope, 1, () => "tamper-missing"));
  let unknownKey = "accepted";
  try { await reencryptQueuedTokenPayloads(target.queueId); } catch (err) { unknownKey = err?.reason ?? err?.message; }
  check("migration: a missing key still fails loudly", unknownKey === "unknown_key", unknownKey);

  // Repair (restore the original envelope): the same draft sends exactly once.
  await setEnvelope(target.queueId, target.envelope);
  const recovered = await owner("POST", `/fix-track/contractor-email-queue/${target.queueId}/approve-and-send`);
  check("recovery: restored draft sends", recovered.status === 200, `${recovered.status} ${recovered.text}`);
  const delivered = (await sentMail()).filter((mail) => secrets.some((s) => mail.html?.includes(s)));
  check("recovery: exactly one delivery with the original links", delivered.length === 1, String(delivered.length));

  // Provider failure: the approval is handed back and the retry delivers once.
  const flaky = await queuedIssue("provider failure");
  await rm(OUTBOX, { force: true });
  await mkdir(OUTBOX);
  const failed = await owner("POST", `/fix-track/contractor-email-queue/${flaky.queueId}/approve-and-send`);
  check("provider failure: reported as a send failure", failed.status === 502, String(failed.status));
  const afterFailure = await queueRow(flaky.queueId);
  check("provider failure: draft pending again with no approval consumed",
    afterFailure.status === "pending" && afterFailure.approved_by === null && afterFailure.approved_at === null && afterFailure.sent_by === null,
    JSON.stringify(afterFailure));
  check("provider failure: issue back in review", await issueState(flaky.issueId) === "pending");
  await rm(OUTBOX, { recursive: true, force: true });
  await writeFile(OUTBOX, "");
  const retry = await owner("POST", `/fix-track/contractor-email-queue/${flaky.queueId}/approve-and-send`);
  check("provider failure: retry succeeds", retry.status === 200, String(retry.status));
  const retryAgain = await owner("POST", `/fix-track/contractor-email-queue/${flaky.queueId}/approve-and-send`);
  check("provider failure: a second retry is refused", retryAgain.status === 409, String(retryAgain.status));
  check("provider failure: exactly one delivery", (await sentMail()).length === 1, String((await sentMail()).length));

  // send-to-contractor failure restores the issue's approval and the draft's fields.
  const approvedFlaky = await queuedIssue("approved provider failure");
  await owner("POST", `/fix-track/issues/${approvedFlaky.issueId}/approve-send`);
  await rm(OUTBOX, { force: true });
  await mkdir(OUTBOX);
  check("send failure: reported", (await owner("POST", `/fix-track/issues/${approvedFlaky.issueId}/send-to-contractor`)).status === 502);
  const afterSendFailure = await queueRow(approvedFlaky.queueId);
  check("send failure: issue approval kept", await issueState(approvedFlaky.issueId) === "approved");
  check("send failure: draft fields restored", afterSendFailure.status === "pending" && afterSendFailure.approved_by === null && afterSendFailure.sent_by === null, JSON.stringify(afterSendFailure));
  await rm(OUTBOX, { recursive: true, force: true });
  await writeFile(OUTBOX, "");
  check("send failure: retry without re-approval succeeds", (await owner("POST", `/fix-track/issues/${approvedFlaky.issueId}/send-to-contractor`)).status === 200);
  check("send failure: exactly one delivery", (await sentMail()).length === 1);

  // Editing the job with a damaged draft withdraws it instead of failing.
  const edited = await queuedIssue("damaged then edited");
  await setEnvelope(edited.queueId, alter(edited.envelope, 4, flip));
  const update = await owner("PUT", `/fix-track/issues/${edited.issueId}`, { title: "Tamper damaged then edited (revised)" });
  check("edit: job update still succeeds", update.status === 200, `${update.status} ${update.text}`);
  check("edit: damaged draft withdrawn", (await queueRow(edited.queueId)).status === "cancelled");
  check("edit: issue needs a fresh request", update.data?.emailRequestStatus === "rejected" && await issueState(edited.issueId) === "rejected");
  check("edit: no provider call", (await sentMail()).length === 1);

  // The healthy draft was unaffected throughout.
  check("isolation: healthy draft still decrypts", Object.keys(decryptTokenPayload((await db.execute(sql`SELECT encrypted_token_payload FROM contractor_email_queue WHERE id=${healthy.queueId}`)).rows[0].encrypted_token_payload)).length === 2);
}

async function main() {
  const { outDir, lib } = await bundle();
  try {
    await unitChecks(lib);
    await routeChecks(lib);
  } finally {
    await rm(outDir, { recursive: true, force: true });
    await lib.pool.end().catch(() => {});
  }
  console.log(`\n${passed} checks passed, ${failures.length} failed.`);
  if (failures.length) process.exit(1);
}

main().catch((err) => {
  console.error("Test run crashed:", err);
  process.exit(1);
});
