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
import { buildOwnedFixturePurgeSql, resolveRunId } from "./fixture-ownership.mjs";

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

  // The run id is in the client slug and every user email, so cleanup can
  // prove ownership and never touches another run's (or tenant's) rows.
  const runId = resolveRunId();
  const tag = `contractorcompl-${runId}`;
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
      queued.length === 4 && queued.every((row) => row.status === "pending" && row.email_type === "reminder"),
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

    // Explicit DBS expiry and each contractor certificate get separate 60-
    // and 30-day milestones; a rerun within either window must be idempotent.
    let today = new Date();
    const expiry55 = daysFromNow(55);
    const dbsDue = await seedContractor("dbs-due", {
      dbsType: "Enhanced", dbsExpiryDate: expiry55,
    });
    await seedContractor("dbs-none", { dbsType: "None", dbsExpiryDate: expiry55 });
    const certOwner = await seedContractor("cert-due", {});
    const insertedCert = await db.execute(sql`
      INSERT INTO contractor_certificates
        (client_id, contractor_id, certificate_name, issuer, completed_date, expiry_date, notes)
      VALUES (${clientId}, ${certOwner.id}, 'IPAF', 'Test issuer', ${daysFromNow(-100)}, ${expiry55}, 'Test')
      RETURNING id
    `);
    const certId = insertedCert.rows[0].id;
    today = new Date(); // Certificate insert may touch the parent updated_at.
    const initialAlerts = await getContractorComplianceAlerts(clientId, today, 90);
    check("DBS expiry enters 60-day window", initialAlerts.some(a =>
      a.contractorId === dbsDue.id && a.milestone.endsWith(":60")), "DBS 60-day reminder missing");
    check("certificate expiry enters 60-day window", initialAlerts.some(a =>
      a.contractorId === certOwner.id && a.milestone === `cert:${certId}:${expiry55.toISOString().slice(0, 10)}:60`),
    "certificate 60-day reminder missing");
    check("DBS type None does not alert", !initialAlerts.some(a =>
      a.contractorName.includes("dbs-none")), "None was treated as a DBS check");

    sent.length = 0;
    const at60 = await runContractorComplianceReminderJob(fakeSend, fakePush, today);
    check("60-day manager digest includes DBS and certificate", at60.remindersClaimed === 2
      && sent[0]?.html.includes(dbsDue.name) && sent[0]?.html.includes("IPAF"),
    `claimed=${at60.remindersClaimed}`);
    const portal60 = (await db.execute(sql`
      SELECT contractor_id,milestone FROM contractor_compliance_reminder_log
      WHERE client_id=${clientId} AND milestone LIKE 'portal-60d:%'
    `)).rows;
    check("portal 60-day insurance, DBS and certificate claims are separate",
      portal60.some(r => r.contractor_id === insConfiguredWindow.id && r.milestone.startsWith("portal-60d:insurance:"))
        && portal60.some(r => r.contractor_id === certOwner.id && r.milestone === `portal-60d:cert:${certId}:${expiry55.toISOString().slice(0, 10)}`)
        && portal60.some(r => r.contractor_id === dbsDue.id && r.milestone.startsWith("portal-60d:dbs:")),
      JSON.stringify(portal60));
    const again60 = await runContractorComplianceReminderJob(fakeSend, fakePush, today);
    check("60-day milestone is deduplicated", again60.remindersClaimed === 0,
      `claimed=${again60.remindersClaimed}`);
    const certDraft60 = (await db.execute(sql`
      SELECT id, encrypted_token_payload FROM contractor_email_queue
      WHERE client_id=${clientId} AND contractor_id=${certOwner.id} AND status='pending'
    `)).rows[0];
    const oldCertToken = (await db.execute(sql`
      SELECT token_hash FROM contractor_portal_tokens WHERE contractor_id=${certOwner.id}
    `)).rows[0]?.token_hash;
    const thirtyDayRun = new Date(today.getTime() + 25 * 86_400_000);
    const at30 = await runContractorComplianceReminderJob(fakeSend, fakePush, thirtyDayRun);
    check("30-day DBS and certificate reminders are distinct", at30.remindersClaimed === 2,
      `claimed=${at30.remindersClaimed}`);
    const again30 = await runContractorComplianceReminderJob(fakeSend, fakePush, thirtyDayRun);
    check("30-day milestone is deduplicated", again30.remindersClaimed === 0,
      `claimed=${again30.remindersClaimed}`);
    const portal30 = (await db.execute(sql`
      SELECT contractor_id,milestone FROM contractor_compliance_reminder_log
      WHERE client_id=${clientId} AND milestone LIKE 'portal-30d:%'
    `)).rows;
    const certTimes = (await db.execute(sql`
      SELECT c.updated_at, l.sent_at FROM contractors c
      JOIN contractor_compliance_reminder_log l ON l.contractor_id=c.id
      WHERE c.id=${certOwner.id} AND l.milestone=${`portal-60d:cert:${certId}:${expiry55.toISOString().slice(0, 10)}`}
    `)).rows[0];
    check("30-day portal reminder catches insurance and certificate independently",
      portal30.some(r => r.contractor_id === certOwner.id && r.milestone === `portal-30d:cert:${certId}:${expiry55.toISOString().slice(0, 10)}`)
        && portal30.some(r => r.contractor_id === dbsDue.id && r.milestone.startsWith("portal-30d:dbs:"))
        && portal30.some(r => r.contractor_id === insSoon.id && r.milestone.startsWith("portal-30d:insurance:")),
      JSON.stringify({ portal30, certTimes }));
    const certDrafts = (await db.execute(sql`
      SELECT status, encrypted_token_payload, body_html, email_preview_json, idempotency_key
      FROM contractor_email_queue WHERE client_id=${clientId}
        AND contractor_id=${certOwner.id} ORDER BY id
    `)).rows;
    const newCertToken = (await db.execute(sql`
      SELECT token_hash FROM contractor_portal_tokens WHERE contractor_id=${certOwner.id}
    `)).rows[0]?.token_hash;
    check("replacement supersedes pending draft without rotating canonical bearer",
      certDrafts.length === 2 && certDrafts[0].status === "cancelled"
        && certDrafts[1].status === "pending" && oldCertToken === newCertToken
        && certDrafts.every(r => r.body_html.includes("{{PORTAL_URL}}")
          && JSON.stringify(r.email_preview_json).includes("{{PORTAL_URL}}")
          && !JSON.stringify(r).includes(decryptTokenPayload(r.encrypted_token_payload).portal)),
      JSON.stringify(certDrafts));
    const rerunToken = (await db.execute(sql`
      SELECT token_hash FROM contractor_portal_tokens WHERE contractor_id=${certOwner.id}
    `)).rows[0]?.token_hash;
    check("duplicate portal run does not rotate token",
      newCertToken === rerunToken && certDraft60.id != null);

    const manualOwner = await seedContractor("manual-link", { publicLiabilityExpiry: daysFromNow(55) });
    const revokedOwner = await seedContractor("revoked-link", { publicLiabilityExpiry: daysFromNow(55) });
    const manualToken = crypto.randomBytes(32).toString("hex");
    const manualHash = crypto.createHash("sha256").update(manualToken).digest("hex");
    const reminderNow = new Date();
    const canonicalExpiry = new Date(reminderNow.getTime() + 40 * 86_400_000);
    for (const row of [manualOwner, revokedOwner]) {
      await db.execute(sql`
        INSERT INTO contractor_portal_tokens (client_id,contractor_id,token_hash,expires_at,revoked_at)
        VALUES (${clientId},${row.id},${manualHash},${canonicalExpiry},
          ${row.id === revokedOwner.id ? reminderNow : null})
      `);
    }
    await runContractorComplianceReminderJob(fakeSend, fakePush, reminderNow);
    const delivered = (await db.execute(sql`
      SELECT id, encrypted_token_payload FROM contractor_email_queue
      WHERE contractor_id=${manualOwner.id} AND status='pending'
    `)).rows[0];
    check("manual canonical token survives 60-day draft",
      (await db.execute(sql`SELECT token_hash FROM contractor_portal_tokens WHERE contractor_id=${manualOwner.id}`)).rows[0]?.token_hash === manualHash);
    await db.execute(sql`UPDATE contractor_email_queue SET status='sent' WHERE id=${delivered.id}`);
    await runContractorComplianceReminderJob(fakeSend, fakePush, new Date(reminderNow.getTime() + 25 * 86_400_000));
    const stableCanonical = (await db.execute(sql`
      SELECT token_hash, expires_at FROM contractor_portal_tokens WHERE contractor_id=${manualOwner.id}
    `)).rows[0];
    const children = (await db.execute(sql`
      SELECT r.* FROM contractor_portal_reminder_tokens r
      JOIN contractor_portal_tokens p ON p.id=r.portal_token_id WHERE p.contractor_id=${manualOwner.id}
      ORDER BY r.id
    `)).rows;
    const deliveredBearer = decryptTokenPayload(delivered.encrypted_token_payload).portal.split("/").pop();
    check("manual token remains unchanged at 30-day draft",
      stableCanonical.token_hash === manualHash && new Date(stableCanonical.expires_at).getTime() === canonicalExpiry.getTime());
    check("delivered reminders retain full independent 90-day lifetime",
      children.length === 2 && children[0].token_hash === crypto.createHash("sha256").update(deliveredBearer).digest("hex")
        && children.every(r => r.issuance_hash === manualHash)
        && new Date(children[0].expires_at).getTime() === reminderNow.getTime() + 90 * 86_400_000
        && new Date(children[1].expires_at).getTime() === reminderNow.getTime() + 115 * 86_400_000);
    check("revoked canonical produces no 60/30 drafts or claims",
      (await db.execute(sql`SELECT id FROM contractor_email_queue WHERE contractor_id=${revokedOwner.id}`)).rows.length === 0
        && (await db.execute(sql`SELECT id FROM contractor_compliance_reminder_log WHERE contractor_id=${revokedOwner.id} AND milestone LIKE 'portal-%'`)).rows.length === 0
        && (await db.execute(sql`SELECT revoked_at FROM contractor_portal_tokens WHERE contractor_id=${revokedOwner.id}`)).rows[0]?.revoked_at != null);

    // Parent record mutations suppress only the later window for the same
    // expiry; a different renewal date starts a fresh cycle.
    const updatedOwner = await seedContractor("updated-owner", { publicLiabilityExpiry: daysFromNow(55) });
    const catchupOwner = await seedContractor("catchup-owner", { publicLiabilityExpiry: daysFromNow(25) });
    const testNow = new Date();
    await runContractorComplianceReminderJob(fakeSend, fakePush, testNow);
    const updateDate = new Date(testNow.getTime() + 60_000);
    await db.execute(sql`UPDATE contractors SET updated_at=${updateDate} WHERE id=${updatedOwner.id}`);
    const later = new Date(testNow.getTime() + 25 * 86_400_000);
    await runContractorComplianceReminderJob(fakeSend, fakePush, later);
    const windowClaims = (await db.execute(sql`
      SELECT contractor_id,milestone FROM contractor_compliance_reminder_log
      WHERE client_id=${clientId} AND contractor_id IN (${updatedOwner.id},${catchupOwner.id})
        AND milestone LIKE 'portal-%'
    `)).rows;
    check("post-60 update suppresses 30 while missing-60 catches up",
      windowClaims.some(r => r.contractor_id === updatedOwner.id && r.milestone.startsWith("portal-60d:insurance:"))
        && !windowClaims.some(r => r.contractor_id === updatedOwner.id && r.milestone.startsWith("portal-30d:insurance:"))
        && windowClaims.some(r => r.contractor_id === catchupOwner.id && r.milestone.startsWith("portal-30d:insurance:")),
      JSON.stringify(windowClaims));
    await db.execute(sql`UPDATE contractors SET public_liability_expiry=${daysFromNow(52)} WHERE id=${updatedOwner.id}`);
    await runContractorComplianceReminderJob(fakeSend, fakePush, testNow);
    const renewed = (await db.execute(sql`
      SELECT milestone FROM contractor_compliance_reminder_log WHERE client_id=${clientId}
        AND contractor_id=${updatedOwner.id} AND milestone LIKE 'portal-60d:insurance:%'
    `)).rows;
    check("new insurance expiry produces a new portal renewal cycle", renewed.length === 2, JSON.stringify(renewed));

    const updatedCertOwner = await seedContractor("updated-cert", {});
    const updatedCert = (await db.execute(sql`INSERT INTO contractor_certificates
      (client_id,contractor_id,certificate_name,expiry_date)
      VALUES (${clientId},${updatedCertOwner.id},'Renewable',${daysFromNow(55)})
      RETURNING id`)).rows[0];
    const certNow = new Date();
    await runContractorComplianceReminderJob(fakeSend, fakePush, certNow);
    await db.execute(sql`UPDATE contractors SET updated_at=${new Date(certNow.getTime() + 60_000)}
      WHERE id=${updatedCertOwner.id}`);
    await runContractorComplianceReminderJob(fakeSend, fakePush, new Date(certNow.getTime() + 25 * 86_400_000));
    const updatedCertClaims = (await db.execute(sql`SELECT milestone FROM contractor_compliance_reminder_log
      WHERE contractor_id=${updatedCertOwner.id} AND milestone LIKE 'portal-%'`)).rows;
    check("certificate parent update after 60 suppresses certificate portal 30",
      updatedCertClaims.some(r => r.milestone.startsWith(`portal-60d:cert:${updatedCert.id}:`))
        && !updatedCertClaims.some(r => r.milestone.startsWith(`portal-30d:cert:${updatedCert.id}:`)),
      JSON.stringify(updatedCertClaims));

    // Renewal outside the alert window must retire unsent drafts even though
    // the contractor disappears from the job's candidate scan altogether.
    const renewalPending = await seedContractor("renew-before-approval", { publicLiabilityExpiry: daysFromNow(55) });
    const renewalApproved = await seedContractor("renew-after-approval", { publicLiabilityExpiry: daysFromNow(55) });
    const renewalSending = await seedContractor("renew-while-sending", { publicLiabilityExpiry: daysFromNow(55) });
    const renewalCertOwner = await seedContractor("renew-cert-before-approval", {});
    const renewalCert = (await db.execute(sql`
      INSERT INTO contractor_certificates (client_id,contractor_id,certificate_name,expiry_date)
      VALUES (${clientId},${renewalCertOwner.id},'Renew before approval',${daysFromNow(55)}) RETURNING id
    `)).rows[0];
    await runContractorComplianceReminderJob(fakeSend, fakePush, new Date());
    await db.execute(sql`UPDATE contractor_email_queue SET status='approved' WHERE contractor_id=${renewalApproved.id} AND status='pending'`);
    await db.execute(sql`UPDATE contractor_email_queue SET status='sending' WHERE contractor_id=${renewalSending.id} AND status='pending'`);
    for (const owner of [renewalPending, renewalApproved, renewalSending]) {
      await db.execute(sql`UPDATE contractors SET public_liability_expiry=${daysFromNow(200)}, updated_at=now() WHERE id=${owner.id}`);
    }
    await db.execute(sql`UPDATE contractor_certificates SET expiry_date=${daysFromNow(200)} WHERE id=${renewalCert.id}`);
    await runContractorComplianceReminderJob(fakeSend, fakePush, new Date());
    for (const owner of [renewalPending, renewalCertOwner]) {
      const rows = (await db.execute(sql`SELECT status FROM contractor_email_queue WHERE contractor_id=${owner.id}`)).rows;
      check(`renewal before approval cancels stale draft ${owner.id}`, rows.length === 1 && rows[0].status === "cancelled");
    }
    check("renewal cleanup never cancels approved/sending drafts",
      (await db.execute(sql`SELECT status FROM contractor_email_queue WHERE contractor_id=${renewalApproved.id}`)).rows[0]?.status === "approved"
        && (await db.execute(sql`SELECT status FROM contractor_email_queue WHERE contractor_id=${renewalSending.id}`)).rows[0]?.status === "sending");

    // A queue failure must not strand a claim or invalidate the previous
    // token. Database constraint simulates an insertion failure atomically.
    const retryOwner = await seedContractor("retry-owner", { publicLiabilityExpiry: daysFromNow(54) });
    const retryNow = new Date();
    const retryThirty = new Date(retryNow.getTime() + 25 * 86_400_000);
    const constraint = `test_portal_queue_${retryOwner.id}`;
    try {
      await db.execute(sql.raw(`ALTER TABLE contractor_email_queue ADD CONSTRAINT "${constraint}" CHECK (NOT (entity_type='contractor_compliance' AND contractor_id=${retryOwner.id}))`));
      const failedRun = await runContractorComplianceReminderJob(fakeSend, fakePush, retryNow);
      const failedClaims = (await db.execute(sql`
        SELECT id FROM contractor_compliance_reminder_log WHERE client_id=${clientId}
          AND contractor_id=${retryOwner.id} AND milestone LIKE 'portal-%'
      `)).rows;
      check("failed queue rolls back portal claim and token",
        failedRun.errors > 0 && failedClaims.length === 0
          && (await db.execute(sql`SELECT id FROM contractor_portal_tokens WHERE contractor_id=${retryOwner.id}`)).rows.length === 0,
        `errors=${failedRun.errors} claims=${failedClaims.length}`);
    } finally {
      await db.execute(sql.raw(`ALTER TABLE contractor_email_queue DROP CONSTRAINT IF EXISTS "${constraint}"`));
    }
    await runContractorComplianceReminderJob(fakeSend, fakePush, retryNow);
    check("failed portal queue can retry and claim",
      (await db.execute(sql`SELECT id FROM contractor_compliance_reminder_log
        WHERE client_id=${clientId} AND contractor_id=${retryOwner.id} AND milestone LIKE 'portal-60d:insurance:%'`)).rows.length === 1);
    const retryTokenBefore = (await db.execute(sql`SELECT token_hash FROM contractor_portal_tokens
      WHERE contractor_id=${retryOwner.id}`)).rows[0]?.token_hash;
    const retryPendingBefore = (await db.execute(sql`SELECT id FROM contractor_email_queue
      WHERE contractor_id=${retryOwner.id} AND status='pending'`)).rows[0]?.id;
    try {
      await db.execute(sql.raw(`ALTER TABLE contractor_email_queue ADD CONSTRAINT "${constraint}" CHECK (NOT (entity_type='contractor_compliance' AND contractor_id=${retryOwner.id} AND status='pending' AND id <> ${retryPendingBefore}))`));
      await runContractorComplianceReminderJob(fakeSend, fakePush, retryThirty);
      const existingDraft = (await db.execute(sql`SELECT id, status FROM contractor_email_queue
        WHERE contractor_id=${retryOwner.id} ORDER BY id`)).rows;
      check("failed replacement restores prior pending draft, token and 30-day claim",
        existingDraft.length === 1 && existingDraft[0].id === retryPendingBefore
          && existingDraft[0].status === "pending"
          && (await db.execute(sql`SELECT token_hash FROM contractor_portal_tokens
            WHERE contractor_id=${retryOwner.id}`)).rows[0]?.token_hash === retryTokenBefore
          && (await db.execute(sql`SELECT id FROM contractor_compliance_reminder_log
            WHERE contractor_id=${retryOwner.id} AND milestone LIKE 'portal-30d:%'`)).rows.length === 0,
        JSON.stringify(existingDraft));
    } finally {
      await db.execute(sql.raw(`ALTER TABLE contractor_email_queue DROP CONSTRAINT IF EXISTS "${constraint}"`));
    }
    await runContractorComplianceReminderJob(fakeSend, fakePush, retryThirty);
    check("failed replacement retries without rotating canonical token",
      (await db.execute(sql`SELECT token_hash FROM contractor_portal_tokens
        WHERE contractor_id=${retryOwner.id}`)).rows[0]?.token_hash === retryTokenBefore);

    const noManagerOwner = await seedContractor("no-manager", { publicLiabilityExpiry: daysFromNow(57) });
    await db.execute(sql`UPDATE users SET active=false WHERE id=${admin.id}`);
    try {
      await runContractorComplianceReminderJob(fakeSend, fakePush, testNow);
      check("contractor portal reminder does not depend on manager recipients",
        (await db.execute(sql`SELECT id FROM contractor_email_queue
          WHERE contractor_id=${noManagerOwner.id} AND status='pending'`)).rows.length === 1
          && (await db.execute(sql`SELECT id FROM contractor_compliance_reminder_log
            WHERE contractor_id=${noManagerOwner.id} AND milestone LIKE 'portal-60d:insurance:%'`)).rows.length === 1);
    } finally {
      await db.execute(sql`UPDATE users SET active=true WHERE id=${admin.id}`);
    }

    // The scan happens before the parent lock. Hold that lock while the job
    // starts, renew the date, then release it: no stale portal claim may land.
    const staleOwner = await seedContractor("stale-scan", { publicLiabilityExpiry: daysFromNow(54) });
    const staleStart = new Date();
    const staleConnection = await pool.connect();
    try {
      await staleConnection.query("BEGIN");
      await staleConnection.query("SELECT id FROM contractors WHERE id=$1 FOR UPDATE", [staleOwner.id]);
      const waitingRun = runContractorComplianceReminderJob(fakeSend, fakePush, staleStart);
      await new Promise(resolve => setTimeout(resolve, 100));
      await staleConnection.query(
        "UPDATE contractors SET public_liability_expiry=$1, updated_at=now() WHERE id=$2",
        [daysFromNow(200), staleOwner.id],
      );
      await staleConnection.query("COMMIT");
      await waitingRun;
    } finally {
      await staleConnection.query("ROLLBACK").catch(() => {});
      staleConnection.release();
    }
    check("renewal while scheduler waits for parent lock prevents stale portal draft",
      (await db.execute(sql`SELECT id FROM contractor_compliance_reminder_log
        WHERE contractor_id=${staleOwner.id} AND milestone LIKE 'portal-%'`)).rows.length === 0
        && (await db.execute(sql`SELECT id FROM contractor_email_queue
          WHERE contractor_id=${staleOwner.id} AND entity_type='contractor_compliance'`)).rows.length === 0);

    const approvalOwner = await seedContractor("approval-race", { publicLiabilityExpiry: daysFromNow(53) });
    const approvalNow = new Date();
    await runContractorComplianceReminderJob(fakeSend, fakePush, approvalNow);
    const approvalDraft = (await db.execute(sql`SELECT id FROM contractor_email_queue
      WHERE contractor_id=${approvalOwner.id} AND status='pending'`)).rows[0]?.id;
    const approvalHash = (await db.execute(sql`SELECT token_hash FROM contractor_portal_tokens
      WHERE contractor_id=${approvalOwner.id}`)).rows[0]?.token_hash;
    const approvalConnection = await pool.connect();
    try {
      await approvalConnection.query("BEGIN");
      await approvalConnection.query("SELECT id FROM contractor_email_queue WHERE id=$1 FOR UPDATE", [approvalDraft]);
      const waitingRun = runContractorComplianceReminderJob(
        fakeSend, fakePush, new Date(approvalNow.getTime() + 25 * 86_400_000),
      );
      await new Promise(resolve => setTimeout(resolve, 100));
      await approvalConnection.query("UPDATE contractor_email_queue SET status='sending' WHERE id=$1", [approvalDraft]);
      await approvalConnection.query("COMMIT");
      await waitingRun;
    } finally {
      await approvalConnection.query("ROLLBACK").catch(() => {});
      approvalConnection.release();
    }
    check("concurrent approval keeps its sending draft and bearer valid",
      (await db.execute(sql`SELECT status FROM contractor_email_queue WHERE id=${approvalDraft}`)).rows[0]?.status === "sending"
        && (await db.execute(sql`SELECT token_hash FROM contractor_portal_tokens
          WHERE contractor_id=${approvalOwner.id}`)).rows[0]?.token_hash === approvalHash
        && (await db.execute(sql`SELECT id FROM contractor_compliance_reminder_log
          WHERE contractor_id=${approvalOwner.id} AND milestone LIKE 'portal-30d:%'`)).rows.length === 0);
    const milestones = (await db.execute(sql`
      SELECT milestone FROM contractor_compliance_reminder_log
      WHERE client_id=${clientId} AND contractor_id IN (${dbsDue.id}, ${certOwner.id})
    `)).rows.map(row => row.milestone);
    check("dedupe log retains both manager dates for each item", milestones.filter(m => !m.startsWith("portal-")).length === 4
      && milestones.some(m => m.startsWith("dbs-expiry:") && m.endsWith(":30"))
      && milestones.some(m => m.startsWith("cert:") && m.endsWith(":30")),
    JSON.stringify(milestones));
  } finally {
    // Remove only this run's tenant, including the dependent audit_log rows
    // that would otherwise block DELETE FROM clients (tests/fixture-ownership.mjs).
    let cleanupConnection = null;
    try {
      cleanupConnection = await pool.connect();
      await cleanupConnection.query(buildOwnedFixturePurgeSql({
        runId, clientIds: clientId == null ? [] : [clientId],
      }));
      const left = await cleanupConnection.query(
        `SELECT (SELECT count(*) FROM clients WHERE slug = $1)::int AS clients,
                (SELECT count(*) FROM users WHERE position($2 IN email) > 0)::int AS users`,
        [tag, runId],
      );
      check("cleanup removes this run's client and users",
        left.rows[0]?.clients === 0 && left.rows[0]?.users === 0, JSON.stringify(left.rows[0]));
    } catch (err) {
      await cleanupConnection?.query("ROLLBACK").catch(() => {});
      console.error("Cleanup failed:", err);
      failures.push(`cleanup — ${err?.message ?? err}`);
    } finally {
      cleanupConnection?.release();
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
