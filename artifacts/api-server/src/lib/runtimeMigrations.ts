import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "./logger";
import {
  digestBearerToken,
  encryptTokenPayload,
  decryptTokenPayload,
  tokenPayloadNeedsReencryption,
  validateTokenEncryptionConfig,
} from "./bearerTokens";

/**
 * Re-encrypt queued credentials onto the configured current key. Supplying an
 * ID is useful for targeted maintenance and isolated integration tests.
 */
export async function reencryptQueuedTokenPayloads(queueId?: number): Promise<number> {
  validateTokenEncryptionConfig();
  return db.transaction(async (tx) => {
    const rows = await tx.execute(sql`SELECT id, encrypted_token_payload
      FROM contractor_email_queue
      WHERE encrypted_token_payload IS NOT NULL
        ${queueId == null ? sql`` : sql`AND id=${queueId}`}
      FOR UPDATE`);
    let updated = 0;
    for (const row of rows.rows as any[]) {
      const encoded = String(row.encrypted_token_payload);
      if (!tokenPayloadNeedsReencryption(encoded)) continue;
      const replacement = encryptTokenPayload(decryptTokenPayload(encoded));
      const result = await tx.execute(sql`UPDATE contractor_email_queue
        SET encrypted_token_payload=${replacement}, updated_at=now()
        WHERE id=${row.id}
          AND encrypted_token_payload=${encoded}
        RETURNING id`);
      if ((result.rows as any[])[0]) updated++;
    }
    return updated;
  });
}

/**
 * Idempotent runtime migrations for additive schema changes.
 * Safe to run on every boot — uses IF NOT EXISTS guards.
 */
export async function runRuntimeMigrations() {
  try {
    // Validate even on a new database with no encrypted rows, so a broken key
    // rotation cannot let the service report ready and fail only at dispatch.
    validateTokenEncryptionConfig();
    // ---- Session store table (connect-pg-simple) ----
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS "sessions" (
        "sid" varchar NOT NULL COLLATE "default",
        "sess" json NOT NULL,
        "expire" timestamp(6) NOT NULL,
        CONSTRAINT "sessions_pkey" PRIMARY KEY ("sid") NOT DEFERRABLE INITIALLY IMMEDIATE
      ) WITH (OIDS=FALSE)
    `);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS "IDX_sessions_expire" ON "sessions" ("expire")`);

    // ---- Billing discount redemptions ----
    // A client can reserve a code while Stripe Checkout is open, then it is
    // permanently redeemed once the Checkout completion webhook arrives.
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS "billing_discount_redemptions" (
        "id" serial PRIMARY KEY,
        "client_id" integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
        "code" text NOT NULL,
        "status" text NOT NULL DEFAULT 'reserved',
        "reservation_token" text,
        "checkout_session_id" text,
        "created_at" timestamp NOT NULL DEFAULT now(),
        "expires_at" timestamp,
        "redeemed_at" timestamp,
        CONSTRAINT "UQ_billing_discount_redemption_client_code" UNIQUE ("client_id", "code")
      )
    `);
    await db.execute(sql`
      ALTER TABLE "billing_discount_redemptions"
      ADD COLUMN IF NOT EXISTS "reservation_token" text
    `);
    await db.execute(sql`
      ALTER TABLE "billing_discount_redemptions"
      ADD COLUMN IF NOT EXISTS "expires_at" timestamp
    `);
    await db.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_billing_discount_redemption_token"
      ON "billing_discount_redemptions" ("reservation_token")
      WHERE "reservation_token" IS NOT NULL
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS "IDX_billing_discount_redemptions_status"
      ON "billing_discount_redemptions" ("status", "created_at")
    `);
    // One redemption ever per client, regardless of which code value was used
    // (codes are now manager-issued and replaceable). Existing data used a
    // single shared code, so (client_id, code) uniqueness already implied
    // one row per client and this index cannot fail on legacy rows.
    await db.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_billing_discount_redemption_client"
      ON "billing_discount_redemptions" ("client_id")
    `);

    // ---- Manager-issued per-client discount codes ----
    // One active code per client; only the SHA-256 hash is stored. The raw
    // code is shown to the issuing manager exactly once.
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS "billing_discount_codes" (
        "id" serial PRIMARY KEY,
        "client_id" integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
        "code_hash" text NOT NULL,
        "code_hint" text NOT NULL,
        "created_by" integer REFERENCES "users"("id") ON DELETE SET NULL,
        "created_at" timestamp NOT NULL DEFAULT now(),
        "replaced_at" timestamp,
        CONSTRAINT "UQ_billing_discount_codes_client" UNIQUE ("client_id"),
        CONSTRAINT "UQ_billing_discount_codes_hash" UNIQUE ("code_hash")
      )
    `);

    // ---- Sites table ----
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS "sites" (
        "id" serial PRIMARY KEY,
        "client_id" integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
        "category_id" integer REFERENCES "categories"("id") ON DELETE SET NULL,
        "name" text NOT NULL,
        "responsible_person" text,
        "address" text,
        "phone" text,
        "created_at" timestamp NOT NULL DEFAULT now(),
        "updated_at" timestamp NOT NULL DEFAULT now()
      )
    `);

    // ---- Fire safety logbook table ----
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS "fire_safety_checks" (
        "id" serial PRIMARY KEY,
        "client_id" integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
        "site_id" integer REFERENCES "sites"("id") ON DELETE SET NULL,
        "check_type" text NOT NULL,
        "check_date" date NOT NULL,
        "result" text NOT NULL DEFAULT 'pass',
        "location" text,
        "notes" text,
        "performed_by" text,
        "created_by" integer REFERENCES "users"("id") ON DELETE SET NULL,
        "created_at" timestamp NOT NULL DEFAULT now(),
        "updated_at" timestamp NOT NULL DEFAULT now()
      )
    `);
    await db.execute(
      sql`CREATE INDEX IF NOT EXISTS "IDX_fire_safety_client_type_date" ON "fire_safety_checks" ("client_id", "check_type", "check_date")`
    );

    // ---- Food safety (kitchen diary) table ----
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS "food_safety_records" (
        "id" serial PRIMARY KEY,
        "client_id" integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
        "site_id" integer REFERENCES "sites"("id") ON DELETE SET NULL,
        "record_date" date NOT NULL,
        "fridge1_temp" numeric(4, 1),
        "fridge2_temp" numeric(4, 1),
        "fridge3_temp" numeric(4, 1),
        "freezer1_temp" numeric(4, 1),
        "freezer2_temp" numeric(4, 1),
        "hot_holding_temp" numeric(4, 1),
        "probe_cleaned" boolean,
        "notes" text,
        "performed_by" text,
        "created_by" integer REFERENCES "users"("id") ON DELETE SET NULL,
        "created_at" timestamp NOT NULL DEFAULT now(),
        "updated_at" timestamp NOT NULL DEFAULT now()
      )
    `);
    await db.execute(
      sql`CREATE INDEX IF NOT EXISTS "IDX_food_safety_client_date" ON "food_safety_records" ("client_id", "record_date")`
    );
    // NOTE: uniqueness for the diary is now scoped per-site and created by
    // migrateFoodSafetySiteScoping() at the very end of runRuntimeMigrations
    // (two partial unique indexes). The legacy whole-table unique index
    // "UQ_food_safety_client_date" is deliberately no longer created here — that
    // migration drops it — otherwise two sites could not share a record date.

    // ---- Legionella water safety table ----
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS "legionella_checks" (
        "id" serial PRIMARY KEY,
        "client_id" integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
        "site_id" integer REFERENCES "sites"("id") ON DELETE SET NULL,
        "department_id" integer REFERENCES "departments"("id") ON DELETE SET NULL,
        "check_type" text NOT NULL,
        "check_date" date NOT NULL,
        "result" text NOT NULL DEFAULT 'pass',
        "location" text,
        "temperature_c" numeric(4, 1),
        "notes" text,
        "performed_by" text,
        "created_by" integer REFERENCES "users"("id") ON DELETE SET NULL,
        "created_at" timestamp NOT NULL DEFAULT now(),
        "updated_at" timestamp NOT NULL DEFAULT now()
      )
    `);
    await db.execute(
      sql`CREATE INDEX IF NOT EXISTS "IDX_legionella_client_type_date" ON "legionella_checks" ("client_id", "check_type", "check_date")`
    );

    // ---- SafeTrack tables ----
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS "safe_risk_assessments" (
        "id" serial PRIMARY KEY,
        "client_id" integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
        "site_id" integer REFERENCES "sites"("id") ON DELETE SET NULL,
        "title" text NOT NULL,
        "hazard" text,
        "likelihood" integer,
        "severity" integer,
        "control_measures" text,
        "reviewed_by" text,
        "review_date" date,
        "next_review_date" date,
        "status" text NOT NULL DEFAULT 'active',
        "notes" text,
        "created_at" timestamp NOT NULL DEFAULT now(),
        "updated_at" timestamp NOT NULL DEFAULT now()
      )
    `);

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS "safe_sops" (
        "id" serial PRIMARY KEY,
        "client_id" integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
        "site_id" integer REFERENCES "sites"("id") ON DELETE SET NULL,
        "title" text NOT NULL,
        "category" text,
        "version" text,
        "content" text,
        "reviewed_by" text,
        "review_date" date,
        "next_review_date" date,
        "status" text NOT NULL DEFAULT 'active',
        "created_at" timestamp NOT NULL DEFAULT now(),
        "updated_at" timestamp NOT NULL DEFAULT now()
      )
    `);

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS "safe_incidents" (
        "id" serial PRIMARY KEY,
        "client_id" integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
        "site_id" integer REFERENCES "sites"("id") ON DELETE SET NULL,
        "title" text NOT NULL,
        "incident_date" date NOT NULL,
        "incident_type" text,
        "description" text,
        "persons_involved" text,
        "immediate_actions" text,
        "follow_up_actions" text,
        "reported_by" text,
        "status" text NOT NULL DEFAULT 'open',
        "riddor_reportable" boolean DEFAULT false,
        "created_at" timestamp NOT NULL DEFAULT now(),
        "updated_at" timestamp NOT NULL DEFAULT now()
      )
    `);

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS "safe_handbook" (
        "id" serial PRIMARY KEY,
        "client_id" integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
        "title" text NOT NULL,
        "content" text,
        "version" text,
        "published_at" timestamp,
        "created_at" timestamp NOT NULL DEFAULT now(),
        "updated_at" timestamp NOT NULL DEFAULT now()
      )
    `);

    // Keep legacy SafeTrack training rows aligned with the department-scoped
    // Drizzle model. Older databases predate this optional scope column.
    await db.execute(sql`
      ALTER TABLE "safe_training_records"
      ADD COLUMN IF NOT EXISTS "department_id" integer
      REFERENCES "departments"("id") ON DELETE SET NULL
    `);

    // ---- FixTrack issues table ----
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS "fix_track_issues" (
        "id" serial PRIMARY KEY,
        "client_id" integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
        "site_id" integer REFERENCES "sites"("id") ON DELETE SET NULL,
        "department_id" integer REFERENCES "departments"("id") ON DELETE SET NULL,
        "title" text NOT NULL,
        "description" text,
        "status" text NOT NULL DEFAULT 'open',
        "priority" text NOT NULL DEFAULT 'medium',
        "category" text,
        "reported_by" text,
        "assigned_to" text,
        "due_date" date,
        "resolved_at" timestamp,
        "resolution_notes" text,
        "media_urls" text[] DEFAULT '{}',
        "created_at" timestamp NOT NULL DEFAULT now(),
        "updated_at" timestamp NOT NULL DEFAULT now()
      )
    `);

    // ---- DocTrack tables ----
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS "doc_track_documents" (
        "id" serial PRIMARY KEY,
        "client_id" integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
        "site_id" integer REFERENCES "sites"("id") ON DELETE SET NULL,
        "title" text NOT NULL,
        "category" text,
        "version" text,
        "file_path" text,
        "file_name" text,
        "file_size" integer,
        "mime_type" text,
        "description" text,
        "expiry_date" date,
        "reviewed_by" text,
        "review_date" date,
        "next_review_date" date,
        "status" text NOT NULL DEFAULT 'active',
        "created_at" timestamp NOT NULL DEFAULT now(),
        "updated_at" timestamp NOT NULL DEFAULT now()
      )
    `);

    // ---- Hot tub checks ----
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS "hot_tub_checks" (
        "id" serial PRIMARY KEY,
        "client_id" integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
        "site_id" integer REFERENCES "sites"("id") ON DELETE SET NULL,
        "check_type" text NOT NULL,
        "check_date" date NOT NULL,
        "result" text NOT NULL DEFAULT 'pass',
        "temperature_c" numeric(4,1),
        "ph_level" numeric(4,2),
        "chlorine_level" numeric(4,2),
        "bromine_level" numeric(4,2),
        "location" text,
        "notes" text,
        "performed_by" text,
        "created_at" timestamp NOT NULL DEFAULT now(),
        "updated_at" timestamp NOT NULL DEFAULT now()
      )
    `);

    await migrateLegacyCategories();

    // ---- TrainTrack ----
    await migrateTrainTrack();
    await migrateSafeHandbook();
    await migrateHotTub();
    await migrateHotTubRegistry();
    await migrateTreeTrack();
    await migrateBikeTrack();
    await migrateBikeServices();
    await migrateTwoFactor();
    await migrateStaffRoster();
    await migrateDocAcknowledgements();
    await migrateSignatures();
    await migrateSafeTrackAckReminderLog();
    await migrateDocDepartment();
    await migratePoolTrack();
    await migrateCheckPhotos();
    await migrateGreenTrack();
    await migrateSwimTrack();
    await migrateSiteDocuments();
    await migrateFixTrackV2();
    await migrateMobileSessions();
    await migrateIncidents();
    await migrateComplianceAuditTrail();
    await migrateSousVide();
    await migratePATtrack();
    await migratePestTrack();
    await migratePremisesTrack();
    await migrateRoomTrack();
    await migrateKitchenCleaning();
    await migrateMaintenanceManager();

    // ---- Push notification tokens (keep this LAST) ----
    // Placed at the very end of the migration function so other agents can add
    // their own migrations above without conflicting with this region.
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS "push_tokens" (
        "id" serial PRIMARY KEY,
        "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "client_id" integer REFERENCES "clients"("id") ON DELETE CASCADE,
        "token" text NOT NULL,
        "platform" text,
        "created_at" timestamp NOT NULL DEFAULT now()
      )
    `);
    await db.execute(
      sql`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_push_tokens_token" ON "push_tokens" ("token")`
    );
    await db.execute(
      sql`CREATE INDEX IF NOT EXISTS "IDX_push_tokens_user" ON "push_tokens" ("user_id")`
    );

    // ---- Contractor compliance fields (keep at VERY END) ----
    await db.execute(sql`ALTER TABLE "contractors" ADD COLUMN IF NOT EXISTS "gas_safe_number" text`);
    await db.execute(sql`ALTER TABLE "contractors" ADD COLUMN IF NOT EXISTS "public_liability_expiry" timestamp`);
    await db.execute(sql`ALTER TABLE "contractors" ADD COLUMN IF NOT EXISTS "dbs_check_date" timestamp`);
    await db.execute(sql`ALTER TABLE "contractors" ADD COLUMN IF NOT EXISTS "professional_indemnity_expiry" timestamp`);
    await db.execute(sql`ALTER TABLE "contractors" ADD COLUMN IF NOT EXISTS "dbs_type" text`);
    await db.execute(sql`ALTER TABLE "contractors" ADD COLUMN IF NOT EXISTS "dbs_expiry_date" timestamp`);

    // Time-limited certificates for contractors (IPAF, PASMA, First Aid, Chainsaw, etc.)
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS "contractor_certificates" (
        "id"               serial PRIMARY KEY,
        "client_id"        integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
        "contractor_id"    integer NOT NULL REFERENCES "contractors"("id") ON DELETE CASCADE,
        "certificate_name" text NOT NULL,
        "issuer"           text,
        "completed_date"   timestamp,
        "expiry_date"      timestamp,
        "notes"            text,
        "created_at"       timestamp NOT NULL DEFAULT now(),
        "updated_at"       timestamp NOT NULL DEFAULT now()
      )
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS "IDX_contractor_certificates_contractor"
      ON "contractor_certificates" ("contractor_id")
    `);

    // Deduplication log for contractor compliance-expiry reminders. One row per
    // (client, contractor, milestone), where milestone encodes the reminder
    // target it was sent for (e.g. "insurance:2025-03-01" or "dbs:2022-01-01"),
    // so a fresh expiry/renewal date produces a new milestone and re-alerts,
    // while the same milestone is never re-sent.
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS "contractor_compliance_reminder_log" (
        "id"            serial PRIMARY KEY,
        "client_id"     integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
        "contractor_id" integer NOT NULL REFERENCES "contractors"("id") ON DELETE CASCADE,
        "milestone"     text NOT NULL,
        "sent_at"       timestamp NOT NULL DEFAULT now(),
        UNIQUE ("client_id", "contractor_id", "milestone")
      )
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS "IDX_contractor_compliance_reminder_client"
      ON "contractor_compliance_reminder_log" ("client_id")
    `);

    // Object path for contractor certificate uploads (added when portal introduced).
    await db.execute(sql`
      ALTER TABLE "contractor_certificates"
        ADD COLUMN IF NOT EXISTS "object_path" text
    `);

    // Contractor self-service portal tokens. One active token per contractor
    // (UNIQUE on contractor_id). The token is refreshed each time a reminder
    // fires so the link in the latest email is always valid.
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS "contractor_portal_tokens" (
        "id"            serial PRIMARY KEY,
        "client_id"     integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
        "contractor_id" integer NOT NULL REFERENCES "contractors"("id") ON DELETE CASCADE,
        "token"         text UNIQUE,
        "token_hash"    text,
        "expires_at"    timestamp NOT NULL,
        "created_at"    timestamp NOT NULL DEFAULT now(),
        UNIQUE ("contractor_id")
      )
    `);
    // A token can be withdrawn without deleting its issuance/audit history.
    // issued_by is deliberately nullable for scheduler-issued legacy links.
    await db.execute(sql`ALTER TABLE "contractor_portal_tokens" ADD COLUMN IF NOT EXISTS "revoked_at" timestamp`);
    await db.execute(sql`ALTER TABLE "contractor_portal_tokens" ADD COLUMN IF NOT EXISTS "token_hash" text`);
    await db.execute(sql`ALTER TABLE "contractor_portal_tokens" ALTER COLUMN "token" DROP NOT NULL`);
    const portalLegacy = await db.execute(sql`SELECT id, token FROM contractor_portal_tokens WHERE token IS NOT NULL`);
    for (const row of (portalLegacy.rows as any[])) {
      await db.execute(sql`UPDATE contractor_portal_tokens SET token_hash=${digestBearerToken(row.token)}, token=NULL WHERE id=${row.id}`);
    }
    await db.execute(sql`ALTER TABLE "contractor_portal_tokens" ADD COLUMN IF NOT EXISTS "issued_by" integer REFERENCES "users"("id") ON DELETE SET NULL`);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS "IDX_contractor_portal_tokens_token"
      ON "contractor_portal_tokens" ("token")
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS "IDX_contractor_portal_tokens_token_hash"
      ON "contractor_portal_tokens" ("token_hash")
    `);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS "contractor_portal_audit_log" (
        "id" serial PRIMARY KEY,
        "client_id" integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
        "contractor_id" integer NOT NULL REFERENCES "contractors"("id") ON DELETE CASCADE,
        "actor_type" text NOT NULL CHECK ("actor_type" IN ('manager', 'contractor')),
        "actor_user_id" integer REFERENCES "users"("id") ON DELETE SET NULL,
        "event_type" text NOT NULL,
        "details" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "created_at" timestamp NOT NULL DEFAULT now()
      )
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS "IDX_contractor_portal_audit_client_contractor"
      ON "contractor_portal_audit_log" ("client_id", "contractor_id", "created_at" DESC)
    `);

    // Deduplication log for TrainTrack staff-training-expiry reminders. One row
    // per (client, record, milestone), where milestone encodes the expiry date
    // it was sent for (e.g. "expiry:2025-03-01"), so a renewed certificate
    // (new expiry date) produces a new milestone and re-alerts, while the same
    // milestone is never re-sent. Self-contained / IF NOT EXISTS.
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS "training_expiry_reminder_log" (
        "id"        serial PRIMARY KEY,
        "client_id" integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
        "record_id" integer NOT NULL REFERENCES "train_track_records"("id") ON DELETE CASCADE,
        "milestone" text NOT NULL,
        "sent_at"   timestamp NOT NULL DEFAULT now(),
        UNIQUE ("client_id", "record_id", "milestone")
      )
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS "IDX_training_expiry_reminder_client"
      ON "training_expiry_reminder_log" ("client_id")
    `);

    await migrateAuditFixes2026_08();
    await migrateOffboardingColumns();
    await migrateDoctrackSafetrackMerge();
    await migrateLegionellaOutlets();
    await migrateComplianceHub();
    await migrateTrackActions();

    // FixTrack contractor email approval queue.  Keep the rendered message in
    // the queue: an approval is an approval of the exact bytes the manager saw,
    // not of a subsequently re-rendered issue.
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS "contractor_email_queue" (
        "id" serial PRIMARY KEY,
        "client_id" integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
        "issue_id" integer NOT NULL REFERENCES "fix_track_issues"("id") ON DELETE CASCADE,
        "entity_type" text NOT NULL DEFAULT 'fix_track'
          CHECK ("entity_type" IN ('fix_track','compliance','contractor_compliance')),
        "entity_id" integer NOT NULL,
        "department_id" integer REFERENCES "departments"("id") ON DELETE SET NULL,
        "contractor_id" integer REFERENCES "contractors"("id") ON DELETE SET NULL,
        "mode" text NOT NULL CHECK ("mode" IN ('assign','quote')),
        "email_type" text NOT NULL DEFAULT 'assignment' CHECK ("email_type" IN ('assignment','reminder','quote_request')),
        "status" text NOT NULL DEFAULT 'pending'
          CHECK ("status" IN ('pending','approved','sending','sent','cancelled','failed')),
        "to_email" text NOT NULL CHECK (length(trim("to_email")) > 3),
        "subject" text NOT NULL CHECK (length("subject") > 0),
        "body_html" text NOT NULL CHECK (length("body_html") > 0),
        "body_text" text,
        "cc_json" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "ics_content" text,
        "ics_filename" text,
        "email_preview_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "quote_token" text UNIQUE,
        "quote_token_hash" text,
        "quote_token_expires_at" timestamp,
        "requested_by" integer REFERENCES "users"("id") ON DELETE SET NULL,
        "approved_by" integer REFERENCES "users"("id") ON DELETE SET NULL,
        "approved_at" timestamp,
        "sent_by" integer REFERENCES "users"("id") ON DELETE SET NULL,
        "sent_at" timestamp,
        "last_error" text,
        "idempotency_key" text NOT NULL UNIQUE,
        "created_at" timestamp NOT NULL DEFAULT now(),
        "updated_at" timestamp NOT NULL DEFAULT now(),
        UNIQUE ("idempotency_key")
      )
    `);
    await db.execute(sql`ALTER TABLE "contractor_email_queue"
      ADD COLUMN IF NOT EXISTS "entity_type" text NOT NULL DEFAULT 'fix_track',
      ADD COLUMN IF NOT EXISTS "entity_id" integer,
      ADD COLUMN IF NOT EXISTS "email_type" text NOT NULL DEFAULT 'assignment',
      ADD COLUMN IF NOT EXISTS "cc_json" jsonb NOT NULL DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS "ics_content" text,
      ADD COLUMN IF NOT EXISTS "ics_filename" text,
      ADD COLUMN IF NOT EXISTS "email_preview_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
      ADD COLUMN IF NOT EXISTS "quote_token_expires_at" timestamp,
      ADD COLUMN IF NOT EXISTS "quote_token_hash" text,
      ADD COLUMN IF NOT EXISTS "encrypted_token_payload" text`);
    await db.execute(sql`ALTER TABLE "contractor_email_queue" ALTER COLUMN "quote_token" DROP NOT NULL`);
    // This credential-scrubbing migration assumes one application instance starts
    // at a time and finishes migrations before readiness. Zero-downtime deployment
    // alongside an older writer is intentionally not supported.
    await db.transaction(async (tx) => {
      const legacy = await tx.execute(sql`SELECT id, client_id, issue_id, entity_id, quote_token, quote_token_hash,
        subject, body_html, body_text, email_preview_json, encrypted_token_payload
        FROM contractor_email_queue FOR UPDATE`);
      for (const row of (legacy.rows as any[])) {
        const payload: Record<string, string> = row.encrypted_token_payload
          ? decryptTokenPayload(row.encrypted_token_payload)
          : {};
        let subject = String(row.subject ?? "");
        let html = String(row.body_html ?? "");
        let text = row.body_text == null ? null : String(row.body_text);
        let previewText = JSON.stringify(row.email_preview_json ?? {});
        const bearerPattern = /\/(api\/fix-track\/action|contractor-quote|contractor-portal)\/([a-z0-9-]{32,})/ig;
        const all = [subject, html, text ?? "", previewText, String(row.quote_token ?? "")].join("\n");
        const candidates = [...all.matchAll(bearerPattern)];
        if (candidates.length === 0 && row.quote_token == null) continue;
        const discovered: Array<[string, string]> = [];
        const rawQuote = row.quote_token ? String(row.quote_token) : null;
        if (rawQuote) payload.quote = rawQuote;
        for (const match of candidates) {
          const route = match[1].toLowerCase();
          const token = match[2];
          if (route === "contractor-quote") {
            payload.quote ??= token;
            discovered.push([token, "{{QUOTE_TOKEN}}"]);
          } else if (route === "contractor-portal") {
            payload.portal ??= token;
            discovered.push([token, "{{PORTAL_URL}}"]);
          }
          else {
            const issueId = Number(row.issue_id ?? row.entity_id);
            if (!Number.isInteger(issueId)) {
              throw new Error(`Cannot classify legacy action token without an issue id in contractor_email_queue row ${row.id}`);
            }
            const action = await tx.execute(sql`SELECT action FROM fix_track_action_tokens
              WHERE token_hash=${digestBearerToken(token)}
                AND issue_id=${issueId}
                AND client_id=${row.client_id} LIMIT 1`);
            const kind = String((action.rows as any[])[0]?.action ?? "");
            if (kind === "booked" || kind === "completed") {
              payload[kind] = token;
              discovered.push([token, `{{${kind.toUpperCase()}_TOKEN}}`]);
            }
            else throw new Error(`Cannot safely classify legacy action token in contractor_email_queue row ${row.id}`);
          }
        }
        const replacements: Array<[string, string]> = [...discovered];
        if (payload.quote) replacements.push([payload.quote, "{{QUOTE_TOKEN}}"]);
        if (payload.booked) replacements.push([payload.booked, "{{BOOKED_TOKEN}}"]);
        if (payload.completed) replacements.push([payload.completed, "{{COMPLETED_TOKEN}}"]);
        if (payload.portal) replacements.push([payload.portal, "{{PORTAL_URL}}"]);
        // Full portal URLs must be replaced before their token suffixes or
        // hydration would duplicate the URL prefix.
        replacements.sort(([left], [right]) => right.length - left.length);
        for (const [raw, placeholder] of replacements) {
          subject = subject.split(raw).join(placeholder);
          html = html.split(raw).join(placeholder);
          if (text != null) text = text.split(raw).join(placeholder);
          previewText = previewText.split(raw).join(placeholder);
        }
        const remaining = [subject, html, text ?? "", previewText].join("\n");
        if (/\/(?:api\/fix-track\/action|contractor-quote|contractor-portal)\/[a-z0-9-]{32,}/i.test(remaining)) {
          throw new Error(`Could not scrub every bearer URL from contractor_email_queue row ${row.id}`);
        }
        const encrypted = Object.keys(payload).length ? encryptTokenPayload(payload) : null;
        await tx.execute(sql`UPDATE contractor_email_queue SET
          quote_token_hash=COALESCE(quote_token_hash, ${payload.quote ? digestBearerToken(payload.quote) : null}),
          quote_token=NULL, subject=${subject}, body_html=${html}, body_text=${text},
          email_preview_json=${previewText}::jsonb,
          encrypted_token_payload=${encrypted ?? row.encrypted_token_payload}
          WHERE id=${row.id}
            AND quote_token IS NOT DISTINCT FROM ${row.quote_token}
            AND encrypted_token_payload IS NOT DISTINCT FROM ${row.encrypted_token_payload}`);
      }
    });
    await reencryptQueuedTokenPayloads();
    await db.execute(sql`CREATE INDEX IF NOT EXISTS "IDX_contractor_email_queue_quote_token_hash" ON contractor_email_queue ("quote_token_hash")`);
    await db.execute(sql`ALTER TABLE "contractor_email_queue"
      DROP CONSTRAINT IF EXISTS "contractor_email_queue_entity_type_check",
      DROP CONSTRAINT IF EXISTS "contractor_email_queue_client_id_issue_id_mode_status_key"`);
    await db.execute(sql`ALTER TABLE "contractor_email_queue"
      ADD CONSTRAINT "contractor_email_queue_entity_type_check"
      CHECK ("entity_type" IN ('fix_track','compliance','contractor_compliance'))`);
    await db.execute(sql`
      UPDATE contractor_email_queue q
      SET status='cancelled', last_error='Superseded duplicate draft', updated_at=now()
      WHERE q.status IN ('pending','sending')
        AND EXISTS (
          SELECT 1 FROM contractor_email_queue newer
          WHERE newer.client_id=q.client_id
            AND newer.entity_type=q.entity_type
            AND newer.entity_id=q.entity_id
            AND newer.email_type=q.email_type
            AND newer.status IN ('pending','sending')
            AND newer.id > q.id
        )
    `);
    await db.execute(sql`DROP INDEX IF EXISTS "UQ_contractor_email_queue_active_draft"`);
    await db.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_contractor_email_queue_active_draft"
      ON contractor_email_queue (client_id,entity_type,entity_id)
      WHERE status IN ('pending','sending')
    `);
    await db.execute(sql`ALTER TABLE "contractor_email_queue" ALTER COLUMN "issue_id" DROP NOT NULL`);
    await db.execute(sql`UPDATE "contractor_email_queue" SET entity_id=issue_id WHERE entity_id IS NULL`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS "IDX_fix_track_email_queue_client_status"
      ON "contractor_email_queue" ("client_id","status","created_at" DESC)`);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS "fix_track_quote_submissions" (
        "id" serial PRIMARY KEY,
        "queue_id" integer NOT NULL REFERENCES "contractor_email_queue"("id") ON DELETE CASCADE,
        "client_id" integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
        "contractor_id" integer REFERENCES "contractors"("id") ON DELETE SET NULL,
        "price_pence" integer NOT NULL CHECK ("price_pence" >= 0),
        "pounds_price" numeric(12,2) NOT NULL CHECK ("pounds_price" >= 0),
        "notes" text,
        "submitted_at" timestamp NOT NULL DEFAULT now(),
        UNIQUE ("queue_id")
      )
    `);
    await db.execute(sql`
      ALTER TABLE "fix_track_quote_submissions"
      ADD COLUMN IF NOT EXISTS "status" text NOT NULL DEFAULT 'submitted'
    `);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS "fix_track_manager_notifications" (
        "id" serial PRIMARY KEY,
        "client_id" integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
        "user_id" integer REFERENCES "users"("id") ON DELETE CASCADE,
        "issue_id" integer REFERENCES "fix_track_issues"("id") ON DELETE CASCADE,
        "kind" text NOT NULL,
        "title" text NOT NULL,
        "body" text NOT NULL,
        "read_at" timestamp,
        "created_at" timestamp NOT NULL DEFAULT now()
      )
    `);

    // Annual-acknowledgement flag on DocTrack documents
    await db.execute(sql`
      ALTER TABLE doc_track_documents
        ADD COLUMN IF NOT EXISTS "annual_acknowledgement" boolean NOT NULL DEFAULT false
    `);

    // ---- Contractor DBS/PVG expiry tracking + Gas Safe (Task #113) ----
    await db.execute(sql`ALTER TABLE "contractors" ADD COLUMN IF NOT EXISTS "dbs_issue_date" date`);
    await db.execute(sql`ALTER TABLE "contractors" ADD COLUMN IF NOT EXISTS "dbs_expiry_date" date`);
    await db.execute(sql`ALTER TABLE "contractors" ADD COLUMN IF NOT EXISTS "public_liability_expiry" date`);
    await db.execute(sql`ALTER TABLE "contractors" ADD COLUMN IF NOT EXISTS "gas_safe_registration" text`);

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS "staff_training_records" (
        "id" serial PRIMARY KEY,
        "client_id" integer NOT NULL,
        "user_id" integer REFERENCES "users"("id") ON DELETE SET NULL,
        "staff_name" text NOT NULL,
        "course_name" text NOT NULL,
        "issued_at" timestamp,
        "expires_at" timestamp,
        "notes" text,
        "created_at" timestamp NOT NULL DEFAULT now(),
        "updated_at" timestamp NOT NULL DEFAULT now()
      )
    `);

    // Add module flags to clients table
    await db.execute(sql`ALTER TABLE "clients" ADD COLUMN IF NOT EXISTS "safe_track_enabled" boolean NOT NULL DEFAULT false`);
    await db.execute(sql`ALTER TABLE "clients" ADD COLUMN IF NOT EXISTS "daily_track_enabled" boolean NOT NULL DEFAULT false`);

    // ---- Daily checklist submissions ----
    // The unique index makes the one AM/PM submission per site/day invariant
    // durable across concurrent POST requests.
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS "daily_checklist_submissions" (
        "id" serial PRIMARY KEY,
        "client_id" integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
        "site_id" integer NOT NULL REFERENCES "sites"("id") ON DELETE CASCADE,
        "checklist_date" text NOT NULL,
        "type" text NOT NULL,
        "answers" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "submitted_by_id" integer REFERENCES "users"("id") ON DELETE SET NULL,
        "submitted_by_name" text,
        "submitted_at" timestamp,
        "signed_off_by_id" integer REFERENCES "users"("id") ON DELETE SET NULL,
        "signed_off_by_name" text,
        "signed_off_at" timestamp,
        "sign_off_notes" text,
        "created_at" timestamp NOT NULL DEFAULT now(),
        "updated_at" timestamp NOT NULL DEFAULT now()
      )
    `);
    await db.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_daily_checklist_submissions_client_site_date_type"
      ON "daily_checklist_submissions" ("client_id", "site_id", "checklist_date", "type")
    `);

    logger.info("Runtime migrations complete");
  } catch (err) {
    logger.error({ err }, "Runtime migrations failed");
    throw err;
  }
}

// ---- Shared operational action register ----
async function migrateTrackActions() {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "track_actions" (
      "id" serial PRIMARY KEY,
      "client_id" integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "site_id" integer REFERENCES "sites"("id") ON DELETE SET NULL,
      "module" text NOT NULL,
      "source_kind" text,
      "source_record_id" integer,
      "template_id" integer,
      "provenance" text NOT NULL DEFAULT 'one_off',
      "title" text NOT NULL,
      "instruction" text,
      "severity" text NOT NULL DEFAULT 'action_required'
        CHECK ("severity" IN ('monitor', 'action_required', 'urgent')),
      "owner_name" text,
      "lead_time_days" integer,
      "due_date" date,
      "remedial_action" text,
      "evidence_reference" text,
      "resolution_notes" text,
      "status" text NOT NULL DEFAULT 'open'
        CHECK ("status" IN ('open', 'in_progress', 'resolved')),
      "created_by" integer REFERENCES "users"("id") ON DELETE SET NULL,
      "resolved_by" integer REFERENCES "users"("id") ON DELETE SET NULL,
      "resolved_at" timestamp,
      "created_at" timestamp NOT NULL DEFAULT now(),
      "updated_at" timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "IDX_track_actions_client_module_status"
    ON "track_actions" ("client_id", "module", "status")
  `);
  // The catalogue must exist before legacy track_actions installs can add its
  // foreign key below.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "track_action_templates" (
      "id" serial PRIMARY KEY,
      "client_id" integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "module" text NOT NULL,
      "site_id" integer REFERENCES "sites"("id") ON DELETE CASCADE,
      "department_id" integer REFERENCES "departments"("id") ON DELETE CASCADE,
      "title" text NOT NULL,
      "instruction" text,
      "severity" text NOT NULL DEFAULT 'action_required'
        CHECK ("severity" IN ('monitor', 'action_required', 'urgent')),
      "owner_default" text,
      "lead_time_days" integer NOT NULL DEFAULT 0 CHECK ("lead_time_days" >= 0),
      "sort_order" integer NOT NULL DEFAULT 0,
      "active" boolean NOT NULL DEFAULT true,
      "created_at" timestamp NOT NULL DEFAULT now(),
      "updated_at" timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "IDX_track_actions_site"
    ON "track_actions" ("site_id")
  `);
  // Earlier installs created this column as required. Automated records do not
  // have a human creator, whereas API-created records continue to set it.
  await db.execute(sql`ALTER TABLE "track_actions" ALTER COLUMN "created_by" DROP NOT NULL`);
  // A source record ID is only unique within its table. Preserve old rows
  // (whose source_kind remains NULL) while making new automated actions
  // collision-safe across the Green and Swim source tables.
  await db.execute(sql`ALTER TABLE "track_actions" ADD COLUMN IF NOT EXISTS "source_kind" text`);
  await db.execute(sql`ALTER TABLE "track_actions" ADD COLUMN IF NOT EXISTS "template_id" integer`);
  await db.execute(sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'track_actions_template_id_fkey'
          AND conrelid = 'track_actions'::regclass
      ) THEN
        ALTER TABLE "track_actions"
          ADD CONSTRAINT "track_actions_template_id_fkey"
          FOREIGN KEY ("template_id") REFERENCES "track_action_templates"("id") ON DELETE SET NULL;
      END IF;
    END $$
  `);
  await db.execute(sql`ALTER TABLE "track_actions" ADD COLUMN IF NOT EXISTS "provenance" text NOT NULL DEFAULT 'one_off'`);
  await db.execute(sql`ALTER TABLE "track_actions" ADD COLUMN IF NOT EXISTS "instruction" text`);
  await db.execute(sql`ALTER TABLE "track_actions" ADD COLUMN IF NOT EXISTS "lead_time_days" integer`);
  await db.execute(sql`UPDATE "track_actions" SET "provenance" = 'product_default' WHERE "source_kind" IS NOT NULL`);
  await db.execute(sql`ALTER TABLE "track_action_templates" ALTER COLUMN "module" DROP NOT NULL`);
  await db.execute(sql`DROP INDEX IF EXISTS "UQ_track_actions_source"`);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS "UQ_track_actions_source"
    ON "track_actions" ("client_id", "module", "source_kind", "source_record_id")
    WHERE "source_kind" IS NOT NULL AND "source_record_id" IS NOT NULL
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "IDX_track_action_templates_match"
    ON "track_action_templates" ("client_id", "module", "active", "site_id", "department_id", "sort_order")
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "track_action_reminder_log" (
      "id" serial PRIMARY KEY,
      "client_id" integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "log_date" date NOT NULL,
      "sent_at" timestamp NOT NULL DEFAULT now(),
      UNIQUE ("client_id", "log_date")
    )
  `);

  // A generic JSONB trigger keeps this independent from source-table schema
  // drift: some operational tables do not have check_type/follow_up_date (or
  // created_by), and to_jsonb(NEW) makes those optional safely readable.
  // TG_ARGV[1] names the source result column (normally result, but some
  // operational records use overall_result).
  await db.execute(sql`
    CREATE OR REPLACE FUNCTION "sync_track_action_from_source"()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    DECLARE
      record_json jsonb := to_jsonb(NEW);
      source_result text := lower(coalesce(record_json->>coalesce(TG_ARGV[1], 'result'), ''));
      source_action_severity text := lower(coalesce(record_json->>'action_severity', ''));
      action_severity text;
      action_title text;
      action_due_date date;
      source_site_id integer;
    BEGIN
      IF source_result NOT IN (
        'monitor', 'fail', 'failed', 'action_required', 'urgent_action',
        'urgent', 'out_of_range', 'unsafe'
      ) THEN
        RETURN NEW;
      END IF;

      action_severity := CASE
        WHEN source_action_severity IN ('monitor', 'action_required', 'urgent_action')
          THEN CASE source_action_severity
            WHEN 'urgent_action' THEN 'urgent'
            ELSE source_action_severity
          END
        WHEN source_result = 'monitor' THEN 'monitor'
        WHEN source_result IN ('urgent_action', 'urgent', 'out_of_range', 'unsafe') THEN 'urgent'
        ELSE 'action_required'
      END;
      action_title := coalesce(
        nullif(initcap(replace(record_json->>'check_type', '_', ' ')), ''),
        initcap(replace(TG_ARGV[0], '_', ' ')) || ' check'
      );
      IF nullif(record_json->>'follow_up_date', '') IS NOT NULL THEN
        action_due_date := (record_json->>'follow_up_date')::date;
      END IF;
      source_site_id := nullif(record_json->>'site_id', '')::integer;
      -- Green PUWER checks are machine-scoped. Resolve their site through the
      -- machine when the check row itself has no site_id, so department
      -- filtering remains as strict as for directly site-scoped records.
      IF TG_ARGV[0] = 'green'
        AND source_site_id IS NULL
        AND nullif(record_json->>'machine_id', '') IS NOT NULL THEN
        SELECT site_id INTO source_site_id
        FROM green_machines
        WHERE id = (record_json->>'machine_id')::integer
          AND client_id = (record_json->>'client_id')::integer;
      END IF;
      -- PAT tests are appliance-scoped; only accept the appliance site from
      -- the same tenant as the test record.
      IF TG_ARGV[0] = 'pat'
        AND nullif(record_json->>'appliance_id', '') IS NOT NULL THEN
        SELECT site_id INTO source_site_id
        FROM pat_appliances
        WHERE id = (record_json->>'appliance_id')::integer
          AND client_id = (record_json->>'client_id')::integer;
      END IF;
      -- Bike checks can inherit a site from their hire, falling back to the
      -- bike's registered site. Both joins are tenant constrained.
      IF TG_ARGV[0] = 'bike'
        AND nullif(record_json->>'bike_id', '') IS NOT NULL THEN
        SELECT coalesce(h.site_id, b.site_id) INTO source_site_id
        FROM bikes b
        LEFT JOIN bike_hire_records h
          ON h.id = nullif(record_json->>'hire_record_id', '')::integer
         AND h.client_id = b.client_id
        WHERE b.id = (record_json->>'bike_id')::integer
          AND b.client_id = (record_json->>'client_id')::integer;
      END IF;
      -- Never attach an action to another tenant's site, including where a
      -- legacy source row contains an invalid site_id.
      IF source_site_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM sites
        WHERE id = source_site_id
          AND client_id = (record_json->>'client_id')::integer
      ) THEN
        source_site_id := NULL;
      END IF;

      INSERT INTO "track_actions" (
        "client_id", "site_id", "module", "source_kind", "source_record_id", "title",
        "provenance", "severity", "due_date", "status"
      )
      VALUES (
        (record_json->>'client_id')::integer,
        source_site_id,
        TG_ARGV[0],
        TG_ARGV[2],
        (record_json->>'id')::integer,
        action_title,
        'product_default',
        action_severity,
        action_due_date,
        'open'
      )
      ON CONFLICT ("client_id", "module", "source_kind", "source_record_id")
        WHERE "source_kind" IS NOT NULL AND "source_record_id" IS NOT NULL
      DO NOTHING;
      RETURN NEW;
    END;
    $$
  `);
  await db.execute(sql`
    DO $$
    DECLARE
       source_table text;
       module_key text;
       result_column text;
    BEGIN
       FOR source_table, module_key, result_column IN
        SELECT * FROM (VALUES
          ('fire_safety_checks', 'fire', 'result'),
          ('legionella_checks', 'legionella', 'result'),
          ('pool_checks', 'pool', 'result'),
          ('hot_tub_checks', 'hot_tub', 'result'),
          ('tree_inspections', 'tree', 'result'),
          ('green_pre_use_checks', 'green', 'result'),
          ('green_puwer_inspections', 'green', 'result'),
          ('swim_sessions', 'swim', 'result'),
          ('swim_surveillance_checks', 'swim', 'result'),
          ('swim_first_aid_checks', 'swim', 'result'),
          ('pat_tests', 'pat', 'result'),
          ('bike_checks', 'bike', 'overall_result'),
          ('kitchen_probe_checks', 'kitchen', 'overall_result'),
          ('kitchen_weekly_records', 'kitchen', 'overall_result')
        ) AS sources(table_name, module_name, result_column_name)
      LOOP
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = source_table
            AND column_name IN ('id', 'client_id', result_column)
          GROUP BY table_name HAVING count(DISTINCT column_name) = 3
        ) THEN
          EXECUTE format('DROP TRIGGER IF EXISTS sync_track_action_on_result ON public.%I', source_table);
          EXECUTE format(
            'CREATE TRIGGER sync_track_action_on_result
             AFTER INSERT OR UPDATE OF %I ON public.%I
             FOR EACH ROW EXECUTE FUNCTION sync_track_action_from_source(%L, %L, %L)',
             result_column, source_table, module_key, result_column, source_table
          );
        END IF;
      END LOOP;
    END $$
  `);
}

// ---- 2026-08 audit fixes: schema drift between routes and migrations ----
async function migrateAuditFixes2026_08() {
  // StaffRoster: route reads/writes a single "name" field.
  await db.execute(sql`ALTER TABLE "staff_roster" ADD COLUMN IF NOT EXISTS "name" text NOT NULL DEFAULT ''`);
  // Some databases predate first_name/last_name (or never had them) — guard everything.
  await db.execute(sql`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'staff_roster' AND column_name = 'first_name'
      ) THEN
        UPDATE "staff_roster"
        SET "name" = trim(concat_ws(' ', "first_name", "last_name"))
        WHERE "name" = '' AND (coalesce("first_name", '') <> '' OR coalesce("last_name", '') <> '');
        ALTER TABLE "staff_roster" ALTER COLUMN "first_name" DROP NOT NULL;
        ALTER TABLE "staff_roster" ALTER COLUMN "last_name" DROP NOT NULL;
      END IF;
    END $$;
  `);

  // DocTrack: route stores files in object storage under "object_path".
  await db.execute(sql`ALTER TABLE "doc_track_documents" ADD COLUMN IF NOT EXISTS "object_path" text`);

  // TrainTrack: record_type (certificate/signoff/internal) is distinct from training_type,
  // plus every other column the current route reads/writes that older installs may lack.
  await db.execute(sql`ALTER TABLE "train_track_records" ADD COLUMN IF NOT EXISTS "record_type" text NOT NULL DEFAULT 'internal'`);
  await db.execute(sql`ALTER TABLE "train_track_records" ADD COLUMN IF NOT EXISTS "document_title" text`);
  await db.execute(sql`ALTER TABLE "train_track_records" ADD COLUMN IF NOT EXISTS "document_type" text`);
  await db.execute(sql`ALTER TABLE "train_track_records" ADD COLUMN IF NOT EXISTS "provider" text`);
  await db.execute(sql`ALTER TABLE "train_track_records" ADD COLUMN IF NOT EXISTS "trainer" text`);
  await db.execute(sql`ALTER TABLE "train_track_records" ADD COLUMN IF NOT EXISTS "completed_date" date`);
  await db.execute(sql`ALTER TABLE "train_track_records" ADD COLUMN IF NOT EXISTS "expiry_date" date`);
  await db.execute(sql`ALTER TABLE "train_track_records" ADD COLUMN IF NOT EXISTS "notes" text`);
  await db.execute(sql`ALTER TABLE "train_track_records" ADD COLUMN IF NOT EXISTS "signature" text`);
  // Early TrainTrack installs used training_title/training_date as mandatory
  // fields. Backfill the route's canonical fields, then make those retired
  // columns optional so sign-off inserts work on upgraded databases as well.
  await db.execute(sql`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'train_track_records' AND column_name = 'training_date') THEN
        EXECUTE 'UPDATE train_track_records SET completed_date = training_date WHERE completed_date IS NULL';
        EXECUTE 'ALTER TABLE train_track_records ALTER COLUMN training_date DROP NOT NULL';
      END IF;
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'train_track_records' AND column_name = 'training_title') THEN
        EXECUTE 'UPDATE train_track_records SET training_type = training_title WHERE training_type IS NULL OR training_type = ''internal''';
        EXECUTE 'ALTER TABLE train_track_records ALTER COLUMN training_title DROP NOT NULL';
      END IF;
    END $$;
  `);

  // KitchenTrack weekly review + probe checks tables (referenced by kitchen-weekly.ts and food-safety.ts).
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "kitchen_weekly_records" (
      "id" serial PRIMARY KEY,
      "client_id" integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "site_id" integer REFERENCES "sites"("id") ON DELETE SET NULL,
      "week_commencing" date NOT NULL,
      "checks" jsonb NOT NULL DEFAULT '[]',
      "overall_result" text,
      "deviations" jsonb NOT NULL DEFAULT '[]',
      "additional" jsonb NOT NULL DEFAULT '[]',
      "manager_signature" text,
      "submitted_at" timestamp,
      "created_by" integer REFERENCES "users"("id") ON DELETE SET NULL,
      "created_at" timestamp NOT NULL DEFAULT now(),
      "updated_at" timestamp NOT NULL DEFAULT now()
    )
  `);
  // New submitted reviews can carry a computed canonical result. Existing
  // historical rows are intentionally not backfilled.
  await db.execute(sql`ALTER TABLE "kitchen_weekly_records" ADD COLUMN IF NOT EXISTS "overall_result" text`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "IDX_kitchen_weekly_client" ON "kitchen_weekly_records" ("client_id")`);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "kitchen_probe_checks" (
      "id" serial PRIMARY KEY,
      "client_id" integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "site_id" integer REFERENCES "sites"("id") ON DELETE SET NULL,
      "check_date" date NOT NULL,
      "probes" jsonb NOT NULL DEFAULT '[]',
      "overall_result" text,
      "checked_by" text,
      "signature" text,
      "notes" text,
      "submitted_at" timestamp,
      "created_by" integer REFERENCES "users"("id") ON DELETE SET NULL,
      "created_at" timestamp NOT NULL DEFAULT now(),
      "updated_at" timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "IDX_kitchen_probe_client" ON "kitchen_probe_checks" ("client_id")`);
}

async function migrateLegacyCategories() {
  await db.execute(sql`ALTER TABLE "categories" ADD COLUMN IF NOT EXISTS "parent_id" integer REFERENCES "categories"("id") ON DELETE SET NULL`);
  await db.execute(sql`ALTER TABLE "categories" ADD COLUMN IF NOT EXISTS "description" text`);
  await db.execute(sql`ALTER TABLE "categories" ADD COLUMN IF NOT EXISTS "updated_at" timestamp NOT NULL DEFAULT now()`);
  await db.execute(sql`ALTER TABLE "compliance_items" ADD COLUMN IF NOT EXISTS "site_id" integer REFERENCES "sites"("id") ON DELETE SET NULL`);
  await db.execute(sql`ALTER TABLE "compliance_items" ADD COLUMN IF NOT EXISTS "responsible_person" text`);
  await db.execute(sql`ALTER TABLE "compliance_items" ADD COLUMN IF NOT EXISTS "custom_frequency_days" integer`);
  await db.execute(sql`ALTER TABLE "compliance_items" ADD COLUMN IF NOT EXISTS "updated_at" timestamp NOT NULL DEFAULT now()`);
  // Module keys selected on the pricing page at signup — pre-ticks post-trial checkout
  await db.execute(sql`ALTER TABLE "clients" ADD COLUMN IF NOT EXISTS "selected_services" jsonb`);
  // check_records only exists in older installs — skip gracefully if absent
  await db.execute(sql`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'check_records' AND table_schema = 'public') THEN
        ALTER TABLE "check_records" ADD COLUMN IF NOT EXISTS "site_id" integer REFERENCES "sites"("id") ON DELETE SET NULL;
      END IF;
    END $$
  `);
}

// ---- TrainTrack ----
async function migrateTrainTrack() {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "train_track_records" (
      "id" serial PRIMARY KEY,
      "client_id" integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "site_id" integer REFERENCES "sites"("id") ON DELETE SET NULL,
      "record_type" text NOT NULL DEFAULT 'internal',
      "staff_name" text NOT NULL,
      "training_type" text,
      "document_title" text,
      "document_type" text,
      "provider" text,
      "trainer" text,
      "completed_date" date NOT NULL,
      "expiry_date" date,
      "notes" text,
      "signature" text,
      "created_at" timestamp NOT NULL DEFAULT now(),
      "updated_at" timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "IDX_train_track_client" ON "train_track_records" ("client_id")`);
}

// ---- SafeTrack handbook ----
async function migrateSafeHandbook() {
  await db.execute(sql`ALTER TABLE "safe_handbook" ADD COLUMN IF NOT EXISTS "site_id" integer REFERENCES "sites"("id") ON DELETE SET NULL`);
}

// ---- Hot tub registry ----
async function migrateHotTub() {
  await db.execute(sql`ALTER TABLE "hot_tub_checks" ADD COLUMN IF NOT EXISTS "hot_tub_id" integer`);
  await db.execute(sql`ALTER TABLE "hot_tub_checks" ADD COLUMN IF NOT EXISTS "session" text CHECK ("session" IN ('morning', 'midday', 'evening'))`);
}

async function migrateHotTubRegistry() {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "hot_tubs" (
      "id" serial PRIMARY KEY,
      "client_id" integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "site_id" integer REFERENCES "sites"("id") ON DELETE SET NULL,
      "name" text NOT NULL,
      "model" text,
      "serial_number" text,
      "location" text,
      "capacity_litres" integer,
      "commissioned_date" date,
      "next_service_date" date,
      "notes" text,
      "active" boolean NOT NULL DEFAULT true,
      "created_at" timestamp NOT NULL DEFAULT now(),
      "updated_at" timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "IDX_hot_tubs_client" ON "hot_tubs" ("client_id")`);
}

// ---- TreeTrack ----
async function migrateTreeTrack() {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "tree_inspections" (
      "id" serial PRIMARY KEY,
      "client_id" integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "site_id" integer REFERENCES "sites"("id") ON DELETE SET NULL,
      "tree_ref" text NOT NULL,
      "species" text,
      "location" text,
      "check_type" text NOT NULL,
      "inspection_date" date NOT NULL,
      "inspector_name" text,
      "condition" text,
      "height_m" numeric(5,1),
      "canopy_spread_m" numeric(5,1),
      "defects_found" boolean DEFAULT false,
      "defect_description" text,
      "recommended_works" text,
      "urgency" text,
      "next_inspection_date" date,
      "result" text NOT NULL DEFAULT 'pass',
      "notes" text,
      "created_at" timestamp NOT NULL DEFAULT now(),
      "updated_at" timestamp NOT NULL DEFAULT now()
    )
  `);
  // Remediation priority is distinct from the pass/fail observation. Older
  // rows used result for both concepts; leave those values untouched.
  await db.execute(sql`
    ALTER TABLE "tree_inspections"
    ADD COLUMN IF NOT EXISTS "action_severity" text
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "IDX_tree_inspections_client" ON "tree_inspections" ("client_id")`);
}

// ---- BikeTrack ----
async function migrateBikeTrack() {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "bikes" (
      "id" serial PRIMARY KEY,
      "client_id" integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "site_id" integer REFERENCES "sites"("id") ON DELETE SET NULL,
      "name" text NOT NULL,
      "bike_type" text NOT NULL DEFAULT 'standard',
      "serial_number" text,
      "colour" text,
      "size" text,
      "status" text NOT NULL DEFAULT 'available',
      "notes" text,
      "active" boolean NOT NULL DEFAULT true,
      "created_at" timestamp NOT NULL DEFAULT now(),
      "updated_at" timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "IDX_bikes_client" ON "bikes" ("client_id")`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "bike_hire_records" (
      "id" serial PRIMARY KEY,
      "client_id" integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "bike_id" integer NOT NULL REFERENCES "bikes"("id") ON DELETE CASCADE,
      "hirer_name" text NOT NULL,
      "hirer_contact" text,
      "hire_start" timestamp NOT NULL DEFAULT now(),
      "expected_return" timestamp,
      "actual_return" timestamp,
      "pre_check_passed" boolean NOT NULL DEFAULT true,
      "post_check_passed" boolean,
      "hire_fee" numeric(8,2),
      "deposit_taken" numeric(8,2),
      "notes" text,
      "status" text NOT NULL DEFAULT 'active',
      "created_at" timestamp NOT NULL DEFAULT now(),
      "updated_at" timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "IDX_bike_hire_client" ON "bike_hire_records" ("client_id")`);
  await db.execute(sql`ALTER TABLE "bike_hire_records" ADD COLUMN IF NOT EXISTS "overdue_notified_at" timestamp`);
  await db.execute(sql`ALTER TABLE "bike_hire_records" ADD COLUMN IF NOT EXISTS "overdue_notification_claim_token" text`);
  await db.execute(sql`ALTER TABLE "bike_hire_records" ADD COLUMN IF NOT EXISTS "overdue_notification_claimed_at" timestamp`);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "IDX_bike_hire_overdue_alerts"
    ON "bike_hire_records" ("client_id", "status", "return_date_expected", "overdue_notified_at")
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "bike_checks" (
      "id" serial PRIMARY KEY,
      "client_id" integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "bike_id" integer NOT NULL REFERENCES "bikes"("id") ON DELETE CASCADE,
      "hire_record_id" integer REFERENCES "bike_hire_records"("id") ON DELETE SET NULL,
      "check_type" text NOT NULL DEFAULT 'pre_hire',
      "check_date" timestamp NOT NULL DEFAULT now(),
      "performed_by" text,
      "items_checked" jsonb,
      "result" text NOT NULL DEFAULT 'pass',
      "notes" text,
      "created_at" timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "IDX_bike_checks_bike" ON "bike_checks" ("bike_id")`);
}

async function migrateBikeServices() {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "bike_services" (
      "id" serial PRIMARY KEY,
      "client_id" integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "bike_id" integer NOT NULL REFERENCES "bikes"("id") ON DELETE CASCADE,
      "service_date" date NOT NULL,
      "service_type" text NOT NULL DEFAULT 'annual',
      "performed_by" text,
      "work_carried_out" text,
      "parts_replaced" text,
      "next_service_date" date,
      "cost" numeric(8,2),
      "notes" text,
      "created_at" timestamp NOT NULL DEFAULT now(),
      "updated_at" timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "IDX_bike_services_bike" ON "bike_services" ("bike_id")`);
}

// ---- Two-factor authentication ----
async function migrateTwoFactor() {
  await db.execute(sql`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "totp_secret" text`);
  await db.execute(sql`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "totp_enabled" boolean NOT NULL DEFAULT false`);
  await db.execute(sql`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "totp_recovery_hash" text`);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "totp_recovery_codes" (
      "id" serial PRIMARY KEY,
      "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
      "code_hash" text NOT NULL,
      "used_at" timestamp,
      "created_at" timestamp NOT NULL DEFAULT now(),
      CONSTRAINT "UQ_totp_recovery_codes_hash" UNIQUE ("code_hash")
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "IDX_totp_recovery_codes_user_unused"
    ON "totp_recovery_codes" ("user_id")
    WHERE "used_at" IS NULL
  `);
  // Preserve the one recovery code issued by the previous implementation.
  // Its value was already hashed with the same normalization and SHA-256
  // scheme, so it can safely become the user's first unused row.
  await db.execute(sql`
    INSERT INTO "totp_recovery_codes" ("user_id", "code_hash")
    SELECT "id", "totp_recovery_hash"
    FROM "users"
    WHERE "totp_recovery_hash" IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM "totp_recovery_codes"
        WHERE "totp_recovery_codes"."user_id" = "users"."id"
      )
    ON CONFLICT ("code_hash") DO NOTHING
  `);
}

// ---- Staff roster ----
async function migrateStaffRoster() {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "staff_roster" (
      "id" serial PRIMARY KEY,
      "client_id" integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "site_id" integer REFERENCES "sites"("id") ON DELETE SET NULL,
      "first_name" text NOT NULL,
      "last_name" text NOT NULL,
      "job_title" text,
      "department" text,
      "email" text,
      "phone" text,
      "start_date" date,
      "notes" text,
      "active" boolean NOT NULL DEFAULT true,
      "created_at" timestamp NOT NULL DEFAULT now(),
      "updated_at" timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "IDX_staff_roster_client"
    ON "staff_roster" ("client_id")
  `);
  // requires_acknowledgement flag on documents
  await db.execute(sql`
    ALTER TABLE "doc_track_documents"
    ADD COLUMN IF NOT EXISTS "requires_acknowledgement" boolean NOT NULL DEFAULT false
  `);
}

// ---- Document acknowledgements ----
async function migrateDocAcknowledgements() {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "doc_acknowledgements" (
      "id"                   serial PRIMARY KEY,
      "document_id"          integer NOT NULL REFERENCES "doc_track_documents"("id") ON DELETE CASCADE,
      "client_id"            integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "staff_roster_id"      integer REFERENCES "staff_roster"("id") ON DELETE SET NULL,
      "staff_name"           text NOT NULL,
      "signature"            text,
      "acknowledged_at"      timestamp NOT NULL DEFAULT now(),
      "acknowledged_by"      integer REFERENCES "users"("id") ON DELETE SET NULL,
      "train_track_record_id" integer,
      "created_at"           timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "IDX_doc_ack_document"
    ON "doc_acknowledgements" ("document_id")
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "IDX_doc_ack_client"
    ON "doc_acknowledgements" ("client_id")
  `);
}

// ---- Signature columns across SafeTrack + TrainTrack ----
async function migrateSignatures() {
  // TrainTrack records
  await db.execute(sql`ALTER TABLE "train_track_records" ADD COLUMN IF NOT EXISTS "signature" text`);
  // SafeTrack: risk assessments, SOPs, handbook
  await db.execute(sql`ALTER TABLE "safe_risk_assessments" ADD COLUMN IF NOT EXISTS "signature" text`);
  await db.execute(sql`ALTER TABLE "safe_sops" ADD COLUMN IF NOT EXISTS "signature" text`);
  await db.execute(sql`ALTER TABLE "safe_handbook" ADD COLUMN IF NOT EXISTS "signature" text`);
  // File attachments and acknowledgements for SafeTrack documents
  for (const tbl of ["safe_risk_assessments", "safe_sops", "safe_handbook"]) {
    await db.execute(sql.raw(`ALTER TABLE "${tbl}" ADD COLUMN IF NOT EXISTS "object_path" text`));
    await db.execute(sql.raw(`ALTER TABLE "${tbl}" ADD COLUMN IF NOT EXISTS "file_name" text`));
    await db.execute(sql.raw(`ALTER TABLE "${tbl}" ADD COLUMN IF NOT EXISTS "file_size" bigint`));
    await db.execute(sql.raw(`ALTER TABLE "${tbl}" ADD COLUMN IF NOT EXISTS "mime_type" text`));
    await db.execute(sql.raw(`ALTER TABLE "${tbl}" ADD COLUMN IF NOT EXISTS "requires_acknowledgement" boolean NOT NULL DEFAULT false`));
    await db.execute(sql.raw(`ALTER TABLE "${tbl}" ADD COLUMN IF NOT EXISTS "department_id" integer REFERENCES "departments"("id") ON DELETE SET NULL`));
  }
  // SafeTrack acknowledgements table
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "safe_track_acknowledgements" (
      "id"               serial PRIMARY KEY,
      "client_id"        integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "document_type"    text NOT NULL,
      "document_id"      integer NOT NULL,
      "staff_roster_id"  integer REFERENCES "staff_roster"("id") ON DELETE SET NULL,
      "staff_name"       text NOT NULL,
      "signature"        text,
      "acknowledged_at"  timestamp NOT NULL DEFAULT now(),
      "acknowledged_by"  integer REFERENCES "users"("id") ON DELETE SET NULL
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "IDX_safe_track_acks_doc" ON "safe_track_acknowledgements" ("document_type", "document_id")`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "IDX_safe_track_acks_client" ON "safe_track_acknowledgements" ("client_id")`);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_safe_track_acks_unique" ON "safe_track_acknowledgements" ("document_type", "document_id", "staff_roster_id") WHERE "staff_roster_id" IS NOT NULL`);
}

// ---- SafeTrack acknowledgement reminder de-duplication ----
async function migrateSafeTrackAckReminderLog() {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "safe_track_ack_reminder_log" (
      "id" serial PRIMARY KEY,
      "client_id" integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "sent_at" timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "IDX_safe_track_ack_reminder_client"
    ON "safe_track_ack_reminder_log" ("client_id", "sent_at")
  `);
}

// ---- Department field on documents + sign-off token on clients ----
async function migrateDocDepartment() {
  // Add department tag to doc_track_documents
  await db.execute(sql`
    ALTER TABLE "doc_track_documents"
    ADD COLUMN IF NOT EXISTS "department" text
  `);

  // Add sign_off_token to clients table
  await db.execute(sql`
    ALTER TABLE "clients"
    ADD COLUMN IF NOT EXISTS "sign_off_token" text
  `);

  // Generate tokens for any clients that don't have one yet
  // Uses md5 of id+random to avoid needing pgcrypto extension
  await db.execute(sql`
    UPDATE "clients"
    SET "sign_off_token" = md5(concat(id::text, '-', random()::text, '-', now()::text))
    WHERE "sign_off_token" IS NULL
  `);

  // Add unique constraint (safe to run multiple times via DO block)
  await db.execute(sql`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'uq_clients_sign_off_token'
      ) THEN
        ALTER TABLE "clients" ADD CONSTRAINT "uq_clients_sign_off_token" UNIQUE ("sign_off_token");
      END IF;
    END $$
  `);
}

// ---- Pool Track ----
async function migratePoolTrack() {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "pool_checks" (
      "id"                 serial PRIMARY KEY,
      "client_id"          integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "site_id"            integer REFERENCES "sites"("id") ON DELETE SET NULL,
      "check_date"         date NOT NULL,
      "check_time"         text,
      "check_type"         text NOT NULL DEFAULT 'routine',
      "ph_level"           numeric(4,2),
      "free_chlorine"      numeric(4,2),
      "combined_chlorine"  numeric(4,2),
      "water_temp_c"       numeric(4,1),
      "air_temp_c"         numeric(4,1),
      "turbidity"          text,
      "pool_open"          boolean NOT NULL DEFAULT true,
      "performed_by"       text,
      "actions_taken"      text,
      "result"             text NOT NULL DEFAULT 'pass',
      "notes"              text,
      "created_at"         timestamp NOT NULL DEFAULT now(),
      "updated_at"         timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "IDX_pool_checks_client_date"
    ON "pool_checks" ("client_id", "check_date")
  `);
}

// ---- Green Track ----
async function migrateGreenTrack() {
  // Machine fleet register
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "green_machines" (
      "id"         serial PRIMARY KEY,
      "client_id"  integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "site_id"    integer REFERENCES "sites"("id") ON DELETE SET NULL,
      "name"       text NOT NULL,
      "type"       text NOT NULL DEFAULT 'other',
      "make"       text,
      "model"      text,
      "serial_no"  text,
      "year"       integer,
      "reg_no"     text,
      "active"     boolean NOT NULL DEFAULT true,
      "notes"      text,
      "created_at" timestamp NOT NULL DEFAULT now(),
      "updated_at" timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "IDX_green_machines_client"
    ON "green_machines" ("client_id")
  `);

  // Daily pre-use operator checks (PUWER Reg 5)
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "green_pre_use_checks" (
      "id"              serial PRIMARY KEY,
      "client_id"       integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "machine_id"      integer NOT NULL REFERENCES "green_machines"("id") ON DELETE CASCADE,
      "check_date"      date NOT NULL,
      "operator"        text,
      "fluid_levels_ok" boolean,
      "tyres_ok"        boolean,
      "blades_ok"       boolean,
      "guards_ok"       boolean,
      "controls_ok"     boolean,
      "lights_ok"       boolean,
      "cleanliness_ok"  boolean,
      "defect_noted"    boolean NOT NULL DEFAULT false,
      "result"          text NOT NULL DEFAULT 'pass',
      "notes"           text,
      "created_at"      timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "IDX_green_pre_use_client_date"
    ON "green_pre_use_checks" ("client_id", "check_date")
  `);

  // Scheduled service records
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "green_service_records" (
      "id"                 serial PRIMARY KEY,
      "client_id"          integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "machine_id"         integer NOT NULL REFERENCES "green_machines"("id") ON DELETE CASCADE,
      "service_date"       date NOT NULL,
      "service_type"       text NOT NULL DEFAULT 'scheduled',
      "hours_at_service"   integer,
      "next_service_hours" integer,
      "next_service_date"  date,
      "work_performed"     text,
      "serviced_by"        text,
      "cost_pence"         integer,
      "notes"              text,
      "created_at"         timestamp NOT NULL DEFAULT now(),
      "updated_at"         timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "IDX_green_service_client_machine"
    ON "green_service_records" ("client_id", "machine_id")
  `);

  // Defect / breakdown reports
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "green_defects" (
      "id"            serial PRIMARY KEY,
      "client_id"     integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "machine_id"    integer NOT NULL REFERENCES "green_machines"("id") ON DELETE CASCADE,
      "report_date"   date NOT NULL,
      "reported_by"   text,
      "description"   text NOT NULL,
      "severity"      text NOT NULL DEFAULT 'minor',
      "out_of_service" boolean NOT NULL DEFAULT false,
      "status"        text NOT NULL DEFAULT 'open',
      "resolution"    text,
      "resolved_date" date,
      "notes"         text,
      "created_at"    timestamp NOT NULL DEFAULT now(),
      "updated_at"    timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "IDX_green_defects_client_status"
    ON "green_defects" ("client_id", "status")
  `);

  // PUWER statutory thorough examinations
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "green_puwer_inspections" (
      "id"                  serial PRIMARY KEY,
      "client_id"           integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "machine_id"          integer NOT NULL REFERENCES "green_machines"("id") ON DELETE CASCADE,
      "inspection_date"     date NOT NULL,
      "next_inspection_date" date,
      "inspection_type"     text NOT NULL DEFAULT 'thorough_examination',
      "inspector_name"      text,
      "inspector_company"   text,
      "cert_ref"            text,
      "safe_to_operate"     boolean NOT NULL DEFAULT true,
      "defects_found"       text,
      "result"              text NOT NULL DEFAULT 'pass',
      "notes"               text,
      "created_at"          timestamp NOT NULL DEFAULT now(),
      "updated_at"          timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "IDX_green_puwer_client_machine"
    ON "green_puwer_inspections" ("client_id", "machine_id")
  `);

  // Fuel & oil usage logs
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "green_fuel_logs" (
      "id"              serial PRIMARY KEY,
      "client_id"       integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "machine_id"      integer NOT NULL REFERENCES "green_machines"("id") ON DELETE CASCADE,
      "log_date"        date NOT NULL,
      "fuel_type"       text NOT NULL DEFAULT 'diesel',
      "quantity_litres" numeric(6,2),
      "engine_hours"    integer,
      "cost_pence"      integer,
      "filled_by"       text,
      "notes"           text,
      "created_at"      timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "IDX_green_fuel_client_machine"
    ON "green_fuel_logs" ("client_id", "machine_id")
  `);
}

// ---- SwimTrack ----
async function migrateSwimTrack() {
  // Pool session log
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "swim_sessions" (
      "id"                  serial PRIMARY KEY,
      "client_id"           integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "site_id"             integer REFERENCES "sites"("id") ON DELETE SET NULL,
      "session_date"        date NOT NULL,
      "session_type"        text NOT NULL DEFAULT 'public_swim',
      "lifeguard_name"      text,
      "open_time"           time,
      "close_time"          time,
      "max_bathers"         integer,
      "bather_count_peak"   integer,
      "pre_session_result"  text NOT NULL DEFAULT 'pass',
      "pre_session_notes"   text,
      "pool_closed"         boolean NOT NULL DEFAULT false,
      "closure_reason"      text,
      "notes"               text,
      "result"              text NOT NULL DEFAULT 'pass',
      "created_at"          timestamp NOT NULL DEFAULT now(),
      "updated_at"          timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "IDX_swim_sessions_client_date"
    ON "swim_sessions" ("client_id", "session_date")
  `);

  // Periodic lifeguard surveillance checks (every 15-20 min during session)
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "swim_surveillance_checks" (
      "id"            serial PRIMARY KEY,
      "client_id"     integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "session_id"    integer REFERENCES "swim_sessions"("id") ON DELETE SET NULL,
      "site_id"       integer REFERENCES "sites"("id") ON DELETE SET NULL,
      "check_date"    date NOT NULL,
      "check_time"    time,
      "bather_count"  integer,
      "scan_completed" boolean NOT NULL DEFAULT true,
      "observations"  text,
      "checked_by"    text,
      "result"        text NOT NULL DEFAULT 'pass',
      "created_at"    timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "IDX_swim_surveillance_client_date"
    ON "swim_surveillance_checks" ("client_id", "check_date")
  `);

  // First-aid and rescue equipment readiness checks
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "swim_first_aid_checks" (
      "id"              serial PRIMARY KEY,
      "client_id"       integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "site_id"         integer REFERENCES "sites"("id") ON DELETE SET NULL,
      "check_date"      date NOT NULL,
      "aed_ok"          boolean NOT NULL DEFAULT true,
      "first_aid_kit_ok" boolean NOT NULL DEFAULT true,
      "rescue_pole_ok"  boolean NOT NULL DEFAULT true,
      "throw_bag_ok"    boolean NOT NULL DEFAULT true,
      "spine_board_ok"  boolean NOT NULL DEFAULT true,
      "ring_buoy_ok"    boolean NOT NULL DEFAULT true,
      "oxygen_kit_ok"   boolean NOT NULL DEFAULT true,
      "checked_by"      text,
      "defects_found"   text,
      "notes"           text,
      "result"          text NOT NULL DEFAULT 'pass',
      "created_at"      timestamp NOT NULL DEFAULT now(),
      "updated_at"      timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "IDX_swim_first_aid_client_date"
    ON "swim_first_aid_checks" ("client_id", "check_date")
  `);

  // Incident and near-miss log
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "swim_incidents" (
      "id"                serial PRIMARY KEY,
      "client_id"         integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "site_id"           integer REFERENCES "sites"("id") ON DELETE SET NULL,
      "incident_date"     date NOT NULL,
      "incident_time"     time,
      "incident_type"     text NOT NULL DEFAULT 'near_miss',
      "severity"          text NOT NULL DEFAULT 'low',
      "persons_involved"  text,
      "description"       text NOT NULL,
      "action_taken"      text,
      "reported_to"       text,
      "reported_date"     date,
      "outcome"           text,
      "notes"             text,
      "created_at"        timestamp NOT NULL DEFAULT now(),
      "updated_at"        timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "IDX_swim_incidents_client_date"
    ON "swim_incidents" ("client_id", "incident_date")
  `);
}

// ---- Check photos & photo requirements ----
async function migrateCheckPhotos() {
  // Generic photo attachments for any check/record type
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "check_photos" (
      "id"          serial PRIMARY KEY,
      "client_id"   integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "entity_type" text NOT NULL,
      "entity_id"   integer NOT NULL,
      "object_path" text NOT NULL,
      "caption"     text,
      "created_by"  integer REFERENCES "users"("id") ON DELETE SET NULL,
      "created_at"  timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "IDX_check_photos_entity"
    ON "check_photos" ("client_id", "entity_type", "entity_id")
  `);
  // Older callers could attach the same object path more than once. Preserve
  // the oldest row, remove redundant references, then prevent recurrence.
  // This makes backing-object deletion deterministic while the DELETE route
  // still checks for a remaining tenant reference for rollout safety.
  await db.execute(sql`
    DELETE FROM "check_photos" duplicate
    USING "check_photos" keeper
    WHERE duplicate.client_id = keeper.client_id
      AND duplicate.object_path = keeper.object_path
      AND duplicate.id > keeper.id
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS "UQ_check_photos_client_object_path"
    ON "check_photos" ("client_id", "object_path")
  `);

  // Manager-configurable photo requirements per entity type
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "photo_requirements" (
      "id"          serial PRIMARY KEY,
      "client_id"   integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "entity_type" text NOT NULL,
      "required"    boolean NOT NULL DEFAULT false,
      "min_photos"  integer NOT NULL DEFAULT 1,
      "created_at"  timestamp NOT NULL DEFAULT now(),
      "updated_at"  timestamp NOT NULL DEFAULT now(),
      UNIQUE ("client_id", "entity_type")
    )
  `);

  // KitchenTrack originally stored diary photos under food_safety_record.
  // Keep existing attachments and manager requirements visible after the UI
  // adopts the canonical food_safety_check discriminator.
  await db.execute(sql`
    UPDATE "check_photos"
    SET "entity_type" = 'food_safety_check'
    WHERE "entity_type" = 'food_safety_record'
  `);
  await db.execute(sql`
    INSERT INTO "photo_requirements" (
      "client_id", "entity_type", "required", "min_photos", "created_at", "updated_at"
    )
    SELECT
      "client_id", 'food_safety_check', "required", "min_photos", "created_at", "updated_at"
    FROM "photo_requirements"
    WHERE "entity_type" = 'food_safety_record'
    ON CONFLICT ("client_id", "entity_type") DO NOTHING
  `);
  await db.execute(sql`
    DELETE FROM "photo_requirements"
    WHERE "entity_type" = 'food_safety_record'
  `);

  // Manager-customisable checklist templates (per client + optional site + checklist type)
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "checklist_templates" (
      "id"              serial PRIMARY KEY,
      "client_id"       integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "site_id"         integer REFERENCES "sites"("id") ON DELETE CASCADE,
      "checklist_type"  text NOT NULL,
      "items"           jsonb NOT NULL DEFAULT '[]',
      "updated_by"      integer REFERENCES "users"("id") ON DELETE SET NULL,
      "updated_at"      timestamp NOT NULL DEFAULT now()
    )
  `);
  // Partial unique indexes to handle nullable site_id correctly
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS "UQ_checklist_templates_client_type"
    ON "checklist_templates" ("client_id", "checklist_type")
    WHERE "site_id" IS NULL
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS "UQ_checklist_templates_client_site_type"
    ON "checklist_templates" ("client_id", "site_id", "checklist_type")
    WHERE "site_id" IS NOT NULL
  `);

  // Business type on clients (for segmentation and onboarding personalisation)
  await db.execute(sql`
    ALTER TABLE "clients" ADD COLUMN IF NOT EXISTS "business_type" text
  `);

  // Deduplication log for daily check-reminder emails (one digest per client per day)
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "doc_ack_reminder_log" (
      "id" serial PRIMARY KEY,
      "client_id" integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "sent_at" timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "IDX_doc_ack_reminder_client" ON "doc_ack_reminder_log" ("client_id")
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "check_reminder_log" (
      "id"         serial PRIMARY KEY,
      "client_id"  integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "log_date"   date NOT NULL DEFAULT CURRENT_DATE,
      "sent_at"    timestamp NOT NULL DEFAULT now(),
      UNIQUE ("client_id", "log_date")
    )
  `);
}

// ---- FixTrack v2: contractor trades, contractorId on issues, action tokens ----
async function migrateFixTrackV2() {
  // Settings are tenant/key values. Keep the newest historical duplicate
  // before enforcing the invariant needed by atomic upserts.
  await db.execute(sql`
    DELETE FROM "app_settings" older
    USING "app_settings" newer
    WHERE older."client_id" = newer."client_id"
      AND older."key" = newer."key"
      AND older."id" < newer."id"
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS "UQ_app_settings_client_key"
    ON "app_settings" ("client_id", "key")
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "fix_track_issue_activity" (
      "id"         serial PRIMARY KEY,
      "client_id"  integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "issue_id"   integer NOT NULL REFERENCES "fix_track_issues"("id") ON DELETE CASCADE,
      "event_type" text NOT NULL CHECK ("event_type" IN ('status', 'note')),
      "status"     text,
      "note"       text,
      "created_by" integer REFERENCES "users"("id") ON DELETE SET NULL,
      "created_at" timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "IDX_fix_track_issue_activity_issue"
    ON "fix_track_issue_activity" ("issue_id", "created_at")
  `);
  // Earlier installs constrained activity to status/note. The contractor mail
  // workflow is also an audit trail, so replace that generated constraint
  // explicitly rather than relying on CREATE TABLE IF NOT EXISTS.
  await db.execute(sql`
    ALTER TABLE "fix_track_issue_activity"
      DROP CONSTRAINT IF EXISTS "fix_track_issue_activity_event_type_check"
  `);
  await db.execute(sql`
    ALTER TABLE "fix_track_issue_activity"
      ADD CONSTRAINT "fix_track_issue_activity_event_type_check"
      CHECK ("event_type" IN (
        'status', 'note',
        'email_requested', 'email_approved', 'email_rejected',
        'email_invalidated', 'email_sent'
      ))
  `);
  await db.execute(sql`
    INSERT INTO "fix_track_issue_activity" ("client_id", "issue_id", "event_type", "status", "created_by", "created_at")
    SELECT i.client_id, i.id, 'status', 'reported', i.created_by, i.created_at
    FROM "fix_track_issues" i
    WHERE NOT EXISTS (
      SELECT 1 FROM "fix_track_issue_activity" a
      WHERE a.issue_id = i.id AND a.event_type = 'status' AND a.status = 'reported'
    )
  `);
  await db.execute(sql`
    DELETE FROM "fix_track_issue_activity" a
    USING "fix_track_issues" i
    WHERE a.issue_id = i.id
      AND a.event_type = 'status'
      AND CASE a.status
            WHEN 'reported' THEN 0
            WHEN 'in_progress' THEN 1
            WHEN 'resolved' THEN 2
            WHEN 'closed' THEN 3
            ELSE 99
          END
          >
          CASE i.status
            WHEN 'reported' THEN 0
            WHEN 'in_progress' THEN 1
            WHEN 'resolved' THEN 2
            WHEN 'closed' THEN 3
            ELSE 0
          END
  `);
  await db.execute(sql`
    INSERT INTO "fix_track_issue_activity" ("client_id", "issue_id", "event_type", "status", "created_by", "created_at")
    SELECT i.client_id, i.id, 'status', 'resolved', i.created_by, i.resolved_date::timestamp
    FROM "fix_track_issues" i
    WHERE i.resolved_date IS NOT NULL
      AND i.status IN ('resolved', 'closed')
      AND NOT EXISTS (
      SELECT 1 FROM "fix_track_issue_activity" a
      WHERE a.issue_id = i.id AND a.event_type = 'status' AND a.status = 'resolved'
    )
  `);
  await db.execute(sql`
    INSERT INTO "fix_track_issue_activity" ("client_id", "issue_id", "event_type", "status", "created_by", "created_at")
    SELECT i.client_id, i.id, 'status', 'closed', i.created_by, i.updated_at
    FROM "fix_track_issues" i
    WHERE i.status = 'closed' AND NOT EXISTS (
      SELECT 1 FROM "fix_track_issue_activity" a
      WHERE a.issue_id = i.id AND a.event_type = 'status' AND a.status = 'closed'
    )
  `);
  await db.execute(sql`
    INSERT INTO "fix_track_issue_activity" ("client_id", "issue_id", "event_type", "note", "created_by", "created_at")
    SELECT i.client_id, i.id, 'note', i.solution_notes, i.created_by, i.updated_at
    FROM "fix_track_issues" i
    WHERE i.solution_notes IS NOT NULL AND i.solution_notes <> '' AND NOT EXISTS (
      SELECT 1 FROM "fix_track_issue_activity" a
      WHERE a.issue_id = i.id AND a.event_type = 'note'
    )
  `);

  // Contractor trade specialisms (JSONB array matching fix-track issue types)
  await db.execute(sql`
    ALTER TABLE "contractors" ADD COLUMN IF NOT EXISTS "trades" jsonb NOT NULL DEFAULT '[]'
  `);

  // Link a contractor directly to a maintenance issue
  await db.execute(sql`
    ALTER TABLE "fix_track_issues"
      ADD COLUMN IF NOT EXISTS "contractor_id" integer
        REFERENCES "contractors"("id") ON DELETE SET NULL
  `);

  // Pending contractor-email approval requests (manager approval workflow)
  await db.execute(sql`
    ALTER TABLE "fix_track_issues"
      ADD COLUMN IF NOT EXISTS "email_request_mode" text,
      ADD COLUMN IF NOT EXISTS "email_requested_by" integer REFERENCES "users"("id") ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS "email_requested_at" timestamp,
      ADD COLUMN IF NOT EXISTS "email_request_status" text,
      ADD COLUMN IF NOT EXISTS "email_approved_by" integer REFERENCES "users"("id") ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS "email_approved_at" timestamp,
       ADD COLUMN IF NOT EXISTS "email_sent_by" integer REFERENCES "users"("id") ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS "email_sent_at" timestamp
  `);
  // Existing requests were created before an explicit approval state existed.
  // Treat them as pending, never as implicitly approved.
  await db.execute(sql`
    UPDATE "fix_track_issues"
    SET email_request_status = 'pending'
    WHERE email_request_mode IS NOT NULL AND email_request_status IS NULL
  `);
  // A durable dispatch record is created before provider submission. Its
  // stable key makes recovery from a post-acceptance DB failure idempotent.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "fix_track_email_dispatches" (
      "id"              serial PRIMARY KEY,
      "client_id"       integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "issue_id"        integer NOT NULL REFERENCES "fix_track_issues"("id") ON DELETE CASCADE,
      "mode"            text NOT NULL CHECK ("mode" IN ('assign', 'quote')),
      "idempotency_key" text NOT NULL UNIQUE,
      "status"          text NOT NULL DEFAULT 'sending' CHECK ("status" IN ('sending', 'failed', 'accepted')),
      "provider_id"     text,
      "accepted_at"     timestamp,
      "last_error"      text,
      "created_at"      timestamp NOT NULL DEFAULT now(),
      "updated_at"      timestamp NOT NULL DEFAULT now(),
      UNIQUE ("client_id", "issue_id", "mode")
    )
  `);

  // One-time action tokens for contractor email buttons (Booked / Completed)
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "fix_track_action_tokens" (
      "id"                     serial PRIMARY KEY,
      "token"                  text UNIQUE,
      "token_hash"             text,
      "issue_id"               integer NOT NULL REFERENCES "fix_track_issues"("id") ON DELETE CASCADE,
      "client_id"              integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "contractor_id"          integer REFERENCES "contractors"("id") ON DELETE SET NULL,
      "action"                 text NOT NULL,
      "expires_at"             timestamp NOT NULL,
      "used_at"                timestamp,
      "completion_notes"       text,
      "completion_object_path" text,
      "created_at"             timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`ALTER TABLE "fix_track_action_tokens" ADD COLUMN IF NOT EXISTS "token_hash" text`);
  await db.execute(sql`ALTER TABLE "fix_track_action_tokens" ALTER COLUMN "token" DROP NOT NULL`);
  const actionLegacy = await db.execute(sql`SELECT id, token FROM fix_track_action_tokens WHERE token IS NOT NULL`);
  for (const row of (actionLegacy.rows as any[])) {
    await db.execute(sql`UPDATE fix_track_action_tokens SET token_hash=${digestBearerToken(row.token)}, token=NULL WHERE id=${row.id}`);
  }
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS "IDX_fix_track_action_tokens_token_hash"
    ON "fix_track_action_tokens" ("token_hash")
  `);

  // Completion document path stored on the issue so managers can download it
  await db.execute(sql`
    ALTER TABLE "fix_track_issues"
      ADD COLUMN IF NOT EXISTS "completion_document_path" text
  `);

  // Persist the exact daily digest before dispatch so retries can reuse the
  // provider idempotency key and recover after process termination.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "fix_track_alert_log" (
      "id"        serial PRIMARY KEY,
      "client_id" integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "log_date"  date NOT NULL DEFAULT CURRENT_DATE,
      "status"    text NOT NULL DEFAULT 'sent',
      "idempotency_key" text,
      "issue_snapshot" jsonb NOT NULL DEFAULT '[]'::jsonb,
      "recipient_emails" jsonb NOT NULL DEFAULT '[]'::jsonb,
      "recipient_user_ids" jsonb NOT NULL DEFAULT '[]'::jsonb,
      "sent_at"   timestamp,
      "updated_at" timestamp NOT NULL DEFAULT now(),
      UNIQUE ("client_id", "log_date")
    )
  `);
  await db.execute(sql`ALTER TABLE "fix_track_alert_log" ADD COLUMN IF NOT EXISTS "status" text NOT NULL DEFAULT 'sent'`);
  await db.execute(sql`ALTER TABLE "fix_track_alert_log" ADD COLUMN IF NOT EXISTS "idempotency_key" text`);
  await db.execute(sql`ALTER TABLE "fix_track_alert_log" ADD COLUMN IF NOT EXISTS "issue_snapshot" jsonb NOT NULL DEFAULT '[]'::jsonb`);
  await db.execute(sql`ALTER TABLE "fix_track_alert_log" ADD COLUMN IF NOT EXISTS "recipient_emails" jsonb NOT NULL DEFAULT '[]'::jsonb`);
  await db.execute(sql`ALTER TABLE "fix_track_alert_log" ADD COLUMN IF NOT EXISTS "recipient_user_ids" jsonb NOT NULL DEFAULT '[]'::jsonb`);
  await db.execute(sql`ALTER TABLE "fix_track_alert_log" ADD COLUMN IF NOT EXISTS "updated_at" timestamp NOT NULL DEFAULT now()`);
  await db.execute(sql`
    ALTER TABLE "fix_track_alert_log"
      ALTER COLUMN "sent_at" DROP NOT NULL
  `);
  await db.execute(sql`
    UPDATE "fix_track_alert_log"
    SET "status" = CASE WHEN "sent_at" IS NULL THEN 'pending' ELSE 'sent' END
    WHERE "status" IS NULL
  `);
  await db.execute(sql`
    ALTER TABLE "fix_track_alert_log"
      ALTER COLUMN "status" SET DEFAULT 'sent',
      ALTER COLUMN "status" SET NOT NULL
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "IDX_fix_track_alert_log_client" ON "fix_track_alert_log" ("client_id")
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS "UQ_fix_track_alert_log_idempotency"
    ON "fix_track_alert_log" ("idempotency_key")
    WHERE "idempotency_key" IS NOT NULL
  `);

  // Per-issue dates suppress alerts on consecutive mornings without hiding an
  // unresolved issue forever.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "fix_track_escalation_log" (
      "id"        serial PRIMARY KEY,
      "client_id" integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "issue_id"  integer NOT NULL REFERENCES "fix_track_issues"("id") ON DELETE CASCADE,
      "log_date"  date NOT NULL DEFAULT CURRENT_DATE,
      "sent_at"   timestamp NOT NULL DEFAULT now(),
      UNIQUE ("issue_id", "log_date")
    )
  `);
  await db.execute(sql`
    ALTER TABLE "fix_track_escalation_log"
      ADD COLUMN IF NOT EXISTS "log_date" date NOT NULL DEFAULT CURRENT_DATE
  `);
  await db.execute(sql`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'fix_track_escalation_log'
          AND column_name = 'milestone'
      ) THEN
        ALTER TABLE "fix_track_escalation_log" ALTER COLUMN "milestone" DROP NOT NULL;
      END IF;
    END $$;
  `);
  await db.execute(sql`
    DELETE FROM "fix_track_escalation_log" newer
    USING "fix_track_escalation_log" older
    WHERE newer.issue_id = older.issue_id
      AND newer.log_date = older.log_date
      AND newer.id > older.id
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS "UQ_fix_track_escalation_issue_date"
    ON "fix_track_escalation_log" ("issue_id", "log_date")
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "IDX_fix_track_escalation_log_client"
    ON "fix_track_escalation_log" ("client_id")
  `);
}

// ---- Site documents ----
async function migrateSiteDocuments() {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "site_documents" (
      "id"          serial PRIMARY KEY,
      "client_id"   integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "site_id"     integer NOT NULL REFERENCES "sites"("id") ON DELETE CASCADE,
      "name"        text NOT NULL,
      "object_path" text NOT NULL,
      "uploaded_by" integer REFERENCES "users"("id") ON DELETE SET NULL,
      "created_at"  timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "IDX_site_documents_site"
    ON "site_documents" ("client_id", "site_id")
  `);
}

async function migrateIncidents() {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "incidents" (
      "id"                       serial PRIMARY KEY,
      "client_id"                integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "site_id"                  integer REFERENCES "sites"("id") ON DELETE SET NULL,
      "incident_type"            text NOT NULL DEFAULT 'accident',
      "severity"                 text NOT NULL DEFAULT 'minor',
      "status"                   text NOT NULL DEFAULT 'open',
      "incident_date"            date NOT NULL,
      "incident_time"            text,
      "location"                 text NOT NULL,
      "description"              text NOT NULL,
      "involved_name"            text NOT NULL,
      "involved_job_title"       text,
      "involved_employment_type" text DEFAULT 'employee',
      "injuries_sustained"       text,
      "first_aid_given"          boolean NOT NULL DEFAULT false,
      "first_aider_name"         text,
      "witnesses"                text,
      "riddor_reportable"        boolean NOT NULL DEFAULT false,
      "reported_to_hse"          boolean NOT NULL DEFAULT false,
      "hse_reference"            text,
      "hse_report_date"          date,
      "immediate_actions"        text,
      "corrective_actions"       text,
      "reported_by"              text NOT NULL,
      "created_by"               integer REFERENCES "users"("id") ON DELETE SET NULL,
      "created_at"               timestamp NOT NULL DEFAULT now(),
      "updated_at"               timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "IDX_incidents_client" ON "incidents" ("client_id")`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "IDX_incidents_date" ON "incidents" ("client_id", "incident_date" DESC)`);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "incident_riddor_events" (
      "id" serial PRIMARY KEY,
      "client_id" integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "incident_id" integer NOT NULL REFERENCES "incidents"("id") ON DELETE CASCADE,
      "actor_id" integer REFERENCES "users"("id") ON DELETE SET NULL,
      "event_type" text NOT NULL,
      "riddor_reportable" boolean NOT NULL,
      "reported_to_hse" boolean NOT NULL DEFAULT false,
      "decision_maker" text,
      "decision_at" timestamp NOT NULL DEFAULT now(),
      "rationale" text,
      "hse_reference" text,
      "hse_report_date" date,
      "submitted_at" timestamp,
      "submission_evidence" text,
      "created_at" timestamp NOT NULL DEFAULT now()
    )
  `);
  // Additive backfill for installations which already had the first version of
  // IncidentTrack. Keep existing events intact and make their recorded time the
  // decision time where no more precise value was available.
  await db.execute(sql`ALTER TABLE "incident_riddor_events" ADD COLUMN IF NOT EXISTS "decision_maker" text`);
  await db.execute(sql`ALTER TABLE "incident_riddor_events" ADD COLUMN IF NOT EXISTS "decision_at" timestamp`);
  await db.execute(sql`ALTER TABLE "incident_riddor_events" ADD COLUMN IF NOT EXISTS "submitted_at" timestamp`);
  await db.execute(sql`ALTER TABLE "incident_riddor_events" ADD COLUMN IF NOT EXISTS "submission_evidence" text`);
  await db.execute(sql`
    UPDATE "incident_riddor_events" e
    SET "decision_at" = e."created_at"
    WHERE e."decision_at" IS NULL
  `);
  await db.execute(sql`
    UPDATE "incident_riddor_events" e
    SET "decision_maker" = u."name"
    FROM "users" u
    WHERE e."actor_id" = u."id" AND e."decision_maker" IS NULL
  `);
  await db.execute(sql`
    UPDATE "incident_riddor_events"
    SET "submitted_at" = "hse_report_date"::timestamp
    WHERE "submitted_at" IS NULL AND "reported_to_hse" = true AND "hse_report_date" IS NOT NULL
  `);
  // A historical event must belong to the same tenant as its parent incident.
  // Correct any pre-audit rows before enforcing this on every future write.
  await db.execute(sql`
    UPDATE "incident_riddor_events" e
    SET "client_id" = i."client_id"
    FROM "incidents" i
    WHERE e."incident_id" = i."id" AND e."client_id" <> i."client_id"
  `);
  await db.execute(sql`ALTER TABLE "incident_riddor_events" ALTER COLUMN "decision_at" SET NOT NULL`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "IDX_incident_riddor_events_incident" ON "incident_riddor_events" ("client_id", "incident_id", "created_at" DESC)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "IDX_incident_riddor_events_tenant_incident" ON "incident_riddor_events" ("client_id", "incident_id", "decision_at" DESC)`);
  // Older installs created this FK with CASCADE. Replace it so a current
  // incident cannot take its immutable legal record with it.
  await db.execute(sql`ALTER TABLE "incident_riddor_events" DROP CONSTRAINT IF EXISTS "incident_riddor_events_incident_id_incidents_id_fk"`);
  await db.execute(sql`ALTER TABLE "incident_riddor_events" DROP CONSTRAINT IF EXISTS "incident_riddor_events_incident_id_fkey"`);
  await db.execute(sql`ALTER TABLE "incident_riddor_events" ADD CONSTRAINT "incident_riddor_events_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "incidents"("id") ON DELETE RESTRICT`);
  // This is an evidence trail, not a mutable working note. Corrections are
  // represented by a later event, preserving the original decision and
  // submission record. The tenant check also protects direct SQL callers.
  await db.execute(sql`
    CREATE OR REPLACE FUNCTION "enforce_incident_riddor_event_tenant"()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM "incidents"
        WHERE "id" = NEW."incident_id" AND "client_id" = NEW."client_id"
      ) THEN
        RAISE EXCEPTION 'RIDDOR event tenant must match its incident';
      END IF;
      RETURN NEW;
    END;
    $$
  `);
  await db.execute(sql`
    CREATE OR REPLACE FUNCTION "prevent_incident_riddor_event_mutation"()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'RIDDOR decision and submission history is append-only';
    END;
    $$
  `);
  await db.execute(sql`DROP TRIGGER IF EXISTS "incident_riddor_events_tenant_guard" ON "incident_riddor_events"`);
  await db.execute(sql`
    CREATE TRIGGER "incident_riddor_events_tenant_guard"
    BEFORE INSERT ON "incident_riddor_events"
    FOR EACH ROW EXECUTE FUNCTION "enforce_incident_riddor_event_tenant"()
  `);
  await db.execute(sql`DROP TRIGGER IF EXISTS "incident_riddor_events_immutable" ON "incident_riddor_events"`);
  await db.execute(sql`
    CREATE TRIGGER "incident_riddor_events_immutable"
    BEFORE UPDATE OR DELETE ON "incident_riddor_events"
    FOR EACH ROW EXECUTE FUNCTION "prevent_incident_riddor_event_mutation"()
  `);
}

async function migrateComplianceAuditTrail() {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "audit_events" (
      "id" serial PRIMARY KEY,
      "client_id" integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "actor_id" integer REFERENCES "users"("id") ON DELETE SET NULL,
      "entity_type" text NOT NULL,
      "entity_id" integer NOT NULL,
      "action" text NOT NULL,
      "before" jsonb,
      "after" jsonb,
      "metadata" jsonb,
      "created_at" timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "IDX_audit_events_client_entity" ON "audit_events" ("client_id", "entity_type", "entity_id", "created_at" DESC)`);
  await db.execute(sql`ALTER TABLE "audit_events" DROP CONSTRAINT IF EXISTS "audit_events_client_id_clients_id_fk"`);
  await db.execute(sql`ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE RESTRICT`);
  // Audit evidence is deliberately insert-only. Application routes use the
  // appendAuditEvent helper, but this database guard also protects records
  // from an accidental future route or direct ORM mutation.
  await db.execute(sql`
    CREATE OR REPLACE FUNCTION "prevent_audit_event_mutation"()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'Audit events are append-only';
    END;
    $$
  `);
  await db.execute(sql`DROP TRIGGER IF EXISTS "audit_events_immutable" ON "audit_events"`);
  await db.execute(sql`
    CREATE TRIGGER "audit_events_immutable"
    BEFORE UPDATE OR DELETE ON "audit_events"
    FOR EACH ROW EXECUTE FUNCTION "prevent_audit_event_mutation"()
  `);
}

async function migrateSousVide() {
  await db.execute(sql`
    ALTER TABLE food_safety_records ADD COLUMN IF NOT EXISTS sous_vide jsonb NOT NULL DEFAULT '[]'
  `);
  await db.execute(sql`ALTER TABLE food_safety_records ADD COLUMN IF NOT EXISTS cooling jsonb NOT NULL DEFAULT '[]'`);
  await db.execute(sql`ALTER TABLE food_safety_records ADD COLUMN IF NOT EXISTS reheating jsonb NOT NULL DEFAULT '[]'
  `);
}

async function migratePATtrack() {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "pat_appliances" (
      "id"              serial PRIMARY KEY,
      "client_id"       integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "site_id"         integer REFERENCES "sites"("id") ON DELETE SET NULL,
      "name"            text NOT NULL,
      "appliance_type"  text NOT NULL DEFAULT 'Other',
      "location"        text,
      "asset_tag"       text,
      "description"     text,
      "active"          boolean NOT NULL DEFAULT true,
      "created_at"      timestamp NOT NULL DEFAULT now(),
      "updated_at"      timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "IDX_pat_appliances_client" ON "pat_appliances" ("client_id")`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "pat_tests" (
      "id"                    serial PRIMARY KEY,
      "client_id"             integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "appliance_id"          integer NOT NULL REFERENCES "pat_appliances"("id") ON DELETE CASCADE,
      "test_date"             date NOT NULL,
      "result"                text NOT NULL DEFAULT 'pass',
      "next_test_date"        date,
      "tested_by"             text,
      "visual_inspection"     text DEFAULT 'pass',
      "earth_continuity_ohms" text,
      "insulation_mohms"      text,
      "operating_current"     text,
      "notes"                 text,
      "created_by"            integer REFERENCES "users"("id") ON DELETE SET NULL,
      "created_at"            timestamp NOT NULL DEFAULT now(),
      "updated_at"            timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "IDX_pat_tests_client" ON "pat_tests" ("client_id")`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "IDX_pat_tests_appliance" ON "pat_tests" ("appliance_id")`);
  // Certificate-level PAT register. These are additive and deliberately do not
  // alter the original appliance/test tables used by the existing register.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "pat_equipment_templates" (
      "id" serial PRIMARY KEY, "client_id" integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "site_id" integer REFERENCES "sites"("id") ON DELETE CASCADE, "name" text NOT NULL,
      "description" text, "active" boolean NOT NULL DEFAULT true,
      "created_at" timestamp NOT NULL DEFAULT now(), "updated_at" timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "pat_equipment_template_items" (
      "id" serial PRIMARY KEY, "client_id" integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "template_id" integer NOT NULL REFERENCES "pat_equipment_templates"("id") ON DELETE CASCADE,
      "name" text NOT NULL, "appliance_type" text NOT NULL DEFAULT 'Other',
      "quantity" integer NOT NULL DEFAULT 1 CHECK ("quantity" > 0), "notes" text,
      "sort_order" integer NOT NULL DEFAULT 0, "created_at" timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "pat_rooms" (
      "id" serial PRIMARY KEY, "client_id" integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "site_id" integer NOT NULL REFERENCES "sites"("id") ON DELETE CASCADE, "name" text NOT NULL,
      "area_type" text NOT NULL DEFAULT 'room', "template_id" integer REFERENCES "pat_equipment_templates"("id") ON DELETE SET NULL,
      "test_interval_months" integer NOT NULL DEFAULT 12 CHECK ("test_interval_months" > 0),
      "active" boolean NOT NULL DEFAULT true, "notes" text,
      "created_at" timestamp NOT NULL DEFAULT now(), "updated_at" timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "pat_certificates" (
      "id" serial PRIMARY KEY, "client_id" integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "site_id" integer NOT NULL REFERENCES "sites"("id") ON DELETE CASCADE, "visit_date" date NOT NULL,
      "contractor_id" integer REFERENCES "contractors"("id") ON DELETE SET NULL, "contractor_name" text,
      "certificate_ref" text NOT NULL, "appliances_tested_count" integer NOT NULL DEFAULT 0 CHECK ("appliances_tested_count" >= 0),
      "pass_count" integer NOT NULL DEFAULT 0 CHECK ("pass_count" >= 0), "fail_count" integer NOT NULL DEFAULT 0 CHECK ("fail_count" >= 0),
      "next_test_due" date, "document_id" integer REFERENCES "doc_track_documents"("id") ON DELETE SET NULL,
      "document_link" text, "notes" text, "created_at" timestamp NOT NULL DEFAULT now(), "updated_at" timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "pat_certificate_rooms" (
      "id" serial PRIMARY KEY, "client_id" integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "certificate_id" integer NOT NULL REFERENCES "pat_certificates"("id") ON DELETE CASCADE,
      "room_id" integer NOT NULL REFERENCES "pat_rooms"("id") ON DELETE CASCADE,
      UNIQUE ("certificate_id", "room_id")
    )
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "pat_replacements" (
      "id" serial PRIMARY KEY, "client_id" integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "room_id" integer NOT NULL REFERENCES "pat_rooms"("id") ON DELETE CASCADE, "appliance_name" text NOT NULL,
      "replaced_on" date NOT NULL, "replacement_details" text, "notes" text,
      "created_at" timestamp NOT NULL DEFAULT now(), "updated_at" timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "pat_failures" (
      "id" serial PRIMARY KEY, "client_id" integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "certificate_id" integer NOT NULL REFERENCES "pat_certificates"("id") ON DELETE CASCADE,
      "room_id" integer REFERENCES "pat_rooms"("id") ON DELETE SET NULL, "location_text" text, "room_name_snapshot" text, "appliance_name" text NOT NULL,
      "action_taken" text, "resolution" text, "resolved_date" date,
      "created_at" timestamp NOT NULL DEFAULT now(), "updated_at" timestamp NOT NULL DEFAULT now()
    )
  `);
  // Added after the initial certificate register release. Keep both the
  // supplied location and linked-room name as immutable compliance evidence.
  await db.execute(sql`ALTER TABLE "pat_failures" ADD COLUMN IF NOT EXISTS "location_text" text`);
  await db.execute(sql`ALTER TABLE "pat_failures" ADD COLUMN IF NOT EXISTS "room_name_snapshot" text`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "IDX_pat_rooms_client_site" ON "pat_rooms" ("client_id", "site_id")`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "IDX_pat_certificates_client_site_date" ON "pat_certificates" ("client_id", "site_id", "visit_date" DESC)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "IDX_pat_certificate_rooms_room" ON "pat_certificate_rooms" ("room_id")`);
}

async function migratePestTrack() {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "pest_visits" (
      "id"                  serial PRIMARY KEY,
      "client_id"           integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "site_id"             integer REFERENCES "sites"("id") ON DELETE SET NULL,
      "visit_date"          date NOT NULL,
      "contractor_name"     text,
      "contractor_company"  text,
      "areas_inspected"     text,
      "findings"            text,
      "treatments_applied"  text,
      "recommendations"     text,
      "next_visit_date"     date,
      "signed_off_by"       text,
      "notes"               text,
      "created_by"          integer REFERENCES "users"("id") ON DELETE SET NULL,
      "created_at"          timestamp NOT NULL DEFAULT now(),
      "updated_at"          timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "IDX_pest_visits_client" ON "pest_visits" ("client_id")`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "pest_activity" (
      "id"            serial PRIMARY KEY,
      "client_id"     integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "site_id"       integer REFERENCES "sites"("id") ON DELETE SET NULL,
      "recorded_date" date NOT NULL,
      "pest_type"     text NOT NULL DEFAULT 'rodent',
      "evidence_type" text NOT NULL DEFAULT 'live_sighting',
      "location"      text,
      "severity"      text NOT NULL DEFAULT 'low',
      "action_taken"  text,
      "recorded_by"   text,
      "resolved"      boolean NOT NULL DEFAULT false,
      "resolved_at"   timestamp,
      "notes"         text,
      "created_by"    integer REFERENCES "users"("id") ON DELETE SET NULL,
      "created_at"    timestamp NOT NULL DEFAULT now(),
      "updated_at"    timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "IDX_pest_activity_client" ON "pest_activity" ("client_id")`);
}

async function migrateComplianceHub() {
  // A client-level accountability profile anchors the guidance to the correct
  // UK nation, business activity and competent people. It deliberately does
  // not assert that a generic checklist proves legal compliance.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "compliance_profiles" (
      "client_id"                integer PRIMARY KEY REFERENCES "clients"("id") ON DELETE CASCADE,
      "nation"                   text NOT NULL,
      "operation_type"           text NOT NULL,
      "responsible_person_name"  text NOT NULL,
      "responsible_person_role"  text NOT NULL,
      "responsible_person_email" text,
      "competent_appointments"   jsonb NOT NULL DEFAULT '[]',
      "review_cadence"           text NOT NULL,
      "next_review_date"         date NOT NULL,
      "haccp_system_reviewed"    boolean NOT NULL DEFAULT false,
      "water_written_scheme_reference" text,
      "updated_by"               integer REFERENCES "users"("id") ON DELETE SET NULL,
      "updated_at"               timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    ALTER TABLE "compliance_profiles"
    ADD COLUMN IF NOT EXISTS "water_written_scheme_reference" text
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "compliance_actions" (
      "id"                 serial PRIMARY KEY,
      "client_id"          integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "source_track"       text NOT NULL,
      "source_record_id"   text,
      "title"              text NOT NULL,
      "severity"           text NOT NULL DEFAULT 'medium',
      "status"             text NOT NULL DEFAULT 'open',
      "owner_name"         text NOT NULL,
      "due_date"           date,
      "interim_control"    text,
      "corrective_action"  text NOT NULL,
      "evidence_reference" text,
      "verification_notes" text,
      "verified_by"        integer REFERENCES "users"("id") ON DELETE SET NULL,
      "verified_at"        timestamp,
      "created_by"         integer REFERENCES "users"("id") ON DELETE SET NULL,
      "updated_by"         integer REFERENCES "users"("id") ON DELETE SET NULL,
      "created_at"         timestamp NOT NULL DEFAULT now(),
      "updated_at"         timestamp NOT NULL DEFAULT now(),
      CONSTRAINT "CK_compliance_action_status" CHECK ("status" IN ('open', 'in_progress', 'awaiting_verification', 'verified')),
      CONSTRAINT "CK_compliance_action_severity" CHECK ("severity" IN ('low', 'medium', 'high', 'critical'))
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "IDX_compliance_actions_client_status_due"
    ON "compliance_actions" ("client_id", "status", "due_date")
  `);
}

async function migratePremisesTrack() {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "premises_inspections" (
      "id"               serial PRIMARY KEY,
      "client_id"        integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "site_id"          integer REFERENCES "sites"("id") ON DELETE SET NULL,
      "inspection_date"  date NOT NULL,
      "next_inspection_date" date,
      "inspection_type"  text NOT NULL DEFAULT 'routine',
      "area"             text,
      "findings"         text,
      "hazard_details"   text,
      "action_required"  text,
      "action_taken"     text,
      "status"           text NOT NULL DEFAULT 'open',
      "inspected_by"     text,
      "created_by"       integer REFERENCES "users"("id") ON DELETE SET NULL,
      "created_at"       timestamp NOT NULL DEFAULT now(),
      "updated_at"       timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`ALTER TABLE "premises_inspections" ADD COLUMN IF NOT EXISTS "next_inspection_date" date`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "IDX_premises_inspections_client" ON "premises_inspections" ("client_id", "inspection_date")`);
}

async function migrateRoomTrack() {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "room_track_rooms" (
      "id" serial PRIMARY KEY,
      "client_id" integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "site_id" integer REFERENCES "sites"("id") ON DELETE SET NULL,
      "room_number" text NOT NULL,
      "name" text,
      "floor" text,
      "active" boolean NOT NULL DEFAULT true,
      "notes" text,
      "created_by" integer REFERENCES "users"("id") ON DELETE SET NULL,
      "updated_by" integer REFERENCES "users"("id") ON DELETE SET NULL,
      "created_at" timestamp NOT NULL DEFAULT now(),
      "updated_at" timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "room_track_checks" (
      "id" serial PRIMARY KEY,
      "client_id" integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "room_id" integer NOT NULL REFERENCES "room_track_rooms"("id") ON DELETE CASCADE,
      "site_id" integer REFERENCES "sites"("id") ON DELETE SET NULL,
      "check_date" date NOT NULL,
      "status" text,
      "clean" boolean NOT NULL DEFAULT false,
      "tidy" boolean NOT NULL DEFAULT false,
      "to_standard" boolean NOT NULL DEFAULT false,
      "notes" text,
      "checked_by" text,
      "created_by" integer REFERENCES "users"("id") ON DELETE SET NULL,
      "updated_by" integer REFERENCES "users"("id") ON DELETE SET NULL,
      "created_at" timestamp NOT NULL DEFAULT now(),
      "updated_at" timestamp NOT NULL DEFAULT now(),
      UNIQUE ("room_id", "check_date")
    )
  `);
  // The original RoomTrack proof-of-concept used one mutually exclusive
  // status. Keep it for audit compatibility, but make new writes criteria-
  // based and translate historical values into their matching criterion.
  await db.execute(sql`ALTER TABLE "room_track_checks" ADD COLUMN IF NOT EXISTS "clean" boolean NOT NULL DEFAULT false`);
  await db.execute(sql`ALTER TABLE "room_track_checks" ADD COLUMN IF NOT EXISTS "tidy" boolean NOT NULL DEFAULT false`);
  await db.execute(sql`ALTER TABLE "room_track_checks" ADD COLUMN IF NOT EXISTS "to_standard" boolean NOT NULL DEFAULT false`);
  await db.execute(sql`
    UPDATE "room_track_checks"
    SET clean = CASE WHEN status = 'clean' THEN true ELSE clean END,
        tidy = CASE WHEN status = 'tidy' THEN true ELSE tidy END,
        to_standard = CASE WHEN status = 'to_standard' THEN true ELSE to_standard END
    WHERE status IS NOT NULL
  `);
  await db.execute(sql`
    ALTER TABLE "room_track_checks"
    DROP CONSTRAINT IF EXISTS "room_track_checks_status_check"
  `);
  await db.execute(sql`ALTER TABLE "room_track_checks" ALTER COLUMN "status" DROP NOT NULL`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "IDX_room_track_rooms_client_site" ON "room_track_rooms" ("client_id", "site_id")`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "IDX_room_track_checks_client_date" ON "room_track_checks" ("client_id", "check_date", "site_id")`);
}

async function migrateKitchenCleaning() {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "kitchen_cleaning_tasks" (
      "id"          serial PRIMARY KEY,
      "client_id"   integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "site_id"     integer REFERENCES "sites"("id") ON DELETE SET NULL,
      "area"        text NOT NULL DEFAULT '',
      "task"        text NOT NULL DEFAULT '',
      "frequency"   text NOT NULL DEFAULT 'daily',
      "method"      text,
      "product"     text,
      "responsible" text,
      "sort_order"  integer NOT NULL DEFAULT 0,
      "active"      boolean NOT NULL DEFAULT true,
      "created_at"  timestamp NOT NULL DEFAULT now(),
      "updated_at"  timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "IDX_kitchen_cleaning_tasks_client" ON "kitchen_cleaning_tasks" ("client_id")`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "kitchen_cleaning_logs" (
      "id"           serial PRIMARY KEY,
      "client_id"    integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "site_id"      integer REFERENCES "sites"("id") ON DELETE SET NULL,
      "log_date"     date NOT NULL,
      "frequency"    text NOT NULL DEFAULT 'daily',
      "completions"  jsonb NOT NULL DEFAULT '[]',
      "signed_by"    text,
      "submitted_at" timestamp,
      "created_by"   integer REFERENCES "users"("id") ON DELETE SET NULL,
      "created_at"   timestamp NOT NULL DEFAULT now(),
      "updated_at"   timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "IDX_kitchen_cleaning_logs_client" ON "kitchen_cleaning_logs" ("client_id")`);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS "IDX_kitchen_cleaning_logs_unique"
    ON "kitchen_cleaning_logs" ("client_id", "log_date", "frequency")
  `);
}

async function migrateMaintenanceManager() {
  await db.execute(sql`
    ALTER TABLE "users"
      ADD COLUMN IF NOT EXISTS "is_maintenance_manager" boolean NOT NULL DEFAULT false
  `);
}

async function migrateMobileSessions() {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "mobile_sessions" (
      "id"         serial PRIMARY KEY,
      "user_id"    integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
      "token"      text    NOT NULL,
      "expires_at" timestamp NOT NULL,
      "created_at" timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS "IDX_mobile_sessions_token"
    ON "mobile_sessions" ("token")
  `);
}

// Adds optional per-site scoping to the kitchen diary and reworks the
// uniqueness so that the same (client, date) can exist once per site plus once
// for the whole organisation (site_id IS NULL). Because Postgres treats NULLs
// as distinct, a single unique index over (client_id, record_date, site_id)
// would NOT prevent two whole-org rows for the same day; so we use two partial
// unique indexes instead.
async function migrateFoodSafetySiteScoping() {
  // 1. Nullable site_id column (whole-org diary keeps site_id NULL).
  await db.execute(sql`
    ALTER TABLE "food_safety_records"
      ADD COLUMN IF NOT EXISTS "site_id" integer REFERENCES "sites"("id") ON DELETE SET NULL
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "IDX_food_safety_client_site_date"
    ON "food_safety_records" ("client_id", "site_id", "record_date")
  `);

  // 2. Retire the old (client_id, record_date) uniqueness. The live DB may hold
  //    it as either a unique CONSTRAINT or a bare unique INDEX (migration text
  //    has historically drifted), and the name may vary — resolve the real
  //    names from the catalog before dropping.
  const constraintRows = await db.execute(sql`
    SELECT c.conname
    FROM pg_constraint c
    WHERE c.conrelid = 'food_safety_records'::regclass
      AND c.contype = 'u'
      AND c.conkey = (
        SELECT array_agg(a.attnum ORDER BY a.attnum)
        FROM pg_attribute a
        WHERE a.attrelid = 'food_safety_records'::regclass
          AND a.attname IN ('client_id', 'record_date')
      )
  `);
  for (const row of (constraintRows.rows ?? []) as Array<{ conname: string }>) {
    await db.execute(sql`ALTER TABLE "food_safety_records" DROP CONSTRAINT IF EXISTS ${sql.raw(`"${row.conname}"`)}`);
  }
  // Any remaining plain unique index over exactly (client_id, record_date)
  // that is NOT partial (no WHERE clause) is the legacy whole-table unique.
  // Match at the catalog level: exactly two key columns, no expression keys,
  // and the key attnums are precisely {client_id, record_date} — so wider
  // indexes like (client_id, record_date, created_by) are never touched.
  const indexRows = await db.execute(sql`
    SELECT i.relname AS indexname
    FROM pg_index x
    JOIN pg_class i ON i.oid = x.indexrelid
    WHERE x.indrelid = 'food_safety_records'::regclass
      AND x.indisunique
      AND x.indpred IS NULL
      AND x.indexprs IS NULL
      AND x.indnkeyatts = 2
      AND 0 <> ALL (x.indkey::int2[])
      AND (
        SELECT array_agg(k ORDER BY k)
        FROM unnest(x.indkey::int2[]) AS k
      ) = (
        SELECT array_agg(a.attnum ORDER BY a.attnum)
        FROM pg_attribute a
        WHERE a.attrelid = 'food_safety_records'::regclass
          AND a.attname IN ('client_id', 'record_date')
      )
  `);
  for (const row of (indexRows.rows ?? []) as Array<{ indexname: string }>) {
    await db.execute(sql`DROP INDEX IF EXISTS ${sql.raw(`"${row.indexname}"`)}`);
  }
  // Belt-and-braces: drop the known historical name too.
  await db.execute(sql`DROP INDEX IF EXISTS "UQ_food_safety_client_date"`);

  // 3. Two partial unique indexes replacing the old single one.
  //    - whole-org diary: one row per (client, date) when site_id IS NULL
  //    - per-site diary:  one row per (client, site, date) when site_id NOT NULL
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS "UQ_food_safety_client_date_nosite"
    ON "food_safety_records" ("client_id", "record_date")
    WHERE "site_id" IS NULL
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS "UQ_food_safety_client_site_date"
    ON "food_safety_records" ("client_id", "site_id", "record_date")
    WHERE "site_id" IS NOT NULL
  `);
}

async function migrateOffboardingColumns() {
  await db.execute(sql`
    ALTER TABLE "clients"
      ADD COLUMN IF NOT EXISTS "cancelled_at"               timestamptz,
      ADD COLUMN IF NOT EXISTS "cancellation_warning_sent_at" timestamptz,
      ADD COLUMN IF NOT EXISTS "offboarding_email_sent_at"  timestamptz,
      ADD COLUMN IF NOT EXISTS "data_deletion_scheduled_at" timestamptz,
      ADD COLUMN IF NOT EXISTS "data_deleted_at"            timestamptz
  `);
  // Per-recipient delivery state permits failed addresses to retry without
  // re-emailing successful recipients, unlike a single client-level marker.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "cancellation_warning_deliveries" (
      id serial PRIMARY KEY,
      client_id integer NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      cutoff_key text NOT NULL,
      claimed_at timestamptz NOT NULL DEFAULT now(),
      state text NOT NULL DEFAULT 'pending',
      lease_token text,
      lease_expires_at timestamptz,
      handoff_at timestamptz,
      sent_at timestamptz,
      UNIQUE (client_id, user_id, cutoff_key)
    )
  `);
  await db.execute(sql`ALTER TABLE "cancellation_warning_deliveries" ADD COLUMN IF NOT EXISTS "state" text NOT NULL DEFAULT 'pending'`);
  await db.execute(sql`ALTER TABLE "cancellation_warning_deliveries" ADD COLUMN IF NOT EXISTS "lease_token" text`);
  await db.execute(sql`ALTER TABLE "cancellation_warning_deliveries" ADD COLUMN IF NOT EXISTS "lease_expires_at" timestamptz`);
  await db.execute(sql`ALTER TABLE "cancellation_warning_deliveries" ADD COLUMN IF NOT EXISTS "handoff_at" timestamptz`);
  await db.execute(sql`
    UPDATE "cancellation_warning_deliveries"
       SET state = CASE WHEN sent_at IS NULL THEN 'pending' ELSE 'sent' END
     WHERE state IS NULL OR state NOT IN ('pending', 'sending', 'handed_off', 'sent')
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "IDX_cancellation_warning_deliveries_retry"
    ON "cancellation_warning_deliveries" ("client_id", "sent_at", "claimed_at")
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS "UQ_cancellation_warning_delivery_lease"
    ON "cancellation_warning_deliveries" ("lease_token")
    WHERE "lease_token" IS NOT NULL
  `);
}

// ---- LegionellaTrack sentinel outlets table ----
// Moves sentinel outlet definitions from app_settings JSON into a proper table
// so each outlet can be tracked individually per calendar month.
async function migrateLegionellaOutlets() {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS legionella_sentinel_outlets (
      id         serial PRIMARY KEY,
      client_id  integer NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      site_id    integer REFERENCES sites(id) ON DELETE SET NULL,
      name       text NOT NULL,
      type       text NOT NULL DEFAULT 'hot',
      location   text,
      sort_order integer NOT NULL DEFAULT 0,
      active     boolean NOT NULL DEFAULT true,
      created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "IDX_leg_sentinel_outlets_client"
    ON legionella_sentinel_outlets (client_id)
  `);
  // Add outlet FK to checks so tests can be linked back to a specific outlet.
  await db.execute(sql`
    ALTER TABLE legionella_checks
    ADD COLUMN IF NOT EXISTS outlet_id integer
    REFERENCES legionella_sentinel_outlets(id) ON DELETE SET NULL
  `);
  // Migrate existing JSON from app_settings (idempotent — skips clients already migrated).
  const settings = await db.execute(sql`
    SELECT client_id, value FROM app_settings
    WHERE key = 'water_sentinel_outlets'
      AND value IS NOT NULL
      AND value NOT IN ('', '[]')
  `);
  for (const row of (settings.rows ?? []) as any[]) {
    const already = await db.execute(sql`
      SELECT id FROM legionella_sentinel_outlets WHERE client_id = ${row.client_id} LIMIT 1
    `);
    if ((already.rows ?? []).length > 0) continue;
    try {
      const outlets = JSON.parse(row.value) as { name: string; type: string; location?: string }[];
      for (let i = 0; i < outlets.length; i++) {
        const o = outlets[i];
        if (!o.name) continue;
        await db.execute(sql`
          INSERT INTO legionella_sentinel_outlets (client_id, name, type, location, sort_order)
          VALUES (${row.client_id}, ${o.name}, ${o.type || "hot"}, ${o.location ?? null}, ${i})
        `);
      }
    } catch { /* invalid JSON, skip */ }
  }
}

// ---- SafeTrack → DocTrack data migration ----
// Copies existing safe_risk_assessments, safe_sops, and safe_handbook rows into
// doc_track_documents (which already has the matching categories).  Uses a
// migrated_doc_id tracking column on each source table so the migration is
// fully idempotent and can be re-run safely.
async function migrateDoctrackSafetrackMerge() {
  // 1. Add tracking columns to source tables.
  await db.execute(sql`ALTER TABLE safe_risk_assessments ADD COLUMN IF NOT EXISTS migrated_doc_id integer`);
  await db.execute(sql`ALTER TABLE safe_sops            ADD COLUMN IF NOT EXISTS migrated_doc_id integer`);
  await db.execute(sql`ALTER TABLE safe_handbook        ADD COLUMN IF NOT EXISTS migrated_doc_id integer`);

  // 2. Migrate risk assessments.
  {
    const rows = await db.execute(sql`SELECT * FROM safe_risk_assessments WHERE migrated_doc_id IS NULL`);
    for (const ra of (rows.rows ?? []) as any[]) {
      const desc = [
        ra.hazard           ? `Hazard: ${ra.hazard}` : null,
        ra.likelihood       ? `Likelihood: ${ra.likelihood}` : null,
        ra.severity         ? `Severity: ${ra.severity}` : null,
        ra.control_measures ? `Control measures: ${ra.control_measures}` : null,
        ra.notes            || null,
      ].filter(Boolean).join("\n") || null;

      const ins = await db.execute(sql`
        INSERT INTO doc_track_documents
          (client_id, site_id, title, category, description,
           object_path, file_name, file_size, mime_type,
           requires_acknowledgement, reviewed_by, review_date,
           next_review_date, status, created_at, updated_at)
        VALUES
          (${ra.client_id}, ${ra.site_id}, ${ra.title ?? "Untitled"}, 'risk_assessment', ${desc},
           ${ra.object_path ?? null}, ${ra.file_name ?? null}, ${ra.file_size ?? null}, ${ra.mime_type ?? null},
           ${ra.requires_acknowledgement ?? false}, ${ra.reviewed_by ?? null}, ${ra.review_date ?? null},
           ${ra.next_review_date ?? null}, ${ra.status ?? "active"}, ${ra.created_at ?? sql`now()`}, ${ra.updated_at ?? sql`now()`})
        RETURNING id
      `);
      const newId = ((ins.rows ?? [])[0] as any)?.id;
      if (newId) {
        await db.execute(sql`UPDATE safe_risk_assessments SET migrated_doc_id = ${newId} WHERE id = ${ra.id}`);
      }
    }
  }

  // 3. Migrate SOPs.
  {
    const rows = await db.execute(sql`SELECT * FROM safe_sops WHERE migrated_doc_id IS NULL`);
    for (const sop of (rows.rows ?? []) as any[]) {
      const desc = [sop.content || null, sop.notes || null].filter(Boolean).join("\n") || null;
      const ins = await db.execute(sql`
        INSERT INTO doc_track_documents
          (client_id, site_id, title, category, description,
           object_path, file_name, file_size, mime_type,
           requires_acknowledgement, reviewed_by, review_date,
           next_review_date, status, created_at, updated_at)
        VALUES
          (${sop.client_id}, ${sop.site_id ?? null}, ${sop.title ?? "Untitled"}, 'sop', ${desc},
           ${sop.object_path ?? null}, ${sop.file_name ?? null}, ${sop.file_size ?? null}, ${sop.mime_type ?? null},
           ${sop.requires_acknowledgement ?? false}, ${sop.reviewed_by ?? null}, ${sop.review_date ?? null},
           ${sop.next_review_date ?? null}, ${sop.status ?? "active"}, ${sop.created_at ?? sql`now()`}, ${sop.updated_at ?? sql`now()`})
        RETURNING id
      `);
      const newId = ((ins.rows ?? [])[0] as any)?.id;
      if (newId) {
        await db.execute(sql`UPDATE safe_sops SET migrated_doc_id = ${newId} WHERE id = ${sop.id}`);
      }
    }
  }

  // 4. Migrate handbook entries.
  {
    const rows = await db.execute(sql`SELECT * FROM safe_handbook WHERE migrated_doc_id IS NULL`);
    for (const hb of (rows.rows ?? []) as any[]) {
      const desc = [hb.content || null, hb.notes || null].filter(Boolean).join("\n") || null;
      const ins = await db.execute(sql`
        INSERT INTO doc_track_documents
          (client_id, site_id, title, category, description,
           object_path, file_name, file_size, mime_type,
           requires_acknowledgement, reviewed_by, review_date,
           next_review_date, status, created_at, updated_at)
        VALUES
          (${hb.client_id}, ${hb.site_id ?? null}, ${hb.title ?? "Untitled"}, 'handbook', ${desc},
           ${hb.object_path ?? null}, ${hb.file_name ?? null}, ${hb.file_size ?? null}, ${hb.mime_type ?? null},
           ${hb.requires_acknowledgement ?? false}, ${hb.reviewed_by ?? null}, ${hb.review_date ?? null},
           ${hb.next_review_date ?? null}, ${hb.status ?? "active"}, ${hb.created_at ?? sql`now()`}, ${hb.updated_at ?? sql`now()`})
        RETURNING id
      `);
      const newId = ((ins.rows ?? [])[0] as any)?.id;
      if (newId) {
        await db.execute(sql`UPDATE safe_handbook SET migrated_doc_id = ${newId} WHERE id = ${hb.id}`);
      }
    }
  }

  // ── Email verification columns on users ──────────────────────────────────────
  // DEFAULT TRUE so every existing account stays accessible after the migration.
  // Only new self-registrations set email_verified = false until confirmed.
  await db.execute(sql`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT TRUE
  `);
  await db.execute(sql`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS email_verification_token TEXT
  `);
  await db.execute(sql`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS email_verification_expires_at TIMESTAMPTZ
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS feedback_reports (
      id serial PRIMARY KEY,
      client_id integer NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      user_id integer REFERENCES users(id) ON DELETE SET NULL,
      category text NOT NULL CHECK (category IN ('feedback', 'bug', 'feature')),
      summary text NOT NULL,
      details text NOT NULL,
      page_path text,
      email_status text NOT NULL DEFAULT 'pending',
      created_at timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "IDX_feedback_reports_client_created"
    ON feedback_reports (client_id, created_at DESC)
  `);

  // 5. Migrate acknowledgements — only for rows whose source doc was already migrated.
  {
    const acks = await db.execute(sql`
      SELECT a.*,
        COALESCE(r.migrated_doc_id, s.migrated_doc_id, h.migrated_doc_id) AS new_doc_id
      FROM safe_track_acknowledgements a
      LEFT JOIN safe_risk_assessments r ON a.document_type = 'risk_assessment' AND a.document_id = r.id
      LEFT JOIN safe_sops             s ON a.document_type = 'sop'             AND a.document_id = s.id
      LEFT JOIN safe_handbook         h ON a.document_type = 'handbook'        AND a.document_id = h.id
      WHERE COALESCE(r.migrated_doc_id, s.migrated_doc_id, h.migrated_doc_id) IS NOT NULL
    `);
    for (const ack of (acks.rows ?? []) as any[]) {
      if (!ack.new_doc_id) continue;
      await db.execute(sql`
        INSERT INTO doc_acknowledgements
          (document_id, client_id, staff_roster_id, staff_name, signature, acknowledged_at, acknowledged_by)
        VALUES
          (${ack.new_doc_id}, ${ack.client_id}, ${ack.staff_roster_id ?? null},
           ${ack.staff_name}, ${ack.signature ?? null}, ${ack.acknowledged_at}, ${ack.acknowledged_by ?? null})
        ON CONFLICT DO NOTHING
      `);
    }
  }
}
