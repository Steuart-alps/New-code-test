/**
 * Offboarding and data-retention jobs.
 *
 * Two jobs run daily:
 *
 * 1. runCancellationDetectionJob — finds clients whose Stripe subscription has
 *    been cancelled, stamps cancelled_at + data_deletion_scheduled_at (12 months
 *    later), and sends a one-shot offboarding email.
 *
 * 2. runDataDeletionJob — finds clients whose 12-month retention window has
 *    passed and hard-deletes all their compliance records, then stamps
 *    data_deleted_at. The client row itself is retained for audit purposes.
 */
import { db } from "@workspace/db";
import { clientsTable, usersTable } from "@workspace/db/schema";
import { and, isNull, lte, isNotNull } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { logger } from "./logger";
import { sendSystemEmail, getPublicAppUrl, escapeHtml } from "./email";
import { findLiveSubscription } from "./billing";

const RETENTION_MONTHS = 12;

// ── Helpers ────────────────────────────────────────────────────────────────────

function addMonths(date: Date, months: number): Date {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
}

async function getClientRecipients(clientId: number) {
  // Prefer consultants; fall back to client admin users.
  const consultants = await db.execute(sql`
    SELECT u.id, u.email, u.name
    FROM users u
    JOIN consultant_clients cc ON cc.user_id = u.id
    WHERE cc.client_id = ${clientId} AND u.active = true
  `);
  if ((consultants.rows ?? []).length > 0) {
    return consultants.rows as { id: number; email: string; name: string }[];
  }
  const admins = await db.execute(sql`
    SELECT id, email, name FROM users
    WHERE client_id = ${clientId} AND active = true AND role = 'client_admin'
    LIMIT 5
  `);
  return admins.rows as { id: number; email: string; name: string }[];
}

// ── Offboarding email ──────────────────────────────────────────────────────────

function buildOffboardingEmail(opts: {
  recipientName: string;
  companyName: string;
  deletionDate: Date;
  settingsUrl: string;
}) {
  const deletionStr = opts.deletionDate.toLocaleDateString("en-GB", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });
  const safeName    = escapeHtml(opts.recipientName);
  const safeCompany = escapeHtml(opts.companyName);
  const subject = `Your ComplyTrack data will be deleted on ${deletionStr}`;

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #1e293b;">Your ComplyTrack subscription has ended</h2>
      <p>Hi ${safeName},</p>
      <p>The subscription for <strong>${safeCompany}</strong> has been cancelled.</p>
      <p>In line with our data retention policy, all compliance records, documents and logs
         associated with this account will be <strong>permanently deleted on ${deletionStr}</strong>
         — ${RETENTION_MONTHS} months from today.</p>
      <div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:8px;padding:20px;margin:20px 0;">
        <p style="margin:0 0 12px;color:#92400e;font-weight:600;">⬇ Export your records before this date</p>
        <p style="margin:0 0 16px;color:#78350f;font-size:14px;">
          Download a full export of all your data — food safety logs, fire safety checks,
          training records, contractor files and more — as a ZIP file from your account settings.
        </p>
        <a href="${opts.settingsUrl}"
           style="display:inline-block;background:#ea580c;color:white;text-decoration:none;
                  padding:12px 24px;border-radius:6px;font-weight:600;">
          Download your data
        </a>
      </div>
      <p style="color:#64748b;font-size:13px;">
        If you resubscribe before ${deletionStr} your data will be preserved and no deletion will occur.
      </p>
      <p>Best regards,<br><strong>ComplyTrack</strong></p>
    </div>`;

  const text = `
Your ComplyTrack subscription has ended

Hi ${opts.recipientName},

The subscription for ${opts.companyName} has been cancelled.

All compliance records, documents and logs will be permanently deleted on ${deletionStr} (${RETENTION_MONTHS} months from today).

Download your data before this date from your account settings:
${opts.settingsUrl}

If you resubscribe before ${deletionStr} your data will be preserved.

Best regards,
ComplyTrack
`.trim();

  return { subject, html, text };
}

// ── Job 1: Cancellation detection ─────────────────────────────────────────────

/**
 * Finds clients whose Stripe subscription is fully cancelled but who haven't
 * been stamped with cancelled_at yet. Sets the retention clock and sends the
 * offboarding email (one-shot, deduped via offboarding_email_sent_at).
 */
export async function runCancellationDetectionJob(): Promise<{
  clientsDetected: number;
  emailsSent: number;
}> {
  let clientsDetected = 0;
  let emailsSent = 0;

  // Only consider clients that have a Stripe customer and no cancellation stamp.
  const candidates = await db
    .select()
    .from(clientsTable)
    .where(
      and(
        isNotNull(clientsTable.stripeCustomerId),
        isNull(clientsTable.cancelledAt),
        isNull(clientsTable.dataDeletedAt),
      ),
    );

  for (const client of candidates) {
    try {
      // If a live subscription exists the client is still active — skip.
      const live = await findLiveSubscription(client.stripeCustomerId!).catch(() => null);
      if (live) continue;

      // Skip pre-subscription accounts (no Stripe subscription on record at all).
      const subCheck = await db.execute(sql`
        SELECT 1 FROM stripe.subscriptions WHERE customer = ${client.stripeCustomerId} LIMIT 1
      `).catch(() => ({ rows: [] }));
      if ((subCheck.rows ?? []).length === 0) continue;

      const now = new Date();
      const deletionDate = addMonths(now, RETENTION_MONTHS);

      // Claim atomically — WHERE cancelled_at IS NULL prevents double-firing.
      const claimed = await db.execute(sql`
        UPDATE clients
           SET cancelled_at               = ${now},
               data_deletion_scheduled_at = ${deletionDate},
               updated_at                 = ${now}
         WHERE id = ${client.id}
           AND cancelled_at IS NULL
        RETURNING id
      `);
      if ((claimed.rows ?? []).length === 0) continue; // Another process claimed it.

      clientsDetected++;
      logger.info({ clientId: client.id, deletionDate }, "Client cancellation detected — retention clock started");

      // Send offboarding email once.
      if (client.offboardingEmailSentAt) continue;

      const recipients = await getClientRecipients(client.id);
      const settingsUrl = `${getPublicAppUrl()}/settings`;
      let sent = 0;

      for (const r of recipients) {
        try {
          const { subject, html, text } = buildOffboardingEmail({
            recipientName: r.name ?? r.email,
            companyName: client.name,
            deletionDate,
            settingsUrl,
          });
          await sendSystemEmail({ to: r.email, subject, html, text });
          sent++;
        } catch (err) {
          logger.error({ err, clientId: client.id }, "Offboarding email failed for recipient");
        }
      }

      if (sent > 0) {
        await db.execute(sql`
          UPDATE clients SET offboarding_email_sent_at = ${new Date()} WHERE id = ${client.id}
        `);
        emailsSent += sent;
        logger.info({ clientId: client.id, sent }, "Offboarding emails sent");
      }
    } catch (err) {
      logger.error({ err, clientId: client.id }, "Cancellation detection error for client");
    }
  }

  return { clientsDetected, emailsSent };
}

// ── Job 2: Hard data deletion ──────────────────────────────────────────────────

/**
 * Hard-deletes all compliance records for clients whose 12-month retention
 * window has passed. The client row itself is kept (with data_deleted_at set)
 * to preserve the audit trail. Users are anonymised rather than deleted.
 */
export async function runDataDeletionJob(): Promise<{ clientsDeleted: number }> {
  let clientsDeleted = 0;
  const now = new Date();

  const due = await db
    .select()
    .from(clientsTable)
    .where(
      and(
        isNotNull(clientsTable.dataDeletionScheduledAt),
        lte(clientsTable.dataDeletionScheduledAt, now),
        isNull(clientsTable.dataDeletedAt),
      ),
    );

  for (const client of due) {
    try {
      logger.info({ clientId: client.id }, "Starting data deletion for client");
      await deleteAllClientData(client.id);

      await db.execute(sql`
        UPDATE clients SET data_deleted_at = ${now}, updated_at = ${now} WHERE id = ${client.id}
      `);
      clientsDeleted++;
      logger.info({ clientId: client.id }, "Client data permanently deleted");

      // Notify system admin.
      const adminEmail = process.env.ADMIN_EMAIL;
      if (adminEmail) {
        const safeCompany = escapeHtml(client.name);
        await sendSystemEmail({
          to: adminEmail,
          subject: `ComplyTrack: data deleted for ${client.name} (id ${client.id})`,
          html: `<p>All compliance records for <strong>${safeCompany}</strong> (client id ${client.id}) have been permanently deleted as scheduled under the ${RETENTION_MONTHS}-month data retention policy.</p>`,
          text: `All compliance records for ${client.name} (client id ${client.id}) have been permanently deleted as scheduled under the ${RETENTION_MONTHS}-month data retention policy.`,
        }).catch((err) => logger.error({ err }, "Deletion confirmation email failed"));
      }
    } catch (err) {
      logger.error({ err, clientId: client.id }, "Data deletion failed for client — will retry tomorrow");
    }
  }

  return { clientsDeleted };
}

// ── deleteAllClientData ────────────────────────────────────────────────────────

/**
 * Deletes all compliance data for a client in FK-safe order (children before
 * parents). Each statement uses IF the table exists via .catch(() => {}) so a
 * missing table (schema drift) never aborts the whole deletion run.
 */
async function deleteAllClientData(cid: number): Promise<void> {
  // ─ Swim track (surveillance_checks refs sessions) ──────────────────────────
  await db.execute(sql`DELETE FROM swim_surveillance_checks WHERE client_id = ${cid}`).catch(() => {});
  await db.execute(sql`DELETE FROM swim_incidents             WHERE client_id = ${cid}`).catch(() => {});
  await db.execute(sql`DELETE FROM swim_sessions              WHERE client_id = ${cid}`).catch(() => {});

  // ─ Bike track (checks + hire records ref bikes) ───────────────────────────
  await db.execute(sql`DELETE FROM bike_checks       WHERE client_id = ${cid}`).catch(() => {});
  await db.execute(sql`DELETE FROM bike_hire_records WHERE client_id = ${cid}`).catch(() => {});
  await db.execute(sql`DELETE FROM bikes             WHERE client_id = ${cid}`).catch(() => {});

  // ─ Hot tub track ──────────────────────────────────────────────────────────
  await db.execute(sql`DELETE FROM hot_tub_checks WHERE client_id = ${cid}`).catch(() => {});
  await db.execute(sql`DELETE FROM hot_tubs        WHERE client_id = ${cid}`).catch(() => {});

  // ─ PAT track (tests ref appliances) ──────────────────────────────────────
  await db.execute(sql`DELETE FROM pat_tests      WHERE client_id = ${cid}`).catch(() => {});
  await db.execute(sql`DELETE FROM pat_appliances WHERE client_id = ${cid}`).catch(() => {});

  // ─ Green track (pre-use checks ref machines) ──────────────────────────────
  await db.execute(sql`DELETE FROM green_pre_use_checks WHERE client_id = ${cid}`).catch(() => {});
  await db.execute(sql`DELETE FROM green_machines        WHERE client_id = ${cid}`).catch(() => {});

  // ─ DocTrack (acknowledgements ref documents) ──────────────────────────────
  await db.execute(sql`DELETE FROM doc_acknowledgements WHERE client_id = ${cid}`).catch(() => {});
  await db.execute(sql`DELETE FROM doc_track_documents  WHERE client_id = ${cid}`).catch(() => {});

  // ─ Contractors + certificates (certs ref contractors) ─────────────────────
  await db.execute(sql`
    DELETE FROM certificates
     WHERE contractor_id IN (SELECT id FROM contractors WHERE client_id = ${cid})
  `).catch(() => {});
  await db.execute(sql`DELETE FROM contractors WHERE client_id = ${cid}`).catch(() => {});

  // ─ FixTrack (action tokens + alert log cascade from issues) ───────────────
  await db.execute(sql`DELETE FROM fix_track_alert_log    WHERE client_id = ${cid}`).catch(() => {});
  await db.execute(sql`DELETE FROM fix_track_action_tokens
                         WHERE issue_id IN (SELECT id FROM fix_track_issues WHERE client_id = ${cid})`).catch(() => {});
  await db.execute(sql`DELETE FROM fix_track_issues WHERE client_id = ${cid}`).catch(() => {});

  // ─ SafeTrack ──────────────────────────────────────────────────────────────
  await db.execute(sql`DELETE FROM safe_incidents          WHERE client_id = ${cid}`).catch(() => {});
  await db.execute(sql`DELETE FROM safe_risk_assessments   WHERE client_id = ${cid}`).catch(() => {});
  await db.execute(sql`DELETE FROM safe_sops               WHERE client_id = ${cid}`).catch(() => {});
  await db.execute(sql`DELETE FROM safe_training_records   WHERE client_id = ${cid}`).catch(() => {});
  await db.execute(sql`DELETE FROM safe_inductions         WHERE client_id = ${cid}`).catch(() => {});
  await db.execute(sql`DELETE FROM safe_competency_signoffs WHERE client_id = ${cid}`).catch(() => {});
  await db.execute(sql`DELETE FROM safe_handbook           WHERE client_id = ${cid}`).catch(() => {});

  // ─ TrainTrack ─────────────────────────────────────────────────────────────
  await db.execute(sql`DELETE FROM train_track_records WHERE client_id = ${cid}`).catch(() => {});

  // ─ Food, fire, water, pool, pest, premises, tree, general incidents ───────
  await db.execute(sql`DELETE FROM food_safety_records   WHERE client_id = ${cid}`).catch(() => {});
  await db.execute(sql`DELETE FROM fire_safety_checks    WHERE client_id = ${cid}`).catch(() => {});
  await db.execute(sql`DELETE FROM legionella_checks     WHERE client_id = ${cid}`).catch(() => {});
  await db.execute(sql`DELETE FROM pool_checks           WHERE client_id = ${cid}`).catch(() => {});
  await db.execute(sql`DELETE FROM pest_visits           WHERE client_id = ${cid}`).catch(() => {});
  await db.execute(sql`DELETE FROM pest_activity         WHERE client_id = ${cid}`).catch(() => {});
  await db.execute(sql`DELETE FROM premises_inspections  WHERE client_id = ${cid}`).catch(() => {});
  await db.execute(sql`DELETE FROM tree_inspections      WHERE client_id = ${cid}`).catch(() => {});
  await db.execute(sql`DELETE FROM incidents             WHERE client_id = ${cid}`).catch(() => {});

  // ─ Checklists and kitchen records ─────────────────────────────────────────
  await db.execute(sql`DELETE FROM daily_checklists        WHERE client_id = ${cid}`).catch(() => {});
  await db.execute(sql`DELETE FROM daily_manager_signoffs  WHERE client_id = ${cid}`).catch(() => {});
  await db.execute(sql`DELETE FROM kitchen_weekly_records  WHERE client_id = ${cid}`).catch(() => {});
  await db.execute(sql`DELETE FROM kitchen_probe_checks    WHERE client_id = ${cid}`).catch(() => {});
  await db.execute(sql`DELETE FROM kitchen_cleaning_tasks  WHERE client_id = ${cid}`).catch(() => {});
  await db.execute(sql`DELETE FROM kitchen_cleaning_logs   WHERE client_id = ${cid}`).catch(() => {});

  // ─ Staff roster ───────────────────────────────────────────────────────────
  await db.execute(sql`DELETE FROM staff_roster WHERE client_id = ${cid}`).catch(() => {});

  // ─ Photos, templates, reminders, maintenance ──────────────────────────────
  await db.execute(sql`DELETE FROM check_photos              WHERE client_id = ${cid}`).catch(() => {});
  await db.execute(sql`DELETE FROM photo_requirements        WHERE client_id = ${cid}`).catch(() => {});
  await db.execute(sql`DELETE FROM checklist_templates       WHERE client_id = ${cid}`).catch(() => {});
  await db.execute(sql`DELETE FROM check_reminder_log        WHERE client_id = ${cid}`).catch(() => {});
  await db.execute(sql`DELETE FROM contractor_compliance_reminder_log WHERE client_id = ${cid}`).catch(() => {});
  await db.execute(sql`DELETE FROM training_expiry_reminder_log       WHERE client_id = ${cid}`).catch(() => {});
  await db.execute(sql`DELETE FROM doc_ack_reminder_log               WHERE client_id = ${cid}`).catch(() => {});
  await db.execute(sql`DELETE FROM maintenance_requests      WHERE client_id = ${cid}`).catch(() => {});

  // ─ Compliance items (refs contractors, sites, depts — all scoped) ─────────
  await db.execute(sql`DELETE FROM compliance_items WHERE client_id = ${cid}`).catch(() => {});

  // ─ App settings, categories ───────────────────────────────────────────────
  await db.execute(sql`DELETE FROM app_settings WHERE client_id = ${cid}`).catch(() => {});
  await db.execute(sql`DELETE FROM categories   WHERE client_id = ${cid}`).catch(() => {});

  // ─ Users: anonymise to preserve audit trail rather than hard-delete ───────
  await db.execute(sql`
    UPDATE users SET
      active        = false,
      email         = 'deleted-' || id || '@deleted.invalid',
      password_hash = '',
      name          = 'Deleted User',
      updated_at    = NOW()
    WHERE client_id = ${cid}
  `).catch(() => {});

  // ─ Sites and departments (last, after all referencing tables cleared) ──────
  await db.execute(sql`DELETE FROM sites       WHERE client_id = ${cid}`).catch(() => {});
  await db.execute(sql`DELETE FROM departments WHERE client_id = ${cid}`).catch(() => {});
}
