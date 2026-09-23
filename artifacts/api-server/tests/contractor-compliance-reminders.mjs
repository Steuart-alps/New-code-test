// Contractor compliance-expiry reminder job integration tests.
//
// Seeds a client with contractors at various insurance/DBS states, runs the
// real runContractorComplianceReminderJob with a fake email sender injected,
// and verifies:
//   - each client's configured warning window controls expiry alerts
//   - an absent setting preserves the 30-day default and exact boundaries
//   - insurance expiring outside the configured window is NOT alerted
//   - an expired DBS/PVG record and a check older than 3 years are alerted
//   - only client_admin / maintenance-manager users are emailed
//   - a second run sends nothing (dedupe by contractor+milestone)
//   - renewing the insurance date produces a new milestone and re-alerts
//
// Usage: node tests/contractor-compliance-reminders.mjs   (DATABASE_URL must be set)
// Exits 0 when every check passes, 1 otherwise.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { build } from "esbuild";
import crypto from "node:crypto";

const testsDir = path.dirname(fileURLToPath(import.meta.url));

let passed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed++;
  } else {
    failures.push(`${name} — ${detail}`);
    console.error(`FAIL: ${name} — ${detail}`);
  }
}

async function bundleEntry() {
  const outDir = await mkdtemp(path.join(testsDir, ".build-"));
  const outFile = path.join(outDir, "entry.mjs");
  await build({
    entryPoints: [path.join(testsDir, "contractor-compliance-reminders.entry.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: outFile,
    logLevel: "silent",
    external: ["pg-native", "pino", "pino-pretty", "resend", "@google-cloud/*", "nodemailer"],
    banner: {
      js: `import { createRequire as __bannerCrReq } from 'node:module';\nglobalThis.require = __bannerCrReq(import.meta.url);`,
    },
  });
  return { outDir, outFile };
}

function daysFromNow(days) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}
function pathToUrl(p) {
  return new URL(`file://${p}`).href;
}

async function main() {
  const { outDir, outFile } = await bundleEntry();
  const lib = await import(pathToUrl(outFile));
  const {
    runContractorComplianceReminderJob, getContractorComplianceAlerts,
    DEFAULT_CONTRACTOR_COMPLIANCE_LEAD_DAYS, MIN_CONTRACTOR_COMPLIANCE_LEAD_DAYS,
    MAX_CONTRACTOR_COMPLIANCE_LEAD_DAYS, parseContractorComplianceLeadDays,
    runRuntimeMigrations, reencryptQueuedTokenPayloads,
    encryptTokenPayload, decryptTokenPayload, tokenPayloadNeedsReencryption,
    db, pool, clientsTable, usersTable, contractorsTable, fixTrackIssuesTable, sql,
  } = lib;

  const tag = `contractorcompl-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  let clientId = null;

  async function seedContractor(label, fields) {
    const [row] = await db
      .insert(contractorsTable)
      .values({
        clientId,
        name: `Contractor ${label}`,
        email: `${tag}-${label}@test.local`,
        ...fields,
      })
      .returning();
    return row;
  }

  try {
    const [client] = await db
      .insert(clientsTable)
      .values({ name: `Contractor Compliance Test ${tag}`, slug: tag, active: true })
      .returning();
    clientId = client.id;

    // Managers who should be emailed.
    const [admin] = await db
      .insert(usersTable)
      .values({
        email: `${tag}-admin@test.local`,
        passwordHash: "x",
        name: "Admin",
        role: "client_admin",
        clientId,
        active: true,
      })
      .returning();
    // A viewer who must NOT be emailed.
    await db
      .insert(usersTable)
      .values({
        email: `${tag}-viewer@test.local`,
        passwordHash: "x",
        name: "Viewer",
        role: "viewer",
        clientId,
        active: true,
      })
      .returning();

    const insSoon = await seedContractor("ins-soon", { publicLiabilityExpiry: daysFromNow(10) });
    const insExpired = await seedContractor("ins-expired", { publicLiabilityExpiry: daysFromNow(-5) });
    const insFar = await seedContractor("ins-far", { publicLiabilityExpiry: daysFromNow(200) });
    const insConfiguredWindow = await seedContractor("ins-configured-window", {
      publicLiabilityExpiry: daysFromNow(60),
    });
    // These fixed dates keep boundary checks independent from the test's runtime clock.
    const defaultBoundary = await seedContractor("ins-default-boundary", {
      publicLiabilityExpiry: new Date("2030-01-31T00:00:00.000Z"),
    });
    const defaultOutside = await seedContractor("ins-default-outside", {
      publicLiabilityExpiry: new Date("2030-02-01T00:00:00.000Z"),
    });
    const configuredBoundary = await seedContractor("ins-configured-boundary", {
      publicLiabilityExpiry: new Date("2030-04-01T00:00:00.000Z"),
    });
    const configuredOutside = await seedContractor("ins-configured-outside", {
      publicLiabilityExpiry: new Date("2030-04-02T00:00:00.000Z"),
    });
    const dbsOld = await seedContractor("dbs-old", {});
    const dbsRecent = await seedContractor("dbs-recent", {});
    const dbsStaleCheck = await seedContractor("dbs-stale-check", {
      dbsCheckDate: daysFromNow(-(3 * 365 + 10)),
    });
    const dbsCurrentCheck = await seedContractor("dbs-current-check", {
      dbsCheckDate: daysFromNow(-300),
    });
    // dbs_expiry_date is a runtime-migrated column not yet represented by the
    // shared Drizzle schema, so seed it explicitly.
    await db.execute(sql`UPDATE contractors SET dbs_expiry_date = ${daysFromNow(-10)} WHERE id = ${dbsOld.id}`);
    await db.execute(sql`UPDATE contractors SET dbs_expiry_date = ${daysFromNow(200)} WHERE id = ${dbsRecent.id}`);
    await db.execute(sql`
      INSERT INTO app_settings (client_id, key, value)
      VALUES (${clientId}, 'contractorComplianceLeadTimeDays', '90')
      ON CONFLICT (client_id, key) DO UPDATE SET value = EXCLUDED.value
    `);

    check("lead-time parser accepts the inclusive boundaries",
      parseContractorComplianceLeadDays(String(MIN_CONTRACTOR_COMPLIANCE_LEAD_DAYS)) === MIN_CONTRACTOR_COMPLIANCE_LEAD_DAYS
        && parseContractorComplianceLeadDays(String(MAX_CONTRACTOR_COMPLIANCE_LEAD_DAYS)) === MAX_CONTRACTOR_COMPLIANCE_LEAD_DAYS,
      "inclusive lead-time bounds were rejected");
    check("lead-time parser rejects values outside the inclusive boundaries",
      parseContractorComplianceLeadDays(String(MIN_CONTRACTOR_COMPLIANCE_LEAD_DAYS - 1)) === null
        && parseContractorComplianceLeadDays(String(MAX_CONTRACTOR_COMPLIANCE_LEAD_DAYS + 1)) === null
        && parseContractorComplianceLeadDays("1.5") === null
        && parseContractorComplianceLeadDays("") === null,
      "out-of-range or fractional lead time was accepted");

    const defaultBoundaryAlerts = await getContractorComplianceAlerts(
      clientId,
      new Date("2030-01-01T00:00:00.000Z"),
    );
    check("missing setting preserves the 30-day default boundary",
      DEFAULT_CONTRACTOR_COMPLIANCE_LEAD_DAYS === 30
        && defaultBoundaryAlerts.some((alert) => alert.contractorId === defaultBoundary.id)
        && !defaultBoundaryAlerts.some((alert) => alert.contractorId === defaultOutside.id),
      "default window did not include exactly 30 days and exclude day 31");
    const configuredBoundaryAlerts = await getContractorComplianceAlerts(
      clientId,
      new Date("2030-01-01T12:00:00.000Z"),
      90,
    );
    check("configured lead-time includes its exact boundary and excludes the next day",
      configuredBoundaryAlerts.some((alert) => alert.contractorId === configuredBoundary.id)
        && !configuredBoundaryAlerts.some((alert) => alert.contractorId === configuredOutside.id),
      "configured window boundary was incorrect");

    // --- Run 1 ---
    const sent = [];
    const pushes = [];
    const fakeSend = async ({ to, subject, html }) => { sent.push({ to, subject, html }); };
    const fakePush = async (userIds, payload) => {
      pushes.push({ userIds, payload });
      return userIds.length;
    };
    const r1 = await runContractorComplianceReminderJob(fakeSend, fakePush);

    check("run1: client alerted once", r1.clientsAlerted === 1, `clientsAlerted=${r1.clientsAlerted}`);
    check("run1: single digest email captured", sent.length === 1, `captured=${sent.length}`);
    check(
      "run1: five reminders claimed using the client's 90-day window",
      r1.remindersClaimed === 5,
      `remindersClaimed=${r1.remindersClaimed}`,
    );

    const html = sent[0]?.html ?? "";
    check("run1: ins-soon included", html.includes(insSoon.name), "missing ins-soon");
    check("run1: ins-expired included", html.includes(insExpired.name), "missing ins-expired");
    check("run1: configured-window insurance included", html.includes(insConfiguredWindow.name), "missing configured-window insurance");
    check("run1: dbs-old included", html.includes(dbsOld.name), "missing dbs-old");
    check("run1: stale DBS check included", html.includes(dbsStaleCheck.name), "missing dbs-stale-check");
    check("run1: ins-far NOT included", !html.includes(insFar.name), "ins-far wrongly included");
    check("run1: dbs-recent NOT included", !html.includes(dbsRecent.name), "dbs-recent wrongly included");
    check("run1: current DBS check NOT included", !html.includes(dbsCurrentCheck.name), "dbs-current-check wrongly included");

    const recipients = sent[0]?.to ?? [];
    check("run1: admin emailed", recipients.includes(admin.email), `recipients=${JSON.stringify(recipients)}`);
    check(
      "run1: viewer not emailed",
      !recipients.includes(`${tag}-viewer@test.local`),
      `recipients=${JSON.stringify(recipients)}`,
    );
    check(
      "run1: manager receives one matching mobile push",
      pushes.length === 1
        && pushes[0].userIds.includes(admin.id)
        && pushes[0].payload.data?.route === "/contractors"
        && pushes[0].payload.body.includes("5 contractor compliance items"),
      JSON.stringify(pushes),
    );
    const queuedResult = await db.execute(sql`
      SELECT status, email_type, to_email, body_html, body_text, email_preview_json,
             quote_token, encrypted_token_payload
      FROM contractor_email_queue
      WHERE client_id = ${clientId} AND entity_type = 'contractor_compliance'
      ORDER BY id
    `);
    const queued = queuedResult.rows;
    check("run1: contractor reminders wait for manager approval",
      queued.length === 5 && queued.every((row) => row.status === "pending" && row.email_type === "reminder"),
      JSON.stringify(queued));
    check("run1: contractor reminders do not bypass the approval queue",
      queued.every((row) => !recipients.includes(row.to_email)),
      `recipients=${JSON.stringify(recipients)}`);
    check("run1: every persisted reminder field is bearer-free",
      queued.every((row) => {
        const persisted = JSON.stringify(row);
        return row.quote_token == null
          && !/\/(?:api\/fix-track\/action|contractor-quote|contractor-portal)\/[a-z0-9-]{32,}/i.test(persisted)
          && persisted.includes("{{PORTAL_URL}}")
          && typeof row.encrypted_token_payload === "string";
      }), JSON.stringify(queued));

    // Regression for the partially-migrated shape: ciphertext and a NULL legacy
    // token column existed, but rendered fields could still contain plaintext.
    const legacyActionToken = "b".repeat(64);
    const legacyActionUrl = `https://example.test/api/fix-track/action/${legacyActionToken}`;
    const [legacyIssue] = await db.insert(fixTrackIssuesTable).values({
      clientId, title: "Legacy migration issue", location: "Plant room",
      reportedBy: "Test", reportedDate: new Date().toISOString().slice(0, 10),
    }).returning();
    await db.execute(sql`INSERT INTO fix_track_action_tokens
      (token,token_hash,issue_id,client_id,contractor_id,action,expires_at)
      VALUES (NULL,${crypto.createHash("sha256").update(legacyActionToken).digest("hex")},
        ${legacyIssue.id},${clientId},${insSoon.id},'booked',now()+interval '30 days')`);
    const legacyQueue = (await db.execute(sql`
      SELECT id, encrypted_token_payload FROM contractor_email_queue
      WHERE client_id=${clientId} AND entity_type='contractor_compliance'
      ORDER BY id LIMIT 1
    `)).rows[0];
    const legacyQueueId = legacyQueue?.id;
    const legacyPortalUrl = decryptTokenPayload(legacyQueue.encrypted_token_payload).portal;
    const legacyPortalToken = legacyPortalUrl.split("/").pop();
    await db.execute(sql`UPDATE contractor_email_queue SET
      subject=${`Credential ${legacyPortalUrl}`},
      body_text=${`Open ${legacyPortalUrl} and ${legacyActionUrl}`},
      email_preview_json=${JSON.stringify({ subject: `Credential ${legacyActionUrl}`, text: legacyPortalUrl })}::jsonb,
      issue_id=${legacyIssue.id}, entity_id=${legacyIssue.id}, entity_type='fix_track',
      quote_token=NULL
      WHERE id=${legacyQueueId}`);
    await runRuntimeMigrations();
    await runRuntimeMigrations();
    const migrated = (await db.execute(sql`SELECT subject,body_html,body_text,email_preview_json,
      quote_token,encrypted_token_payload FROM contractor_email_queue WHERE id=${legacyQueueId}`)).rows[0];
    const migratedFields = JSON.stringify(migrated);
    const migratedPayload = decryptTokenPayload(migrated.encrypted_token_payload);
    const hydratedFields = migratedFields
      .replaceAll("{{PORTAL_URL}}", migratedPayload.portal)
      .replaceAll("{{BOOKED_TOKEN}}", migratedPayload.booked);
    check("migration rerun scrubs encrypted/null-token queue rows including subject",
      migrated.quote_token == null
        && !migratedFields.includes(legacyPortalToken)
        && !migratedFields.includes(legacyActionToken)
        && migratedFields.includes("{{PORTAL_URL}}")
        && migratedFields.includes("{{BOOKED_TOKEN}}")
        && migratedPayload.portal === legacyPortalUrl
        && migratedPayload.booked === legacyActionToken,
      migratedFields);
    check("migrated placeholders hydrate to the original links without duplicated prefixes",
      hydratedFields.includes(legacyPortalUrl)
        && hydratedFields.includes(legacyActionUrl)
        && !hydratedFields.includes(`/contractor-portal/https://`),
      hydratedFields);

    const originalCurrentKey = process.env.CONTRACTOR_TOKEN_ENCRYPTION_KEY;
    const originalKeyVersion = process.env.CONTRACTOR_TOKEN_ENCRYPTION_KEY_VERSION;
    const originalPreviousKeys = process.env.CONTRACTOR_TOKEN_ENCRYPTION_PREVIOUS_KEYS;
    let keyV3;
    try {
      const sourceVersion = String(migrated.encrypted_token_payload).split(".")[1];
      const sourceSecret = originalCurrentKey ?? process.env.SESSION_SECRET;
      const keyV2 = crypto.randomBytes(32).toString("base64url");
      process.env.CONTRACTOR_TOKEN_ENCRYPTION_KEY = keyV2;
      process.env.CONTRACTOR_TOKEN_ENCRYPTION_KEY_VERSION = "rotation-v2";
      process.env.CONTRACTOR_TOKEN_ENCRYPTION_PREVIOUS_KEYS = sourceVersion === "session-v1"
        ? JSON.stringify({})
        : JSON.stringify({ [sourceVersion]: sourceSecret });
      check("database migration rewrites a queued draft onto the first dedicated key",
        await reencryptQueuedTokenPayloads(legacyQueueId) === 1);
      const rotatedV2 = (await db.execute(sql`SELECT encrypted_token_payload
        FROM contractor_email_queue WHERE id=${legacyQueueId}`)).rows[0]?.encrypted_token_payload;
      check("database ciphertext records the configured dedicated key version",
        String(rotatedV2).startsWith("v2.rotation-v2.")
          && !tokenPayloadNeedsReencryption(rotatedV2)
          && decryptTokenPayload(rotatedV2).portal === legacyPortalUrl);
      check("database re-encryption is idempotent", await reencryptQueuedTokenPayloads(legacyQueueId) === 0);

      keyV3 = crypto.randomBytes(32).toString("base64url");
      process.env.CONTRACTOR_TOKEN_ENCRYPTION_KEY = keyV3;
      process.env.CONTRACTOR_TOKEN_ENCRYPTION_KEY_VERSION = "rotation-v3";
      process.env.CONTRACTOR_TOKEN_ENCRYPTION_PREVIOUS_KEYS = JSON.stringify({
        "rotation-v2": keyV2,
      });
      check("the next database rotation reads the retained previous key",
        await reencryptQueuedTokenPayloads(legacyQueueId) === 1);
      const rotatedV3 = (await db.execute(sql`SELECT encrypted_token_payload
        FROM contractor_email_queue WHERE id=${legacyQueueId}`)).rows[0]?.encrypted_token_payload;
      delete process.env.CONTRACTOR_TOKEN_ENCRYPTION_PREVIOUS_KEYS;
      check("draft stays decryptable after re-encryption and retirement of the previous key",
        String(rotatedV3).startsWith("v2.rotation-v3.")
          && decryptTokenPayload(rotatedV3).booked === legacyActionToken);
    } finally {
      if (keyV3) {
        if (originalCurrentKey === undefined) delete process.env.CONTRACTOR_TOKEN_ENCRYPTION_KEY;
        else process.env.CONTRACTOR_TOKEN_ENCRYPTION_KEY = originalCurrentKey;
        if (originalKeyVersion === undefined) delete process.env.CONTRACTOR_TOKEN_ENCRYPTION_KEY_VERSION;
        else process.env.CONTRACTOR_TOKEN_ENCRYPTION_KEY_VERSION = originalKeyVersion;
        const restoredPrevious = originalPreviousKeys ? JSON.parse(originalPreviousKeys) : {};
        restoredPrevious["rotation-v3"] = keyV3;
        process.env.CONTRACTOR_TOKEN_ENCRYPTION_PREVIOUS_KEYS = JSON.stringify(restoredPrevious);
        await reencryptQueuedTokenPayloads(legacyQueueId);
      }
      if (originalCurrentKey === undefined) delete process.env.CONTRACTOR_TOKEN_ENCRYPTION_KEY;
      else process.env.CONTRACTOR_TOKEN_ENCRYPTION_KEY = originalCurrentKey;
      if (originalKeyVersion === undefined) delete process.env.CONTRACTOR_TOKEN_ENCRYPTION_KEY_VERSION;
      else process.env.CONTRACTOR_TOKEN_ENCRYPTION_KEY_VERSION = originalKeyVersion;
      if (originalPreviousKeys === undefined) delete process.env.CONTRACTOR_TOKEN_ENCRYPTION_PREVIOUS_KEYS;
      else process.env.CONTRACTOR_TOKEN_ENCRYPTION_PREVIOUS_KEYS = originalPreviousKeys;
    }

    // --- Run 2: dedupe, nothing new ---
    sent.length = 0;
    pushes.length = 0;
    const r2 = await runContractorComplianceReminderJob(fakeSend, fakePush);
    check("run2: nothing re-sent", r2.remindersClaimed === 0 && sent.length === 0 && pushes.length === 0, `claimed=${r2.remindersClaimed}, captured=${sent.length}, pushes=${pushes.length}`);

    // --- Renew insurance → new milestone → re-alert ---
    await db.execute(sql`
      UPDATE contractors SET public_liability_expiry = ${daysFromNow(15)} WHERE id = ${insSoon.id}
    `);
    sent.length = 0;
    const r3 = await runContractorComplianceReminderJob(fakeSend, fakePush);
    check(
      "run3: renewed insurance re-alerts (new milestone)",
      r3.remindersClaimed === 1 && sent.length === 1,
      `claimed=${r3.remindersClaimed}, captured=${sent.length}`,
    );
  } finally {
    try {
      if (clientId != null) {
        await db.execute(sql`DELETE FROM contractor_compliance_reminder_log WHERE client_id = ${clientId}`);
        await db.execute(sql`DELETE FROM contractors WHERE client_id = ${clientId}`);
        await db.execute(sql`DELETE FROM users WHERE client_id = ${clientId}`);
        await db.execute(sql`DELETE FROM clients WHERE id = ${clientId}`);
      }
    } catch (err) {
      console.error("Cleanup failed:", err);
      failures.push(`cleanup — ${err?.message ?? err}`);
    }
    await rm(outDir, { recursive: true, force: true }).catch(() => {});
    await pool.end().catch(() => {});
  }

  console.log(`\n${passed} checks passed, ${failures.length} failed.`);
  if (failures.length > 0) {
    console.error("\nFailures:");
    for (const f of failures) console.error(` - ${f}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Test run crashed:", err);
  process.exit(1);
});
