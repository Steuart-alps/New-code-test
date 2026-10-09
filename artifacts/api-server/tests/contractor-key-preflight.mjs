// Key-retirement preflight for contractor email draft encryption.
//
// Seeds fixture drafts in a disposable database with synthetic keys, then
// walks a rotation: old key current → new key current with the old retained →
// drafts drained → retirement. Proves the preflight reports aggregate counts
// only (including legacy unversioned payloads), names retained versions still
// referenced by active or historical drafts, never calls a key safe to retire
// before old writers are confirmed drained and no old-version rows remain,
// never exposes payloads, links, recipients or keys, and changes nothing.
//
// Run only through tests/run-contractor-key-preflight.sh.
import crypto from "node:crypto";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { build } from "esbuild";

const execFile = promisify(execFileCallback);
const testsDir = path.dirname(fileURLToPath(import.meta.url));
const dbName = new URL(process.env.DATABASE_URL ?? "postgres://x/none").pathname.slice(1);
if (!dbName.startsWith("ct_keypre_")) throw new Error(`Refusing to run against database "${dbName}": use run-contractor-key-preflight.sh`);
const OLD = { version: "rot-old", secret: process.env.ROTATION_OLD_KEY };
const NEW = { version: "rot-new", secret: process.env.ROTATION_NEW_KEY };
if (!OLD.secret || !NEW.secret) throw new Error("Synthetic keys are required");

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
    entryPoints: [path.join(testsDir, "contractor-key-preflight.entry.ts")],
    bundle: true, platform: "node", format: "esm", outfile: outFile, logLevel: "silent",
    external: ["pg-native", "pino", "pino-pretty", "resend", "@google-cloud/*", "nodemailer"],
    banner: { js: "import { createRequire as __r } from 'node:module';\nglobalThis.require = __r(import.meta.url);" },
  });
  return { outDir, lib: await import(new URL(`file://${outFile}`).href) };
}

const keyOf = (secret) => crypto.createHash("sha256").update(secret, "utf8").digest();
const b64 = (buffer) => Buffer.from(buffer).toString("base64url");
function seal(payload, { version, secret, envelope = "v2" }) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", keyOf(secret), iv);
  if (envelope === "v2") cipher.setAAD(Buffer.from(`v2.${version}`, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  const parts = [b64(iv), b64(cipher.getAuthTag()), b64(ciphertext)];
  return envelope === "legacy" ? parts.join(".") : [envelope, version, ...parts].join(".");
}

const sensitive = [OLD.secret, NEW.secret, process.env.SESSION_SECRET];
const token = () => {
  const value = crypto.randomBytes(32).toString("hex");
  sensitive.push(value);
  return value;
};

function useKeys({ current, retained = {} }) {
  process.env.CONTRACTOR_TOKEN_ENCRYPTION_KEY = current.secret;
  process.env.CONTRACTOR_TOKEN_ENCRYPTION_KEY_VERSION = current.version;
  if (Object.keys(retained).length) process.env.CONTRACTOR_TOKEN_ENCRYPTION_PREVIOUS_KEYS = JSON.stringify(retained);
  else delete process.env.CONTRACTOR_TOKEN_ENCRYPTION_PREVIOUS_KEYS;
}

async function main() {
  const { outDir, lib } = await bundle();
  const { db, sql, runKeyPreflight, formatKeyPreflightReport, runRuntimeMigrations, reencryptQueuedTokenPayloads, pool } = lib;
  try {
    useKeys({ current: OLD });
    await runRuntimeMigrations();

    const tag = `keyrot-${Date.now()}`;
    const [client] = (await db.execute(sql`INSERT INTO clients (name, slug, active) VALUES (${`Key rotation ${tag}`}, ${tag}, true) RETURNING id`)).rows;
    let fixture = 0;
    const draft = async (status, envelope) => {
      fixture += 1;
      const email = `${tag}-${fixture}@contractor.test`;
      const subject = `Subject ${tag} ${fixture}`;
      sensitive.push(email, subject);
      if (envelope) sensitive.push(...envelope.split(".").slice(-3).filter((part) => part.length >= 16));
      const [row] = (await db.execute(sql`INSERT INTO contractor_email_queue
        (client_id, entity_type, entity_id, mode, status, to_email, subject, body_html, idempotency_key, encrypted_token_payload)
        VALUES (${client.id}, 'compliance', ${fixture}, 'assign', ${status}, ${email}, ${subject}, ${`<p>${subject}</p>`},
          ${`${tag}-${fixture}`}, ${envelope}) RETURNING id`)).rows;
      return row.id;
    };
    const portal = () => `https://app.example.com/contractor-portal/${token()}`;
    await draft("pending", seal({ booked: token(), completed: token() }, OLD));
    await draft("approved", seal({ quote: token() }, OLD));
    await draft("sending", seal({ portal: portal() }, OLD));
    await draft("sent", seal({ booked: token(), completed: token() }, OLD));
    await draft("sent", seal({ quote: token() }, { secret: process.env.SESSION_SECRET, envelope: "legacy" }));
    await draft("cancelled", seal({ quote: token() }, { ...OLD, envelope: "v1" }));
    await draft("pending", null);
    const malformed = await draft("failed", "v2.rot-old.not.an-envelope.at-all!");

    const snapshot = async () => (await db.execute(sql`SELECT md5(string_agg(q::text, '|' ORDER BY id)) AS digest
      FROM contractor_email_queue q`)).rows[0].digest;
    const settingsSnapshot = async () => (await db.execute(sql`SELECT md5(coalesce(string_agg(s::text, '|' ORDER BY id), '')) AS digest FROM app_settings s`)).rows[0].digest;

    const assertSecret = (label, report) => {
      const text = `${JSON.stringify(report)}\n${formatKeyPreflightReport(report)}`;
      const leaked = sensitive.filter((value) => value && text.includes(value));
      check(`${label}: no payloads, links, recipients, subjects, ciphertext or keys in the output`, leaked.length === 0, `${leaked.length} leaked`);
      check(`${label}: no portal or action URLs`, !/contractor-portal|fix-track\/action|contractor-quote/.test(text));
    };

    // ── Stage 1: old key is current; nothing retained ─────────────────────
    const before = await snapshot();
    const settingsBefore = await settingsSnapshot();
    let report = await runKeyPreflight({ writersDrainedConfirmed: false });
    assertSecret("stage 1", report);
    const old1 = report.versions.find((v) => v.keyVersion === "rot-old");
    check("stage 1: aggregates by key version and queue state",
      old1?.configured === "current" && old1.active === 3 && old1.historical === 2
        && old1.byStatus.pending === 1 && old1.byStatus.approved === 1 && old1.byStatus.sending === 1
        && old1.byStatus.sent === 1 && old1.byStatus.cancelled === 1, JSON.stringify(old1));
    check("stage 1: envelope formats counted separately (v1 vs v2)",
      report.envelopes.some((e) => e.format === "v1" && e.keyVersion === "rot-old" && e.status === "cancelled" && e.count === 1));
    check("stage 1: legacy unversioned payloads reported", report.legacyUnversioned.total === 1 && report.legacyUnversioned.byStatus.sent === 1);
    check("stage 1: malformed envelopes reported without their label", report.malformed.total === 1 && !report.envelopes.some((e) => e.format === "malformed" && e.keyVersion));
    check("stage 1: drafts without credentials counted", report.totals.withoutCredentials === 1 && report.totals.drafts === 8);
    check("stage 1: nothing retained, nothing to retire", report.retirement.length === 0);

    // ── Stage 2: new key current, old retained (rotation started) ─────────
    useKeys({ current: NEW, retained: { "rot-old": OLD.secret } });
    report = await runKeyPreflight({ writersDrainedConfirmed: true });
    assertSecret("stage 2", report);
    let old = report.retirement.find((r) => r.keyVersion === "rot-old");
    check("stage 2: retained key referenced by active drafts is not safe",
      old && !old.safeToRetire && old.blockers.some((b) => b.includes("3 pending, approved or sending")), JSON.stringify(old));
    check("stage 2: historical references named", old.blockers.some((b) => b.includes("2 historical")));
    check("stage 2: legacy payloads block retirement", old.blockers.some((b) => b.includes("legacy unversioned")));
    check("stage 2: report marks the version as retained", report.versions.find((v) => v.keyVersion === "rot-old")?.configured === "retained");
    check("stage 2: preflight changed no queue rows", await snapshot() === before);
    check("stage 2: preflight changed no settings", await settingsSnapshot() === settingsBefore);

    // ── Stage 3: startup re-encryption moves readable drafts ──────────────
    await db.execute(sql`DELETE FROM contractor_email_queue WHERE id=${malformed}`); // would be skipped anyway
    const moved = await reencryptQueuedTokenPayloads();
    check("stage 3: startup re-encryption moved old, v1 and legacy drafts", moved === 6, String(moved));
    report = await runKeyPreflight({ writersDrainedConfirmed: false });
    old = report.retirement.find((r) => r.keyVersion === "rot-old");
    check("stage 3: no rows remain but writers are not confirmed → not safe",
      !old.safeToRetire && old.blockers.length === 1 && old.blockers[0].includes("--writers-drained"), JSON.stringify(old));
    check("stage 3: legacy count now zero", report.legacyUnversioned.total === 0);
    check("stage 3: every draft on the new key", report.versions.length === 1 && report.versions[0].keyVersion === "rot-new");

    // An old writer that is still running re-introduces old-version rows.
    const lateOld = await draft("pending", seal({ quote: token() }, OLD));
    report = await runKeyPreflight({ writersDrainedConfirmed: true });
    old = report.retirement.find((r) => r.keyVersion === "rot-old");
    check("stage 3: a late old-version draft blocks retirement again", !old.safeToRetire && old.blockers.some((b) => b.includes("1 pending")), JSON.stringify(old));
    await reencryptQueuedTokenPayloads(lateOld);

    // ── Stage 4: drained and confirmed → safe ─────────────────────────────
    const beforeSafe = await snapshot();
    report = await runKeyPreflight({ writersDrainedConfirmed: true });
    old = report.retirement.find((r) => r.keyVersion === "rot-old");
    check("stage 4: safe once nothing references it and writers are drained", old?.safeToRetire === true && old.blockers.length === 0, JSON.stringify(old));
    check("stage 4: preflight still changed nothing", await snapshot() === beforeSafe);
    assertSecret("stage 4", report);

    // ── Configuration problems are surfaced, never with key values ────────
    useKeys({ current: NEW, retained: { "rot-new": OLD.secret } });
    report = await runKeyPreflight({ writersDrainedConfirmed: true });
    check("config: a reused current version is a problem that blocks retirement",
      report.configuration.problems.length === 1 && report.retirement.every((r) => !r.safeToRetire), JSON.stringify(report.configuration));
    assertSecret("config", report);
    process.env.CONTRACTOR_TOKEN_ENCRYPTION_PREVIOUS_KEYS = "{not json";
    report = await runKeyPreflight({ writersDrainedConfirmed: true });
    check("config: unreadable retained keys reported", report.configuration.problems.some((p) => p.includes("PREVIOUS_KEYS")));

    // ── The deployable command ────────────────────────────────────────────
    useKeys({ current: NEW, retained: { "rot-old": OLD.secret } });
    const cli = (...args) => execFile("node", ["dist/contractor-key-preflight.mjs", ...args], { env: process.env })
      .then((r) => ({ code: 0, out: r.stdout + r.stderr }))
      .catch((err) => ({ code: err.code, out: `${err.stdout}${err.stderr}` }));
    const notConfirmed = await cli("--version", "rot-old");
    check("cli: not safe without --writers-drained (exit 2)", notConfirmed.code === 2 && notConfirmed.out.includes("Retire rot-old: NOT YET"), notConfirmed.out);
    const confirmed = await cli("--version", "rot-old", "--writers-drained");
    check("cli: safe with confirmation (exit 0)", confirmed.code === 0 && confirmed.out.includes("Retire rot-old: SAFE"), confirmed.out);
    const asJson = await cli("--json", "--writers-drained");
    check("cli: --json prints the report", asJson.code === 0 && JSON.parse(asJson.out).retirement?.[0]?.safeToRetire === true);
    check("cli: output contains no secrets", !sensitive.some((value) => value && `${notConfirmed.out}${confirmed.out}${asJson.out}`.includes(value)));
    const unknown = await cli("--version", "rot-unknown");
    check("cli: unknown version is not safe (exit 2)", unknown.code === 2);

    // Retiring the key after a SAFE result leaves every draft readable.
    useKeys({ current: NEW });
    const remaining = (await db.execute(sql`SELECT encrypted_token_payload FROM contractor_email_queue
      WHERE client_id=${client.id} AND encrypted_token_payload IS NOT NULL`)).rows;
    let readable = 0;
    for (const row of remaining) { try { lib.decryptTokenPayload(row.encrypted_token_payload); readable++; } catch { /* counted below */ } }
    check("retired: every remaining draft decrypts without the old key", readable === remaining.length, `${readable}/${remaining.length}`);
  } finally {
    await rm(outDir, { recursive: true, force: true });
    await pool.end().catch(() => {});
  }
  console.log(`\n${passed} checks passed, ${failures.length} failed.`);
  if (failures.length) process.exit(1);
}

main().catch((err) => {
  console.error("Test run crashed:", err);
  process.exit(1);
});
