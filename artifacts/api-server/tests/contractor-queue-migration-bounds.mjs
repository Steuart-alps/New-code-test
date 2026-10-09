// Bounded, restart-safe startup passes over queued contractor credentials.
//
// Seeds a sizeable mixed history in a disposable database with synthetic
// keys: secured drafts on the current key, drafts on the previous key, legacy
// three-part envelopes, and legacy plaintext drafts whose bearer tokens also
// appear as bare text in subjects, HTML, plain text and preview JSON. Proves
// that the scrub and re-encrypt passes:
//   - select and lock only rows that still need work, in bounded id batches,
//     and never wait on (or lock) secured current-version history;
//   - resume after an interrupted batch without redoing or losing work;
//   - leave no raw token anywhere while hydration reproduces the delivered
//     links exactly, and keep quote digests, queue state and action-token
//     expiry/use state unchanged;
//   - are idempotent, and pick up rows an old writer adds later;
//   - are served by indexes, so a restart reads only the rows needing work.
// Assertions are on batch membership, counts and lock state, not timings.
//
// Run only through tests/run-contractor-queue-migration-bounds.sh.
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { build } from "esbuild";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const dbName = new URL(process.env.DATABASE_URL ?? "postgres://x/none").pathname.slice(1);
if (!dbName.startsWith("ct_qbounds_")) throw new Error(`Refusing to run against database "${dbName}": use run-contractor-queue-migration-bounds.sh`);
const OLD = { version: "sec-old", secret: process.env.SECURITY_OLD_KEY };
const NEW = { version: "sec-new", secret: process.env.SECURITY_NEW_KEY };
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
    entryPoints: [path.join(testsDir, "contractor-queue-migration-bounds.entry.ts")],
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
const token = () => crypto.randomBytes(32).toString("hex");
const sepIds = (batches) => new Set(batches.flatMap((b) => b.ids));
const fill = (text, payload) => text == null ? text : text
  .split("{{BOOKED_TOKEN}}").join(payload.booked ?? "{{BOOKED_TOKEN}}")
  .split("{{COMPLETED_TOKEN}}").join(payload.completed ?? "{{COMPLETED_TOKEN}}")
  .split("{{QUOTE_TOKEN}}").join(payload.quote ?? "{{QUOTE_TOKEN}}")
  .split("{{PORTAL_URL}}").join(payload.portal ?? "{{PORTAL_URL}}");

// jsonb does not keep key order.
const canonical = (value) => JSON.stringify(value, (_key, v) => v && typeof v === "object" && !Array.isArray(v)
  ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);

const SECURED = 1200, PREVIOUS = 150, LEGACY_ENVELOPE = 30, PLAINTEXT = 120, MIXED = 10;
const STATUSES = ["pending", "approved", "sending", "sent", "cancelled", "failed"];
const APP = "https://app.example.test";

async function main() {
  const { outDir, lib } = await bundle();
  const { db, sql, pool, runRuntimeMigrations, reencryptQueuedTokenPayloads, scrubLegacyQueuedCredentials, sweepPlainTextQueuedCredentials,
    decryptTokenPayload, digestBearerToken } = lib;
  const rows = async (query) => (await db.execute(query)).rows;
  let holder = null;
  const pgArray = (values) => `{${values.join(",")}}`; // ids and hex tokens only
  try {
    // A deployment rotated from OLD to NEW, retaining OLD for reading.
    process.env.CONTRACTOR_TOKEN_ENCRYPTION_KEY = NEW.secret;
    process.env.CONTRACTOR_TOKEN_ENCRYPTION_KEY_VERSION = NEW.version;
    process.env.CONTRACTOR_TOKEN_ENCRYPTION_PREVIOUS_KEYS = JSON.stringify({ [OLD.version]: OLD.secret });
    await runRuntimeMigrations();

    const tag = `tokensec-${Date.now()}`;
    const [client] = await rows(sql`INSERT INTO clients (name, slug, active) VALUES (${`Token security ${tag}`}, ${tag}, true) RETURNING id`);
    const [issue] = await rows(sql`INSERT INTO fix_track_issues (client_id, title, location, reported_by, reported_date)
      VALUES (${client.id}, 'Boiler', 'Plant room', 'Fixture', CURRENT_DATE) RETURNING id`);

    // ── Fixture history, deliberately interleaved by id ─────────────────────
    const specs = [];
    for (let i = 0; i < SECURED; i++) specs.push({ kind: "secured", envelope: seal({ quote: token() }, NEW) });
    for (let i = 0; i < PREVIOUS; i++) specs.push({ kind: "previous", payload: { booked: token(), completed: token() } });
    for (let i = 0; i < LEGACY_ENVELOPE; i++) specs.push({ kind: "legacyEnvelope", payload: { quote: token() } });
    const actionTokens = [];
    for (let i = 0; i < PLAINTEXT + MIXED; i++) {
      const variant = i < PLAINTEXT ? i % 4 : 4;
      const spec = { kind: "plaintext", variant, tokens: {} };
      const t = spec.tokens;
      if (variant === 0) { // quote link, raw quote_token column, bare duplicates everywhere
        t.quote = token();
        spec.quoteToken = t.quote;
        spec.subject = `Quote request ref ${t.quote}`;
        spec.html = `<p><a href="${APP}/contractor-quote/${t.quote}">Submit quote</a></p><p>Ref: ${t.quote}</p>`;
        spec.text = `Submit quote: ${APP}/contractor-quote/${t.quote}\nRef ${t.quote}`;
        spec.preview = { html: spec.html, note: `token ${t.quote}`, links: [`${APP}/contractor-quote/${t.quote}`] };
      } else if (variant === 1) { // portal link with bare duplicates
        t.portal = token();
        spec.subject = `Portal access ${t.portal}`;
        spec.html = `<a href="${APP}/contractor-portal/${t.portal}">Portal</a> code ${t.portal}`;
        spec.text = `Portal ${APP}/contractor-portal/${t.portal} code ${t.portal}`;
        spec.preview = { text: spec.text, nested: { code: t.portal } };
      } else if (variant === 2) { // booked/completed action links, bare duplicates, no plain text
        t.booked = token();
        t.completed = token();
        actionTokens.push(["booked", t.booked], ["completed", t.completed]);
        spec.subject = `Job ${t.booked}`;
        spec.html = `<a href="${APP}/api/fix-track/action/${t.booked}">Booked</a> <a href="${APP}/api/fix-track/action/${t.completed}">Done</a> ${t.completed}`;
        spec.text = null;
        spec.preview = { html: spec.html, bare: [t.booked, t.completed] };
      } else if (variant === 3) { // raw quote_token column only: bare text, no link
        t.quote = token();
        spec.quoteToken = t.quote;
        spec.subject = `Quote ${t.quote}`;
        spec.html = "<p>Please submit a quote.</p>";
        spec.text = `Reference ${t.quote}`;
        spec.preview = { reference: t.quote };
      } else { // old writer: previous-key payload plus a raw quote link added later
        t.quote = token();
        spec.encryptedPayload = { booked: token() };
        spec.subject = "Quote";
        spec.html = `<a href="${APP}/contractor-quote/${t.quote}">Quote</a>`;
        spec.text = `${APP}/contractor-quote/${t.quote}`;
        spec.preview = { html: spec.html };
      }
      specs.push(spec);
    }
    // Deterministic shuffle so candidates are spread through the id range.
    let seed = 7;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let i = specs.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [specs[i], specs[j]] = [specs[j], specs[i]];
    }
    const records = specs.map((spec, index) => {
      const status = STATUSES[index % STATUSES.length];
      const base = { status, entity: 1000 + index, key: `${tag}-${index}`, to: `c${index}@contractor.test`, quoteToken: spec.quoteToken ?? null };
      if (spec.kind === "secured") return { ...base, subject: "Quote", html: `<a href="${APP}/contractor-quote/{{QUOTE_TOKEN}}">Quote</a>`, text: null, preview: {}, payload: spec.envelope };
      if (spec.kind === "previous") return { ...base, subject: "Job", html: "<p>{{BOOKED_TOKEN}}</p>", text: null, preview: {}, payload: seal(spec.payload, OLD) };
      if (spec.kind === "legacyEnvelope") return { ...base, subject: "Quote", html: "<p>{{QUOTE_TOKEN}}</p>", text: null, preview: {}, payload: seal(spec.payload, { secret: NEW.secret, envelope: "legacy" }) };
      return { ...base, subject: spec.subject, html: spec.html, text: spec.text, preview: spec.preview,
        payload: spec.encryptedPayload ? seal(spec.encryptedPayload, OLD) : null };
    });
    const inserted = await rows(sql`INSERT INTO contractor_email_queue
      (client_id, issue_id, entity_type, entity_id, mode, email_type, status, to_email, subject, body_html, body_text,
       cc_json, email_preview_json, idempotency_key, quote_token, encrypted_token_payload, quote_token_expires_at)
      SELECT ${client.id}, ${issue.id}, 'fix_track', r.entity, 'assign', 'assignment', r.status, r.to, r.subject, r.html, r.text,
        '[]'::jsonb, r.preview, r.key, r."quoteToken", r.payload, now() + interval '7 days'
      FROM jsonb_to_recordset(${JSON.stringify(records)}::jsonb)
        AS r(status text, entity int, key text, "to" text, subject text, html text, text text, preview jsonb, payload text, "quoteToken" text)
      ORDER BY r.key COLLATE "C"
      RETURNING id, idempotency_key`);
    const idByKey = new Map(inserted.map((row) => [row.idempotency_key, Number(row.id)]));
    specs.forEach((spec, index) => { spec.id = idByKey.get(`${tag}-${index}`); });
    for (const [action, raw] of actionTokens) {
      await db.execute(sql`INSERT INTO fix_track_action_tokens (token, token_hash, issue_id, client_id, action, expires_at, used_at)
        VALUES (${null}, ${digestBearerToken(raw)}, ${issue.id}, ${client.id}, ${action}, now() + interval '14 days',
          ${action === "completed" ? sql`now() - interval '1 day'` : null})`);
    }
    const plaintext = specs.filter((spec) => spec.kind === "plaintext");
    const plaintextIds = new Set(plaintext.map((spec) => spec.id));
    const securedIds = new Set(specs.filter((spec) => spec.kind === "secured").map((spec) => spec.id));
    check("fixture: candidates interleave with secured history",
      Math.min(...plaintextIds) < Math.max(...securedIds) && Math.max(...plaintextIds) > Math.min(...securedIds));

    // State the passes must never change.
    const stateSnapshot = async () => (await rows(sql`SELECT md5(string_agg((to_jsonb(q)
        - 'subject' - 'body_html' - 'body_text' - 'email_preview_json' - 'encrypted_token_payload'
        - 'quote_token' - 'quote_token_hash' - 'updated_at')::text, '|' ORDER BY id)) AS digest
      FROM contractor_email_queue q`))[0].digest;
    const actionSnapshot = async () => (await rows(sql`SELECT md5(string_agg(t::text, '|' ORDER BY id)) AS digest FROM fix_track_action_tokens t`))[0].digest;
    const securedSnapshot = async () => (await rows(sql`SELECT md5(string_agg(q::text, '|' ORDER BY id)) AS digest
      FROM contractor_email_queue q WHERE id IN (SELECT unnest(${pgArray([...securedIds])}::int[]))`))[0].digest;
    const stateBefore = await stateSnapshot();
    const actionsBefore = await actionSnapshot();
    const securedBefore = await securedSnapshot();

    const [legacyIndex] = await rows(sql`SELECT pg_get_expr(i.indpred, i.indrelid) AS predicate
      FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      WHERE c.relname = 'IDX_contractor_email_queue_legacy_credentials_v2'`);
    check("index: legacy-credential partial index exists", Boolean(legacyIndex?.predicate));

    // ── Hold row locks on every secured current-version draft ───────────────
    // If either pass touched (or merely locked) one of these rows it would
    // block; the passes must finish and nothing may ever wait on a lock.
    holder = await pool.connect();
    await holder.query("BEGIN");
    const held = await holder.query(`SELECT id FROM contractor_email_queue WHERE id = ANY($1::int[]) FOR UPDATE`, [[...securedIds]]);
    check("locks: holder owns every secured current-version row", held.rowCount === SECURED, String(held.rowCount));
    const waiting = async () => Number((await rows(sql`SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted`))[0].n);
    const lockWaits = [];
    // Fails as soon as any backend waits on a lock while a pass runs, i.e.
    // the pass tried to lock a secured row: a state check, not a time limit.
    const guard = async (label, work) => {
      let done = false;
      const watch = (async () => {
        while (!done) {
          if (await waiting() > 0) throw new Error(`${label} waited on a held row lock`);
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      })();
      try {
        return await Promise.race([work, watch]);
      } finally {
        done = true;
      }
    };

    // ── Scrub: interrupted after the third batch, then resumed ──────────────
    const scrubBatches = [];
    const onScrubBatch = async (batch) => {
      scrubBatches.push(batch);
      lockWaits.push(await waiting());
      if (scrubBatches.length === 3) throw new Error("simulated crash after batch 3");
    };
    let interrupted = null;
    try {
      await guard("scrub", scrubLegacyQueuedCredentials({ batchSize: 25, onBatchCommitted: onScrubBatch }));
    } catch (err) {
      interrupted = err;
    }
    check("scrub: interruption propagates", interrupted?.message === "simulated crash after batch 3", String(interrupted?.message));
    const remainingLegacy = async () => Number((await rows(sql`SELECT count(*)::int AS n FROM contractor_email_queue
      WHERE ${sql.raw(legacyIndex.predicate)}`))[0].n);
    const legacyTotal = PLAINTEXT + MIXED;
    check("scrub: the three committed batches stay committed", await remainingLegacy() === legacyTotal - 75, String(await remainingLegacy()));

    const resumed = [];
    const scrubbed = await guard("scrub resume", scrubLegacyQueuedCredentials({
      batchSize: 25,
      onBatchCommitted: async (batch) => { resumed.push(batch); lockWaits.push(await waiting()); },
    }));
    const allScrub = [...scrubBatches, ...resumed];
    const scrubIds = allScrub.flatMap((batch) => batch.ids);
    check("scrub: resume finishes the rest", scrubbed === legacyTotal - 75, String(scrubbed));
    check("scrub: deterministic batch count (3 + ceil(55/25))", resumed.length === Math.ceil((legacyTotal - 75) / 25), String(resumed.length));
    check("scrub: every batch within the bound", allScrub.every((batch) => batch.ids.length <= 25));
    check("scrub: only legacy candidates were selected (and locked)", scrubIds.every((id) => plaintextIds.has(id)));
    check("scrub: each candidate handled exactly once, in id order",
      scrubIds.length === legacyTotal && new Set(scrubIds).size === legacyTotal
        && resumed.flatMap((b) => b.ids).every((id, i, ids) => i === 0 || id > ids[i - 1]));

    // ── Re-encrypt: interrupted after the second batch, then resumed ────────
    const reencryptTotal = PREVIOUS + LEGACY_ENVELOPE; // mixed rows moved to NEW during the scrub
    const reBatches = [];
    interrupted = null;
    try {
      await guard("re-encrypt", reencryptQueuedTokenPayloads({
        batchSize: 25,
        onBatchCommitted: async (batch) => {
          reBatches.push(batch);
          lockWaits.push(await waiting());
          if (reBatches.length === 2) throw new Error("simulated crash after batch 2");
        },
      }));
    } catch (err) {
      interrupted = err;
    }
    check("re-encrypt: interruption propagates", interrupted?.message === "simulated crash after batch 2");
    const reResumed = [];
    const moved = await guard("re-encrypt resume", reencryptQueuedTokenPayloads({
      batchSize: 25,
      onBatchCommitted: async (batch) => { reResumed.push(batch); lockWaits.push(await waiting()); },
    }));
    const reIds = [...reBatches, ...reResumed].flatMap((batch) => batch.ids);
    check("re-encrypt: resume finishes the rest", moved === reencryptTotal - 50, String(moved));
    check("re-encrypt: deterministic batch count", reResumed.length === Math.ceil((reencryptTotal - 50) / 25), String(reResumed.length));
    check("re-encrypt: never selected a secured current-version row", reIds.every((id) => !securedIds.has(id)));
    check("re-encrypt: each candidate handled exactly once", reIds.length === reencryptTotal && new Set(reIds).size === reencryptTotal);
    check("locks: no backend ever waited on a lock between batches", lockWaits.every((n) => n === 0), JSON.stringify(lockWaits));

    await holder.query("ROLLBACK");
    holder.release();
    holder = null;

    // ── Results ─────────────────────────────────────────────────────────────
    check("secured current-version history untouched (ciphertext and updated_at)", await securedSnapshot() === securedBefore);
    check("queue state (status, expiry, approval, recipients) unchanged", await stateSnapshot() === stateBefore);
    check("action-token expiry and use state unchanged", await actionSnapshot() === actionsBefore);
    const [envelopes] = await rows(sql`SELECT
        count(*) FILTER (WHERE encrypted_token_payload LIKE ${`v2.${NEW.version}.%`})::int AS current,
        count(*) FILTER (WHERE encrypted_token_payload IS NOT NULL AND encrypted_token_payload NOT LIKE ${`v2.${NEW.version}.%`})::int AS other,
        count(*) FILTER (WHERE quote_token IS NOT NULL)::int AS raw_quote
      FROM contractor_email_queue`);
    check("every credential now on the current key", envelopes.other === 0 && envelopes.current === specs.length, JSON.stringify(envelopes));
    check("no raw quote_token column values remain", envelopes.raw_quote === 0);

    const after = new Map((await rows(sql`SELECT id, subject, body_html, body_text, email_preview_json, quote_token_hash, encrypted_token_payload
      FROM contractor_email_queue WHERE id IN (SELECT unnest(${pgArray([...plaintextIds])}::int[]))`)).map((row) => [Number(row.id), row]));
    let leaked = 0, hydrationMismatch = 0, digestMismatch = 0, payloadMismatch = 0;
    const leakedFields = new Set();
    for (const spec of plaintext) {
      const row = after.get(spec.id);
      const fields = { subject: row.subject, html: row.body_html, text: row.body_text ?? "", preview: JSON.stringify(row.email_preview_json) };
      for (const raw of Object.values(spec.tokens)) {
        for (const [field, value] of Object.entries(fields)) {
          if (value.includes(raw)) { leaked++; leakedFields.add(`${spec.variant}:${field}`); }
        }
      }
      const payload = decryptTokenPayload(row.encrypted_token_payload);
      const expected = { ...(spec.encryptedPayload ?? {}), ...spec.tokens };
      if (JSON.stringify(Object.entries(payload).sort()) !== JSON.stringify(Object.entries(expected).sort())) payloadMismatch++;
      if (fill(row.subject, payload) !== spec.subject || fill(row.body_html, payload) !== spec.html
        || fill(row.body_text, payload) !== spec.text
        || canonical(JSON.parse(fill(JSON.stringify(row.email_preview_json), payload))) !== canonical(spec.preview)) hydrationMismatch++;
      if (spec.tokens.quote && row.quote_token_hash !== digestBearerToken(spec.tokens.quote)) digestMismatch++;
    }
    check("bare-text tokens scrubbed from subject, HTML, text and preview JSON", leaked === 0, [...leakedFields].join(", "));
    check("payload holds exactly the original credentials (old-writer payload merged)", payloadMismatch === 0, String(payloadMismatch));
    check("hydration reproduces the delivered links and text exactly", hydrationMismatch === 0, String(hydrationMismatch));
    check("quote digests recorded for public lookup", digestMismatch === 0, String(digestMismatch));
    const anywhere = await rows(sql`SELECT count(*)::int AS n FROM contractor_email_queue q,
        unnest(${pgArray(plaintext.flatMap((spec) => Object.values(spec.tokens)))}::text[]) AS t(raw)
      WHERE position(t.raw in q.subject || q.body_html || coalesce(q.body_text, '') || q.email_preview_json::text) > 0`);
    check("no raw token anywhere in the queue", Number(anywhere[0].n) === 0);

    // ── Idempotent: a second run selects nothing ────────────────────────────
    const idle = [];
    check("idempotent: scrub selects no batch", await scrubLegacyQueuedCredentials({ onBatchCommitted: (b) => idle.push(b) }) === 0 && idle.length === 0);
    check("idempotent: re-encrypt selects no batch", await reencryptQueuedTokenPayloads({ onBatchCommitted: (b) => idle.push(b) }) === 0 && idle.length === 0);

    // ── Indexes serve the candidate predicates on restart ──────────────────────────────
    // Steady state, i.e. an ordinary restart: with nothing left to do, the
    // planner reads the candidate indexes instead of every draft.
    await db.execute(sql`ANALYZE contractor_email_queue`);
    const explain = async (query) => (await rows(query)).map((row) => row["QUERY PLAN"]).join("\n");
    const scrubPlan = await explain(sql`EXPLAIN SELECT id FROM contractor_email_queue
      WHERE id > 0 AND ${sql.raw(legacyIndex.predicate)} ORDER BY id LIMIT 25 FOR UPDATE`);
    check("index: scrub candidates come from the partial index", scrubPlan.includes("IDX_contractor_email_queue_legacy_credentials_v2"), scrubPlan);
    const keyExpr = sql.raw(`(split_part(encrypted_token_payload, '.', 1) || '.' || split_part(encrypted_token_payload, '.', 2))`);
    const reencryptPlan = await explain(sql`EXPLAIN SELECT id FROM contractor_email_queue
      WHERE id > 0 AND encrypted_token_payload IS NOT NULL
        AND (${keyExpr} < ${`v2.${NEW.version}`} OR ${keyExpr} > ${`v2.${NEW.version}`})
      ORDER BY id LIMIT 25 FOR UPDATE`);
    check("index: re-encrypt candidates come from the envelope-key index", reencryptPlan.includes("IDX_contractor_email_queue_envelope_key"), reencryptPlan);

    // ── An old writer adds legacy rows after the migration ──────────────────
    const late = token();
    const [lateRow] = await rows(sql`INSERT INTO contractor_email_queue
      (client_id, issue_id, entity_type, entity_id, mode, email_type, status, to_email, subject, body_html, body_text,
       cc_json, email_preview_json, idempotency_key, quote_token)
      VALUES (${client.id}, ${issue.id}, 'fix_track', 1, 'assign', 'assignment', 'pending', 'late@contractor.test',
        ${`Quote ${late}`}, ${`<a href="${APP}/contractor-quote/${late}">Quote</a>`}, ${null}, '[]'::jsonb,
        ${JSON.stringify({ link: `${APP}/contractor-quote/${late}` })}::jsonb, ${`${tag}-late`}, ${late})
      RETURNING id`);
    const lateOld = await rows(sql`INSERT INTO contractor_email_queue
      (client_id, issue_id, entity_type, entity_id, mode, email_type, status, to_email, subject, body_html,
       cc_json, email_preview_json, idempotency_key, encrypted_token_payload)
      VALUES (${client.id}, ${issue.id}, 'fix_track', 2, 'assign', 'assignment', 'pending', 'late2@contractor.test',
        'Quote', '<p>{{QUOTE_TOKEN}}</p>', '[]'::jsonb, '{}'::jsonb, ${`${tag}-late-old`}, ${seal({ quote: token() }, OLD)})
      RETURNING id`);
    const lateBatches = [];
    const lateScrubbed = await scrubLegacyQueuedCredentials({ onBatchCommitted: (b) => lateBatches.push(b) });
    check("old writer: the late plaintext draft is the only scrub candidate",
      lateScrubbed === 1 && lateBatches.length === 1 && lateBatches[0].ids.join() === String(lateRow.id));
    const lateMoved = [];
    check("old writer: the late previous-key draft is the only re-encrypt candidate",
      await reencryptQueuedTokenPayloads({ onBatchCommitted: (b) => lateMoved.push(...b.ids) }) === 1 && lateMoved.join() === String(lateOld[0].id));

    // ── Sweep for credentials kept as bare text ─────────────────────────────
    // No SQL predicate can see a credential that appears without its URL; the
    // sweep finds them by decrypting in memory, locks only those rows, and
    // records a high-water mark so each draft is examined at most once.
    const [sweepState] = await rows(sql`SELECT last_id FROM runtime_migration_progress WHERE name='contractor_queue_bare_credentials_v1'`);
    check("sweep: progress row created by startup", sweepState != null);
    const bare = [];
    for (let i = 0; i < 6; i++) {
      const raw = token();
      const html = `<p>Your quote reference is ${raw}</p>`;
      const [row] = await rows(sql`INSERT INTO contractor_email_queue
        (client_id, issue_id, entity_type, entity_id, mode, email_type, status, to_email, subject, body_html,
         cc_json, email_preview_json, idempotency_key, encrypted_token_payload)
        VALUES (${client.id}, ${issue.id}, 'fix_track', ${500 + i}, 'quote', 'quote_request', 'sent', ${`bare${i}@contractor.test`},
          'Quote', ${html}, '[]'::jsonb, ${JSON.stringify({ html })}::jsonb, ${`${tag}-bare-${i}`}, ${seal({ quote: raw }, NEW)})
        RETURNING id`);
      bare.push({ id: Number(row.id), raw });
    }
    const bareIds = new Set(bare.map((b) => b.id));
    // Rewind the mark: the whole history is examined, as on a first upgrade.
    await db.execute(sql`UPDATE runtime_migration_progress SET last_id=0 WHERE name='contractor_queue_bare_credentials_v1'`);
    holder = await pool.connect();
    await holder.query("BEGIN");
    await holder.query(`SELECT id FROM contractor_email_queue WHERE id = ANY($1::int[]) FOR UPDATE`, [[...securedIds]]);
    const sweepBatches = [];
    interrupted = null;
    try {
      await guard("sweep", sweepPlainTextQueuedCredentials({
        batchSize: 300,
        onBatchCommitted: async (batch) => {
          sweepBatches.push(batch);
          if (sweepBatches.length === 2) throw new Error("simulated crash after sweep batch 2");
        },
      }));
    } catch (err) {
      interrupted = err;
    }
    check("sweep: interruption propagates", interrupted?.message === "simulated crash after sweep batch 2", String(interrupted?.message));
    const [midway] = await rows(sql`SELECT last_id FROM runtime_migration_progress WHERE name='contractor_queue_bare_credentials_v1'`);
    const [maxRow] = await rows(sql`SELECT max(id)::int AS max FROM contractor_email_queue`);
    check("sweep: progress recorded per batch", Number(midway.last_id) > 0 && Number(midway.last_id) < Number(maxRow.max), JSON.stringify(midway));
    const resumedSweep = [];
    await guard("sweep resume", sweepPlainTextQueuedCredentials({ batchSize: 300, onBatchCommitted: (batch) => resumedSweep.push(batch) }));
    await holder.query("ROLLBACK");
    holder.release();
    holder = null;
    const sweptIds = [...sweepBatches, ...resumedSweep].flatMap((b) => b.ids);
    check("sweep: only rows with a bare credential were locked and rewritten",
      sweptIds.length === bare.length && sweptIds.every((id) => bareIds.has(id)), JSON.stringify(sweptIds));
    check("sweep: resumed after the last recorded batch, without redoing it",
      resumedSweep.every((b) => b.ids.every((id) => !sepIds(sweepBatches).has(id))));
    const sweptRows = await rows(sql`SELECT id, body_html, email_preview_json::text AS preview, encrypted_token_payload
      FROM contractor_email_queue WHERE id IN (SELECT unnest(${pgArray([...bareIds])}::int[]))`);
    check("sweep: bare credentials replaced by placeholders",
      sweptRows.every((r) => !bare.some((b) => r.body_html.includes(b.raw) || r.preview.includes(b.raw)) && r.body_html.includes("{{QUOTE_TOKEN}}")));
    check("sweep: hydration still yields the original text",
      sweptRows.every((r) => fill(r.body_html, decryptTokenPayload(r.encrypted_token_payload)) === `<p>Your quote reference is ${bare.find((b) => b.id === Number(r.id)).raw}</p>`));
    check("sweep: secured history untouched", await securedSnapshot() === securedBefore);
    const again = [];
    check("sweep: a second run examines nothing already seen",
      await sweepPlainTextQueuedCredentials({ onBatchCommitted: (b) => again.push(b) }) === 0 && again.length === 0);
    // A draft written after the mark (e.g. by an older writer) is examined on the next start.
    const lateRaw = token();
    const [lateBare] = await rows(sql`INSERT INTO contractor_email_queue
      (client_id, issue_id, entity_type, entity_id, mode, email_type, status, to_email, subject, body_html,
       cc_json, email_preview_json, idempotency_key, encrypted_token_payload)
      VALUES (${client.id}, ${issue.id}, 'fix_track', 599, 'quote', 'quote_request', 'sent', 'late-bare@contractor.test',
        ${`Ref ${lateRaw}`}, '<p>Quote</p>', '[]'::jsonb, '{}'::jsonb, ${`${tag}-late-bare`}, ${seal({ quote: lateRaw }, NEW)})
      RETURNING id`);
    const lateSweep = [];
    await sweepPlainTextQueuedCredentials({ onBatchCommitted: (b) => lateSweep.push(...b.ids) });
    check("sweep: a newer draft with a bare credential is caught next time",
      lateSweep.join() === String(lateBare.id)
        && !(await rows(sql`SELECT subject FROM contractor_email_queue WHERE id=${lateBare.id}`))[0].subject.includes(lateRaw));

    // ── The full startup path completes on this history ─────────────────────
    await runRuntimeMigrations();
    check("startup: no legacy candidates remain", await remainingLegacy() === 0);
    check("startup: secured history still untouched", await securedSnapshot() === securedBefore);
  } finally {
    // Releasing the locks lets a blocked pass finish so the pool can close.
    if (holder) await holder.query("ROLLBACK").then(() => holder.release(), () => holder.release(true));
    await pool.end().catch(() => {});
    await rm(outDir, { recursive: true, force: true });
  }
  console.log(`${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exit(1);
}

main().catch((err) => {
  console.error(err?.cause ? `${String(err.message).split("\n")[0]}\ncause: ${err.cause.message} ${err.cause.detail ?? ""}` : err);
  process.exit(1);
});
