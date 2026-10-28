import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "./logger";
import { escapeHtml, getPublicAppUrl, sendSystemEmail } from "./email";
import { claimEmailDelivery, emailDeliveryIdempotencyKey, settleEmailDelivery } from "./emailDeliveryClaims";
import {
  formatStorageGb,
  isStorageAutoTopUpOn,
  readStorageCapacity,
  sendPendingStorageLimitEmails,
  STORAGE_NEARLY_FULL_RATIO,
  storageOwnersOf,
} from "./storageLimit";

export { formatStorageGb } from "./storageLimit";

/**
 * One email to a business's managers (consultant and client_admin users) when
 * its retained files pass the storage warning level, with a link to the File
 * Storage section where they can buy more or raise the level. The level is the
 * one set in Settings or 80% of the storage the business pays for, whichever
 * is lower, so owners always hear before uploads stop (storageLimit.ts, which
 * also sends the "full" and top-up emails; this daily job retries any of
 * those a restart left unsent).
 *
 * Usage comes from the storage usage ledger (storageUsageSnapshot.ts), so the
 * job never lists the storage provider. Each crossing is a notice in
 * storage_warning_notices; while a notice is open no further email is sent.
 * It closes once usage falls below STORAGE_WARNING_REARM_RATIO of the current
 * level (files removed, or the level raised), so a later crossing emails again.
 * Notices are never deleted. Delivery uses the restart-safe lease pattern
 * (.agents/memory/restart-safe-notification-delivery.md).
 */

export const DEFAULT_STORAGE_WARNING_THRESHOLD_BYTES = 5 * 1024 ** 3;
/** An open notice closes when usage drops below this share of the level. */
export const STORAGE_WARNING_REARM_RATIO = 0.9;
const JOB = "storage-warning";

/** The warning level from the client's storageWarningThresholdBytes setting. */
export function storageWarningThresholdBytes(settingValue: string | null | undefined): number {
  const configured = Number(settingValue);
  return Number.isSafeInteger(configured) && configured > 0
    ? configured
    : DEFAULT_STORAGE_WARNING_THRESHOLD_BYTES;
}

/**
 * The level the warning email goes at: 80% of the paid storage, or the level
 * set in Settings if the owner chose a lower one. Without a paid limit, the
 * Settings level (default 5 GB).
 */
export function storageWarningLevelBytes(settingValue: string | null | undefined, capacityBytes: number | null): number {
  if (capacityBytes === null) return storageWarningThresholdBytes(settingValue);
  const nearlyFull = Math.max(1, Math.floor(capacityBytes * STORAGE_NEARLY_FULL_RATIO));
  const chosen = Number(settingValue);
  return Number.isSafeInteger(chosen) && chosen > 0 ? Math.min(chosen, nearlyFull) : nearlyFull;
}

export function buildStorageWarningEmail(opts: {
  recipientName: string;
  companyName: string;
  usedBytes: number;
  thresholdBytes: number;
  storageUrl: string;
  /** The storage the business pays for; null when uploads aren't limited. */
  capacityBytes?: number | null;
  autoTopUp?: boolean;
}) {
  const used = formatStorageGb(opts.usedBytes);
  const level = formatStorageGb(opts.thresholdBytes);
  const capacity = opts.capacityBytes ? formatStorageGb(opts.capacityBytes) : null;
  const whatNext = capacity === null
    ? "Nothing has been deleted and uploads carry on as normal."
    : opts.autoTopUp
      ? `Nothing has been deleted. Your storage is ${capacity}; when it is full we will add 10 GB automatically (£1 a month), as set in Settings, and email you when we do.`
      : `Nothing has been deleted. Your storage is ${capacity}; when it is full, new uploads will stop until more storage is added.`;
  const subject = `${opts.companyName} has reached its ComplyTrack storage warning level`;
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #1e293b;">Storage warning level reached</h2>
      <p>Hi ${escapeHtml(opts.recipientName)},</p>
      <p><strong>${escapeHtml(opts.companyName)}</strong> is now storing about <strong>${used}</strong> of files in ComplyTrack, past the warning level of <strong>${level}</strong>.</p>
      <p>${escapeHtml(whatNext)}</p>
      <div style="background: #eef2ff; border: 1px solid #c7d2fe; border-radius: 8px; padding: 20px; margin: 20px 0; text-align: center;">
        <p style="margin: 0 0 16px; color: #475569; font-size: 14px;">If you need more room, buy extra storage in the File Storage section of Settings. You can also raise the warning level there.</p>
        <a href="${escapeHtml(opts.storageUrl)}" style="display: inline-block; background: #2563eb; color: white; text-decoration: none; padding: 12px 24px; border-radius: 6px; font-weight: 600;">Manage storage</a>
      </div>
      <p>Best regards,<br><strong>ComplyTrack</strong></p>
    </div>
  `;
  const text = `
Storage warning level reached

Hi ${opts.recipientName},

${opts.companyName} is now storing about ${used} of files in ComplyTrack, past the warning level of ${level}.

${whatNext}

If you need more room, buy extra storage in the File Storage section of Settings. You can also raise the warning level there:
${opts.storageUrl}

Best regards,
ComplyTrack
  `.trim();
  return { subject, html, text };
}

type UsageRow = {
  clientId: number;
  name: string;
  usedBytes: number;
  thresholdBytes: number;
  capacityBytes: number | null;
  autoTopUp: boolean;
};

/** The paid capacity in bytes, or null when not limited or Stripe can't be read. */
async function defaultCapacityBytes(clientId: number): Promise<number | null> {
  try {
    return (await readStorageCapacity(clientId))?.capacityBytes ?? null;
  } catch (err) {
    logger.warn({ err, clientId }, "Storage warning: capacity unavailable; using the Settings level only");
    return null;
  }
}

/** Ledger usage and warning level for every live business with stored files. */
async function readUsageByClient(
  clientIds: readonly number[] | undefined,
  capacityBytesOf: (clientId: number) => Promise<number | null>,
): Promise<UsageRow[]> {
  const scope = clientIds === undefined
    ? sql``
    : sql`AND c.id IN (${sql.join(clientIds.map((id) => sql`${id}`), sql`, `)})`;
  const result = await db.execute(sql`
    SELECT c.id, c.name, u.used_bytes::text AS used_bytes, s.value AS threshold
      FROM clients c
      JOIN (
        SELECT client_id, SUM(size_bytes) AS used_bytes
          FROM storage_usage_objects
         WHERE present
         GROUP BY client_id
      ) u ON u.client_id = c.id
      LEFT JOIN app_settings s ON s.client_id = c.id AND s.key = 'storageWarningThresholdBytes'
     WHERE c.active
       AND c.cancelled_at IS NULL
       AND c.data_deleted_at IS NULL
       ${scope}
  `);
  const rows: UsageRow[] = [];
  for (const row of result.rows as Array<Record<string, unknown>>) {
    const clientId = Number(row.id);
    const capacityBytes = await capacityBytesOf(clientId);
    rows.push({
      clientId,
      name: String(row.name),
      usedBytes: Number(row.used_bytes),
      thresholdBytes: storageWarningLevelBytes(row.threshold as string | null, capacityBytes),
      capacityBytes,
      autoTopUp: capacityBytes === null ? false : await isStorageAutoTopUpOn(clientId),
    });
  }
  return rows;
}

export async function runStorageWarningEmailJob(
  deps: {
    sendEmail?: typeof sendSystemEmail;
    /** Optional internal batch scope; omitted by the production scheduler. */
    clientIds?: readonly number[];
    /** Paid storage in bytes (null = not limited); defaults to the live subscription. */
    capacityBytes?: (clientId: number) => Promise<number | null>;
  } = {},
): Promise<{ noticesClosed: number; clientsNotified: number; emailsSent: number }> {
  const sendEmail = deps.sendEmail ?? sendSystemEmail;
  if (deps.clientIds?.length === 0) return { noticesClosed: 0, clientsNotified: 0, emailsSent: 0 };
  if (deps.clientIds === undefined) {
    // Storage-full and top-up emails a restart or provider outage left unsent.
    await sendPendingStorageLimitEmails(sendEmail).catch((err) => {
      logger.error({ err }, "Pending storage limit emails failed");
    });
  }
  const usage = await readUsageByClient(deps.clientIds, deps.capacityBytes ?? defaultCapacityBytes);
  const usageById = new Map(usage.map((row) => [row.clientId, row]));

  // Close open notices whose business is now comfortably under its level
  // (a business with no stored files has no usage row and counts as zero).
  const open = await db.execute(sql`
    SELECT id, client_id FROM storage_warning_notices WHERE cleared_at IS NULL
  `);
  let noticesClosed = 0;
  const stillOpen = new Set<number>();
  for (const row of open.rows as Array<Record<string, unknown>>) {
    const clientId = Number(row.client_id);
    if (deps.clientIds && !deps.clientIds.includes(clientId)) { stillOpen.add(clientId); continue; }
    const current = usageById.get(clientId);
    const usedBytes = current?.usedBytes ?? 0;
    const thresholdBytes = current?.thresholdBytes ?? DEFAULT_STORAGE_WARNING_THRESHOLD_BYTES;
    if (current && usedBytes >= thresholdBytes * STORAGE_WARNING_REARM_RATIO) { stillOpen.add(clientId); continue; }
    if (!current) {
      // Cancelled, deleted or empty businesses: keep the notice open unless the files are gone.
      const stored = await db.execute(sql`
        SELECT 1 FROM storage_usage_objects WHERE client_id = ${clientId} AND present LIMIT 1
      `);
      if (stored.rows.length > 0) { stillOpen.add(clientId); continue; }
    }
    await db.execute(sql`UPDATE storage_warning_notices SET cleared_at = now() WHERE id = ${Number(row.id)} AND cleared_at IS NULL`);
    noticesClosed++;
  }

  let clientsNotified = 0;
  let emailsSent = 0;
  for (const row of usage) {
    if (row.usedBytes < row.thresholdBytes || stillOpen.has(row.clientId)) continue;
    try {
      const sent = await notifyClient(row, sendEmail);
      if (sent > 0) {
        clientsNotified++;
        emailsSent += sent;
      }
    } catch (err) {
      // One client's failure must not stop warnings for the rest.
      logger.error({ err, clientId: row.clientId }, "Storage warning email failed for client");
    }
  }
  return { noticesClosed, clientsNotified, emailsSent };
}

async function notifyClient(row: UsageRow, sendEmail: typeof sendSystemEmail): Promise<number> {
  // Number this crossing so every notice has its own delivery and provider keys.
  const previous = await db.execute(sql`
    SELECT COUNT(*)::int AS notices FROM storage_warning_notices WHERE client_id = ${row.clientId}
  `);
  const crossing = Number((previous.rows[0] as { notices?: number } | undefined)?.notices ?? 0) + 1;
  const claim = await claimEmailDelivery(JOB, `${row.clientId}:${crossing}`);
  if (!claim) return 0; // another worker is sending
  let sent = 0;
  try {
    // Another worker may have finished between the usage read and the claim.
    const openNow = await db.execute(sql`
      SELECT 1 FROM storage_warning_notices WHERE client_id = ${row.clientId} AND cleared_at IS NULL LIMIT 1
    `);
    if (openNow.rows.length > 0) return 0;

    const managers = await storageOwnersOf(row.clientId);
    if (managers.length === 0) {
      logger.warn({ clientId: row.clientId }, "Storage warning: no active managers to email");
      return 0;
    }
    const storageUrl = `${getPublicAppUrl()}/settings#storage`;
    for (const manager of managers) {
      try {
        const { subject, html, text } = buildStorageWarningEmail({
          recipientName: manager.name,
          companyName: row.name,
          usedBytes: row.usedBytes,
          thresholdBytes: row.thresholdBytes,
          storageUrl,
          capacityBytes: row.capacityBytes,
          autoTopUp: row.autoTopUp,
        });
        await sendEmail({
          to: manager.email,
          subject,
          html,
          text,
          idempotencyKey: emailDeliveryIdempotencyKey(claim, manager.id),
        });
        sent++;
      } catch (err) {
        logger.error({ err, clientId: row.clientId, userId: manager.id }, "Storage warning email failed");
      }
    }
    if (sent === 0) return 0; // released below; the next run retries

    await db.transaction(async (tx) => {
      await tx.execute(sql`
        INSERT INTO storage_warning_notices (client_id, threshold_bytes, used_bytes, recipient_count)
        VALUES (${row.clientId}, ${row.thresholdBytes}, ${row.usedBytes}, ${sent})
      `);
      await settleEmailDelivery(claim, tx);
    });
    logger.info({ clientId: row.clientId, emails: sent }, "Storage warning email sent");
    return sent;
  } finally {
    if (sent === 0) await settleEmailDelivery(claim).catch(() => {});
  }
}
