/**
 * Overdue bike-hire notification job.
 *
 * Runs daily, sends the initial alert after a missed return, then repeats only
 * at the client's configured cadence while the hire remains active. Database
 * claims make delivery safe when multiple scheduler instances run at once, and
 * a durable outbox (bike_overdue_notification_log) replays an unconfirmed
 * digest with its original provider idempotency key, so a send whose outcome
 * is uncertain (e.g. the provider accepted it but the response timed out) is
 * not delivered twice.
 */

import { createHash } from "node:crypto";
import { db } from "@workspace/db";
import { sql, type SQLWrapper } from "drizzle-orm";
import { logger } from "./logger";
import { sendEmail, getPublicAppUrl } from "./email";
import { sendPushToUsers } from "./pushNotifications";
import { getNotificationEmails } from "./getNotificationEmails";

const BIKE_OVERDUE_REPEAT_SETTING = "bike_overdue_repeat_interval_days";
/** Available client-selected repeat intervals; zero means one alert only. */
export const BIKE_OVERDUE_REPEAT_INTERVALS_DAYS = [1, 3, 7, 14] as const;
const BIKE_OVERDUE_INTERVAL_OPTIONS = ["1", "3", "7", "14"] as const;

export function parseBikeOverdueRepeatInterval(value: unknown): number | null {
  if (value === "0") return 0;
  if (typeof value !== "string" || !(BIKE_OVERDUE_INTERVAL_OPTIONS as readonly string[]).includes(value)) return null;
  return Number(value);
}

function configuredRepeatDays(clientId: SQLWrapper) {
  return sql<number>`COALESCE((
    SELECT CASE setting.value
      WHEN '1' THEN 1 WHEN '3' THEN 3 WHEN '7' THEN 7 WHEN '14' THEN 14
      ELSE 0
    END
    FROM app_settings setting
    WHERE setting.client_id = ${clientId} AND setting.key = ${BIKE_OVERDUE_REPEAT_SETTING}
    LIMIT 1
  ), 0)`;
}
/** An abandoned worker's claim may be retried after this lease expires. */
const CLAIM_LEASE_MINUTES = 30;
/**
 * Resend keeps idempotency keys for 24 hours. An unconfirmed digest is only
 * replayed inside that window (with margin), so every replay is deduplicated.
 */
const PROVIDER_IDEMPOTENCY_WINDOW_HOURS = 23;

function esc(s: string | null | undefined): string {
  return (s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

interface OverdueHire {
  id: number;
  client_id: number;
  hirer_name: string;
  hirer_contact: string | null;
  expected_return: string;
  bike_ref: string;
  days_overdue: number;
}

function buildEmailHtml(hires: OverdueHire[], appUrl: string): string {
  const fmtDate = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "2-digit", month: "short", year: "numeric", timeZone: "UTC",
  });
  const rows = hires.map((h) => `
      <tr><td style="padding:10px 12px;border-bottom:1px solid #f1f5f9;">
        <div style="font-weight:600;font-size:14px;color:#0f172a;">${esc(h.bike_ref)} — ${esc(h.hirer_name)}</div>
        <div style="font-size:12px;color:#64748b;margin-top:2px;">
          Due back ${fmtDate(h.expected_return)} · ${h.days_overdue} day${h.days_overdue === 1 ? "" : "s"} overdue${h.hirer_contact ? ` · Contact: ${esc(h.hirer_contact)}` : ""}
        </div>
      </td></tr>`).join("");
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:600px;margin:40px auto;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 6px rgba(0,0,0,0.07);">
    <div style="background:#0f172a;padding:32px 40px;"><div style="font-size:22px;font-weight:700;color:#ffffff;">🛡️ ComplyTrack</div><div style="font-size:14px;color:#94a3b8;margin-top:6px;">BikeTrack — overdue hire${hires.length !== 1 ? "s" : ""}</div></div>
    <div style="padding:32px 40px;"><p style="font-size:15px;color:#334155;margin:0 0 20px;">${hires.length} hired bike${hires.length !== 1 ? "s have" : " has"} not been returned by the expected time. Please contact the hirer${hires.length !== 1 ? "s" : ""} or record the return in BikeTrack.</p><table style="width:100%;border-collapse:collapse;background:#f8fafc;border-radius:12px;overflow:hidden;"><tbody>${rows}</tbody></table><div style="margin-top:28px;text-align:center;"><a href="${appUrl}" style="display:inline-block;background:#0f172a;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:10px;font-size:14px;font-weight:600;">Open ComplyTrack →</a></div></div>
    <div style="padding:20px 40px;border-top:1px solid #f1f5f9;font-size:12px;color:#94a3b8;text-align:center;">ComplyTrack by ALPS Consulting · Automatic BikeTrack notification.</div>
  </div>
</body></html>`;
}

export interface BikeOverdueJobResult {
  hiresFound: number;
  clientsEmailed: number;
  emailsSent: number;
  errors: number;
}

type EmailSender = typeof sendEmail;
type PushSender = typeof sendPushToUsers;

interface OutboxRow {
  id: number;
  client_id: number;
  idempotency_key: string;
  claim_token: string;
  hire_ids: number[];
  recipient_emails: string[];
  recipient_user_ids: number[];
  subject: string;
  html: string;
  expired: boolean;
}

/**
 * Stable provider idempotency identity for one client's overdue-hire reminder
 * period. Each hire's period is anchored by its previous successful alert (or
 * "initial"), so a retry of the same reminder reuses the key while the next
 * cadence repeat gets a new one.
 */
export function bikeOverdueIdempotencyKey(
  clientId: number,
  periodDate: string,
  hires: { id: number; period_anchor: string }[],
): string {
  const identity = hires
    .map((h) => `${h.id}:${h.period_anchor}`)
    .sort()
    .join(",");
  const digest = createHash("sha256").update(identity).digest("hex").slice(0, 32);
  return `bike-overdue-${clientId}-${periodDate}-${digest}`;
}

const OUTBOX_COLUMNS = sql.raw(`id, client_id, idempotency_key, claim_token, hire_ids,
  recipient_emails, recipient_user_ids, subject, html,
  created_at < now() - (${PROVIDER_IDEMPOTENCY_WINDOW_HOURS} * interval '1 hour') AS expired`);

export async function runBikeOverdueJob(
  deps: { sendEmail?: EmailSender; sendPush?: PushSender } = {},
  options: {
    /** Replay persisted, unconfirmed digests only; never create a new one. */
    recoverOnly?: boolean;
  } = {},
): Promise<BikeOverdueJobResult> {
  const send = deps.sendEmail ?? sendEmail;
  const sendPush = deps.sendPush ?? sendPushToUsers;
  const result: BikeOverdueJobResult = { hiresFound: 0, clientsEmailed: 0, emailsSent: 0, errors: 0 };
  const appUrl = getPublicAppUrl();

  let hires: OverdueHire[] = [];
  if (!options.recoverOnly) {
    // Missing or invalid configuration means a single alert only. The UPDATE
    // below independently rechecks cadence and active hire status under claim.
    const candidateRepeatDays = configuredRepeatDays(sql.raw("h.client_id"));
    const overdueResult = await db.execute(sql`
      SELECT h.id, h.client_id, h.guest_name AS hirer_name, h.guest_contact AS hirer_contact,
             h.return_date_expected AS expected_return, b.ref AS bike_ref,
             (CURRENT_DATE - h.return_date_expected)::integer AS days_overdue
      FROM bike_hire_records h
      LEFT JOIN bikes b ON h.bike_id = b.id
      WHERE h.status = 'active' AND h.return_date_expected IS NOT NULL
        AND h.return_date_expected < CURRENT_DATE
        AND (
          h.overdue_notified_at IS NULL OR
          (${candidateRepeatDays} > 0 AND h.overdue_notified_at <= now() - (${candidateRepeatDays} * interval '1 day'))
        )
      ORDER BY h.client_id, h.return_date_expected
    `);
    hires = (overdueResult.rows ?? []) as unknown as OverdueHire[];
    result.hiresFound = hires.length;
  }

  const byClient = new Map<number, OverdueHire[]>();
  for (const hire of hires) byClient.set(hire.client_id, [...(byClient.get(hire.client_id) ?? []), hire]);
  // Clients with an unconfirmed digest are visited even when none of their
  // hires is currently a candidate (for example all were returned meanwhile).
  const openResult = await db.execute(sql`
    SELECT DISTINCT client_id FROM bike_overdue_notification_log WHERE status IN ('pending', 'sending')
  `);
  for (const row of (openResult.rows ?? []) as unknown as { client_id: number }[]) {
    if (!byClient.has(row.client_id)) byClient.set(row.client_id, []);
  }
  if (!byClient.size) return result;

  for (const [clientId, clientHires] of byClient) {
    try {
      let digest = await takeRecoverableDigest(clientId);
      if (!digest) {
        if (options.recoverOnly || !clientHires.length) continue;
        digest = await createDigest(clientId, clientHires, appUrl);
        if (!digest) continue;
      }
      const delivered = await dispatchDigest(digest, send);
      if (!delivered) continue;

      try {
        await sendPush(digest.recipient_user_ids, {
          title: "Bike hire overdue",
          body: `${digest.hire_ids.length} bike hire${digest.hire_ids.length !== 1 ? "s have" : " has"} not been returned on time.`,
          data: { route: "/(tabs)" },
        });
      } catch (pushErr) {
        logger.warn({ err: pushErr, clientId }, "Bike overdue push notification failed after email delivery");
      }

      result.clientsEmailed++;
      result.emailsSent += digest.recipient_emails.length;
      logger.info({ clientId, hires: digest.hire_ids.length, emails: digest.recipient_emails.length }, "Bike overdue notification sent");
    } catch (err) {
      result.errors++;
      logger.error({ err, clientId }, "Bike overdue notification failed");
    }
  }
  return result;
}

/** Close a digest that will not be dispatched and release its hire claims. */
async function closeDigest(digest: OutboxRow, status: "cancelled" | "expired") {
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      UPDATE bike_overdue_notification_log SET status = ${status}, updated_at = now()
      WHERE id = ${digest.id} AND status IN ('pending', 'sending')
    `);
    await tx.execute(sql`
      UPDATE bike_hire_records
      SET overdue_notification_claim_token = NULL, overdue_notification_claimed_at = NULL
      WHERE client_id = ${digest.client_id} AND overdue_notification_claim_token = ${digest.claim_token}
    `);
  });
}

/**
 * Return this client's unconfirmed digest if it may be dispatched now: pending,
 * or "sending" whose worker abandoned its lease. A digest whose hires have all
 * been returned is cancelled. One older than the provider's idempotency window
 * is expired instead of replayed, since its key no longer guarantees dedupe;
 * the hires then become eligible for a fresh evaluation.
 */
async function takeRecoverableDigest(clientId: number): Promise<OutboxRow | null> {
  const found = await db.execute(sql`
    SELECT ${OUTBOX_COLUMNS} FROM bike_overdue_notification_log
    WHERE client_id = ${clientId}
      AND (status = 'pending' OR (status = 'sending' AND updated_at < now() - (${CLAIM_LEASE_MINUTES} * interval '1 minute')))
    LIMIT 1
  `);
  const digest = ((found.rows ?? []) as unknown as OutboxRow[])[0];
  if (!digest) return null;
  if (digest.expired) {
    logger.error({ clientId, digestId: digest.id }, "Bike overdue digest stayed unconfirmed beyond the provider idempotency window");
    await closeDigest(digest, "expired");
    return null;
  }
  const stillActive = await db.execute(sql`
    SELECT 1 FROM bike_hire_records
    WHERE client_id = ${clientId} AND status = 'active'
      AND id IN (SELECT jsonb_array_elements_text(${JSON.stringify(digest.hire_ids)}::jsonb)::int)
    LIMIT 1
  `);
  if (!(stillActive.rows ?? []).length) {
    await closeDigest(digest, "cancelled");
    return null;
  }
  return digest;
}

/** Claim eligible hires and persist one immutable digest for them. */
async function createDigest(clientId: number, clientHires: OverdueHire[], appUrl: string): Promise<OutboxRow | null> {
  // An actively leased digest blocks a second snapshot for the same client.
  const open = await db.execute(sql`
    SELECT 1 FROM bike_overdue_notification_log
    WHERE client_id = ${clientId} AND status IN ('pending', 'sending') LIMIT 1
  `);
  if ((open.rows ?? []).length) return null;

  const repeatDays = configuredRepeatDays(sql`${clientId}`);
  // This helper both scopes users to this tenant and includes active account
  // admins plus explicitly configured operational managers.
  const { emails, userIds } = await getNotificationEmails(clientId, { includeMaintenanceManagers: true });
  if (!emails.length) return null;

  const ids = clientHires.map((h) => h.id);
  const claimToken = crypto.randomUUID();
  const claimed = await db.execute(sql`
    UPDATE bike_hire_records
    SET overdue_notification_claim_token = ${claimToken}, overdue_notification_claimed_at = now()
    WHERE id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
      AND client_id = ${clientId} AND status = 'active'
      AND return_date_expected IS NOT NULL AND return_date_expected < CURRENT_DATE
      AND (
        overdue_notified_at IS NULL OR
        (${repeatDays} > 0 AND overdue_notified_at <= now() - (${repeatDays} * interval '1 day'))
      )
      AND (overdue_notification_claim_token IS NULL OR overdue_notification_claimed_at < now() - (${CLAIM_LEASE_MINUTES} * interval '1 minute'))
    RETURNING id
  `);
  const claimedIds = new Set(((claimed as any).rows ?? []).map((row: any) => row.id as number));
  if (!claimedIds.size) return null;
  const release = () => db.execute(sql`
    UPDATE bike_hire_records SET overdue_notification_claim_token = NULL, overdue_notification_claimed_at = NULL
    WHERE client_id = ${clientId} AND overdue_notification_claim_token = ${claimToken}
  `);

  // Recheck status after claiming: returns recorded before dispatch are
  // suppressed. The previous alert time anchors each hire's reminder period.
  const active = await db.execute(sql`
    SELECT id, COALESCE(EXTRACT(EPOCH FROM overdue_notified_at)::text, 'initial') AS period_anchor
    FROM bike_hire_records
    WHERE client_id = ${clientId} AND status = 'active'
      AND overdue_notification_claim_token = ${claimToken}
      AND return_date_expected IS NOT NULL AND return_date_expected < CURRENT_DATE
      AND (
        overdue_notified_at IS NULL OR
        (${repeatDays} > 0 AND overdue_notified_at <= now() - (${repeatDays} * interval '1 day'))
      )
  `);
  const periods = (active.rows ?? []) as unknown as { id: number; period_anchor: string }[];
  const activeIds = new Set(periods.map((row) => row.id));
  const toSend = clientHires.filter((h) => claimedIds.has(h.id) && activeIds.has(h.id));
  if (!toSend.length) {
    await release();
    return null;
  }

  const periodDate = new Date().toISOString().slice(0, 10);
  const sendIds = new Set(toSend.map((h) => h.id));
  const idempotencyKey = bikeOverdueIdempotencyKey(clientId, periodDate, periods.filter((p) => sendIds.has(p.id)));
  const subject = `🚲 ${toSend.length} bike hire${toSend.length !== 1 ? "s" : ""} overdue for return — ComplyTrack`;
  const inserted = await db.execute(sql`
    INSERT INTO bike_overdue_notification_log
      (client_id, status, idempotency_key, claim_token, hire_ids, recipient_emails, recipient_user_ids, subject, html)
    VALUES (
      ${clientId}, 'pending', ${idempotencyKey}, ${claimToken},
      ${JSON.stringify(toSend.map((h) => h.id))}::jsonb, ${JSON.stringify(emails)}::jsonb,
      ${JSON.stringify(userIds)}::jsonb, ${subject}, ${buildEmailHtml(toSend, appUrl)}
    )
    ON CONFLICT DO NOTHING
    RETURNING ${OUTBOX_COLUMNS}
  `);
  const digest = ((inserted.rows ?? []) as unknown as OutboxRow[])[0];
  // A conflict means another worker opened a digest for this client, or this
  // exact reminder period was already handled today.
  if (!digest) await release();
  return digest ?? null;
}

/**
 * Hand a persisted digest to the provider under its stable idempotency key.
 * Any send failure, including a timeout after the provider may already have
 * accepted the message, leaves the digest pending: the retry replays the same
 * request and key, so the provider returns the original message instead of
 * delivering a duplicate.
 */
async function dispatchDigest(digest: OutboxRow, send: EmailSender): Promise<boolean> {
  const lease = await db.execute(sql`
    UPDATE bike_overdue_notification_log
    SET status = 'sending', attempts = attempts + 1, updated_at = now()
    WHERE id = ${digest.id}
      AND (status = 'pending' OR (status = 'sending' AND updated_at < now() - (${CLAIM_LEASE_MINUTES} * interval '1 minute')))
    RETURNING id
  `);
  if (!(lease.rows ?? []).length) return false;
  // Keep the hires' claim alive while their digest is in flight.
  await db.execute(sql`
    UPDATE bike_hire_records SET overdue_notification_claimed_at = now()
    WHERE client_id = ${digest.client_id} AND overdue_notification_claim_token = ${digest.claim_token}
  `);

  try {
    await send({
      to: digest.recipient_emails,
      subject: digest.subject,
      html: digest.html,
      idempotencyKey: digest.idempotency_key,
    });
  } catch (sendErr) {
    await db.execute(sql`
      UPDATE bike_overdue_notification_log SET status = 'pending', updated_at = now()
      WHERE id = ${digest.id} AND status = 'sending'
    `);
    throw sendErr;
  }

  // Complete before push dispatch. A push failure is a partial failure and
  // must not make a successfully emailed repeat eligible again.
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      UPDATE bike_overdue_notification_log SET status = 'sent', sent_at = now(), updated_at = now()
      WHERE id = ${digest.id} AND status = 'sending'
    `);
    await tx.execute(sql`
      UPDATE bike_hire_records
      SET overdue_notified_at = CASE WHEN status = 'active' THEN now() ELSE overdue_notified_at END,
          overdue_notification_claim_token = NULL, overdue_notification_claimed_at = NULL
      WHERE client_id = ${digest.client_id} AND overdue_notification_claim_token = ${digest.claim_token}
    `);
  });
  return true;
}
