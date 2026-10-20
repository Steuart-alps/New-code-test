/**
 * What happens when a business's files reach the storage it pays for
 * (Steuart, 2026-10-20: "Owner chooses"):
 *
 * - Capacity = the plan's included GiB plus the extra GiB paid for this period
 *   (storageCapacity.ts), from the live Stripe subscription.
 * - By default new uploads stop once usage reaches capacity; nothing is ever
 *   deleted. The owners get one "storage full" email per crossing, and the app
 *   shows a banner while it lasts.
 * - When an owner switches on automatic top-up (app setting
 *   storageAutoTopUp = "true"), reaching capacity instead buys enough 10 GiB
 *   packs to make room, through the same path as a Settings purchase (first month on the next
 *   monthly bill),
 *   and emails the owners what was added. A failed charge is emailed too, and
 *   is not retried automatically for STORAGE_TOP_UP_RETRY_HOURS, so uploads
 *   stop meanwhile.
 * - Capacity is enforced only for a business with a live subscription whose
 *   plan allowance is known. On a trial, without a subscription, or when
 *   Stripe can't be read, uploads are allowed (fail open) and logged.
 *
 * Every upload-link route for a business calls ensureUploadCapacity first.
 */
import { db } from "@workspace/db";
import { appSettingsTable, clientsTable } from "@workspace/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { findLiveSubscription } from "./billing";
import {
  GIB,
  listScheduledStorageReductions,
  planIncludedStorageGib,
  renewingStorageGib,
  stillPaidReducedGib,
} from "./storageCapacity";
import { readStorageUsageSnapshot } from "./storageUsageSnapshot";
import { roundUpToStoragePacks, STORAGE_PACK_GIB, STORAGE_PACK_PRICE_PENCE } from "./storagePricing";
import { randomUUID } from "crypto";
import { emailButton, escapeHtml, getPublicAppUrl, sendSystemEmail } from "./email";
import { claimEmailDelivery, emailDeliveryIdempotencyKey, settleEmailDelivery } from "./emailDeliveryClaims";
import { logger as defaultLogger } from "./logger";
import { STORAGE_AUTO_TOP_UP_SETTING, StorageFullError } from "./storageFull";

export { STORAGE_AUTO_TOP_UP_SETTING, STORAGE_FULL_CODE, STORAGE_FULL_MESSAGE, StorageFullError } from "./storageFull";

type Log = Pick<typeof defaultLogger, "error" | "warn" | "info">;

/** Usage at this share of capacity counts as nearly full (warning email and banner). */
export const STORAGE_NEARLY_FULL_RATIO = 0.8;
/** After a failed automatic charge, wait this long before charging again. */
export const STORAGE_TOP_UP_RETRY_HOURS = 24;
/** Serialises storage capacity changes per client (also used by storage reductions). */
export const STORAGE_CAPACITY_LOCK_NS = 0x53544f52; // "STOR"
const CAPACITY_CACHE_MS = 5 * 60 * 1000;
const EMAIL_JOB = "storage-limit";

/** Bytes as GB the way Settings shows them (1 GB = 1024³ bytes), one decimal. */
export function formatStorageGb(bytes: number): string {
  const gb = bytes / GIB;
  return `${Number(gb.toFixed(gb >= 10 ? 0 : 1))} GB`;
}

export type StorageCapacity = {
  capacityBytes: number;
  subscriptionId: string;
  /** Extra GiB paid for this period, on top of the plan allowance. */
  paidGib: number;
};

const capacityCache = new Map<number, { at: number; value: StorageCapacity | null }>();

/** Forget a client's cached capacity (after buying, reducing or topping up). */
export function clearStorageCapacityCache(clientId?: number): void {
  if (clientId === undefined) capacityCache.clear();
  else capacityCache.delete(clientId);
}

/**
 * The bytes a business may store, or null when it isn't limited (no live
 * subscription, or no known plan allowance). Throws when Stripe can't be read.
 */
export async function readStorageCapacity(clientId: number, options: { fresh?: boolean } = {}): Promise<StorageCapacity | null> {
  const cached = capacityCache.get(clientId);
  if (!options.fresh && cached && Date.now() - cached.at < CAPACITY_CACHE_MS) return cached.value;
  const [client] = await db.select({ stripeCustomerId: clientsTable.stripeCustomerId })
    .from(clientsTable).where(eq(clientsTable.id, clientId)).limit(1);
  let value: StorageCapacity | null = null;
  if (client?.stripeCustomerId) {
    const subscription = await findLiveSubscription(client.stripeCustomerId);
    const planGib = subscription ? planIncludedStorageGib(subscription.items.data) : null;
    if (subscription && planGib !== null) {
      const paidGib = renewingStorageGib(subscription.items.data)
        + stillPaidReducedGib(await listScheduledStorageReductions(clientId, subscription.id));
      value = { capacityBytes: (planGib + paidGib) * GIB, subscriptionId: subscription.id, paidGib };
    }
  }
  capacityCache.set(clientId, { at: Date.now(), value });
  return value;
}

export async function isStorageAutoTopUpOn(clientId: number): Promise<boolean> {
  const row = await db.query.appSettingsTable.findFirst({
    where: and(eq(appSettingsTable.clientId, clientId), eq(appSettingsTable.key, STORAGE_AUTO_TOP_UP_SETTING)),
  });
  return row?.value === "true";
}

export type StorageLimitState = "ok" | "nearly_full" | "full" | "not_limited";

export function storageLimitState(usedBytes: number, capacityBytes: number | null): StorageLimitState {
  if (capacityBytes === null) return "not_limited";
  if (usedBytes >= capacityBytes) return "full";
  if (usedBytes >= capacityBytes * STORAGE_NEARLY_FULL_RATIO) return "nearly_full";
  return "ok";
}

/** Buys storage for the automatic top-up; registered by the billing routes. */
export type StorageTopUpBuyer = (input: { clientId: number; gib: number; requestId: string; log?: Log }) =>
  Promise<{ ok: true; gibAdded: number } | { ok: false; status: number; error: string }>;

let topUpBuyer: StorageTopUpBuyer | null = null;
export function setStorageTopUpBuyer(buyer: StorageTopUpBuyer | null): void {
  topUpBuyer = buyer;
}

/**
 * Allow a new upload for this business, topping its storage up first when
 * the owner switched that on, or throw StorageFullError.
 */
export async function ensureUploadCapacity(clientId: number, log: Log = defaultLogger): Promise<void> {
  const { usedBytes } = await readStorageUsageSnapshot(clientId);
  let capacity: StorageCapacity | null;
  try {
    capacity = await readStorageCapacity(clientId);
  } catch (err) {
    log.warn({ err, clientId }, "Storage capacity unavailable; allowing the upload");
    return;
  }
  if (!capacity) return;
  if (usedBytes < capacity.capacityBytes) {
    await clearStorageFull(clientId);
    return;
  }
  const autoTopUp = await isStorageAutoTopUpOn(clientId);
  if (autoTopUp && await topUpStorage(clientId, log)) return;
  // With top-up on, the failed-top-up email already told the owners.
  await recordStorageFull(clientId, usedBytes, capacity.capacityBytes, log, { email: !autoTopUp });
  throw new StorageFullError();
}

/** Close an open "full" event once usage is back under capacity. */
async function clearStorageFull(clientId: number): Promise<void> {
  await db.execute(sql`
    UPDATE storage_limit_events SET cleared_at = now()
     WHERE client_id = ${clientId} AND kind = 'full' AND cleared_at IS NULL
  `);
}

async function recordStorageFull(
  clientId: number,
  usedBytes: number,
  capacityBytes: number,
  log: Log,
  options: { email: boolean },
): Promise<void> {
  const inserted = await db.execute(sql`
    INSERT INTO storage_limit_events (client_id, kind, used_bytes, capacity_bytes, emailed_at)
    VALUES (${clientId}, 'full', ${usedBytes}, ${capacityBytes}, ${options.email ? null : sql`now()`})
    ON CONFLICT (client_id) WHERE kind = 'full' AND cleared_at IS NULL DO NOTHING
    RETURNING id
  `);
  const id = (inserted.rows?.[0] as { id?: number } | undefined)?.id;
  if (id === undefined) return;
  log.info({ clientId, usedBytes, capacityBytes }, "Storage full: uploads stopped");
  if (!options.email) return;
  void sendStorageLimitEmail(Number(id)).catch((err) => log.error({ err, clientId }, "Storage full email failed"));
}

/**
 * Add enough 10 GiB packs for the files already stored plus room for more.
 * Runs under the client's capacity lock and re-checks after taking it, so
 * simultaneous uploads buy once. Returns whether there is now room.
 */
async function topUpStorage(clientId: number, log: Log): Promise<boolean> {
  if (!topUpBuyer) {
    log.error({ clientId }, "Automatic storage top-up is not available in this process");
    return false;
  }
  const buyer = topUpBuyer;
  const outcome = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${STORAGE_CAPACITY_LOCK_NS}, ${clientId})`);
    const recentFailure = await tx.execute(sql`
      SELECT 1 FROM storage_limit_events
       WHERE client_id = ${clientId} AND kind = 'top_up_failed'
         AND created_at > now() - make_interval(hours => ${STORAGE_TOP_UP_RETRY_HOURS})
       LIMIT 1
    `);
    if (recentFailure.rows.length > 0) return { room: false } as const;
    const capacity = await readStorageCapacity(clientId, { fresh: true });
    if (!capacity) return { room: true } as const;
    const { usedBytes } = await readStorageUsageSnapshot(clientId);
    if (usedBytes < capacity.capacityBytes) return { room: true } as const;
    const gib = roundUpToStoragePacks(Math.floor((usedBytes - capacity.capacityBytes) / GIB) + 1);
    // A fresh key per attempt: the capacity lock (with the re-check above)
    // already stops simultaneous uploads buying twice, and a rolled-back
    // charge must never be replayed from Stripe's idempotency cache.
    const requestId = `auto-${randomUUID()}`;
    // A thrown error (Stripe unreachable) counts as a failed charge, so it
    // waits out the retry pause instead of being retried on every upload.
    const result = await buyer({ clientId, gib, requestId, log }).catch((err: unknown) => {
      log.error({ err, clientId, gib }, "Automatic storage top-up threw");
      return { ok: false as const, status: 502, error: err instanceof Error ? err.message : String(err) };
    });
    clearStorageCapacityCache(clientId);
    const inserted = await tx.execute(sql`
      INSERT INTO storage_limit_events (client_id, kind, used_bytes, capacity_bytes, gib_added)
      VALUES (${clientId}, ${result.ok ? "topped_up" : "top_up_failed"}, ${usedBytes},
        ${capacity.capacityBytes + (result.ok ? result.gibAdded * GIB : 0)}, ${result.ok ? result.gibAdded : gib})
      RETURNING id
    `);
    const eventId = Number((inserted.rows[0] as { id: number }).id);
    if (result.ok) {
      await tx.execute(sql`
        UPDATE storage_limit_events SET cleared_at = now()
         WHERE client_id = ${clientId} AND kind = 'full' AND cleared_at IS NULL
      `);
      log.info({ clientId, gibAdded: result.gibAdded }, "Storage topped up automatically");
    } else {
      log.error({ clientId, gib, status: result.status, error: result.error }, "Automatic storage top-up failed");
    }
    return { room: result.ok, eventId } as const;
  });
  if ("eventId" in outcome && outcome.eventId !== undefined) {
    void sendStorageLimitEmail(outcome.eventId).catch((err) => log.error({ err, clientId }, "Storage top-up email failed"));
  }
  return outcome.room;
}

/** Active owners and consultants of a business: the people who can buy storage. */
export async function storageOwnersOf(clientId: number) {
  const result = await db.execute(sql`
    SELECT id, name, email FROM users
     WHERE client_id = ${clientId}
       AND active
       AND role IN ('consultant', 'client_admin')
       AND email IS NOT NULL AND email <> ''
     ORDER BY id
     LIMIT 30
  `);
  return (result.rows as Array<Record<string, unknown>>).map((row) => ({
    id: Number(row.id),
    name: String(row.name ?? ""),
    email: String(row.email),
  }));
}

const pounds = (pence: number) => `£${(pence / 100).toFixed(pence % 100 === 0 ? 0 : 2)}`;

export function buildStorageLimitEmail(opts: {
  kind: "full" | "topped_up" | "top_up_failed";
  recipientName: string;
  companyName: string;
  usedBytes: number;
  capacityBytes: number;
  gibAdded: number | null;
  storageUrl: string;
}) {
  const used = formatStorageGb(opts.usedBytes);
  const capacity = formatStorageGb(opts.capacityBytes);
  const company = escapeHtml(opts.companyName);
  const monthly = opts.gibAdded ? pounds((opts.gibAdded / STORAGE_PACK_GIB) * STORAGE_PACK_PRICE_PENCE) : "";
  const copy = {
    full: {
      subject: `${opts.companyName}: ComplyTrack storage is full, uploads have stopped`,
      heading: "Your storage is full",
      lines: [
        `<strong>${company}</strong> has used all <strong>${capacity}</strong> of its ComplyTrack storage, so new photos and documents can't be uploaded.`,
        "Nothing has been deleted, and everything already stored can still be opened.",
        `To start uploading again, add storage (${pounds(STORAGE_PACK_PRICE_PENCE)} a month for each ${STORAGE_PACK_GIB} GB) or switch on automatic top-up in Settings, under File storage.`,
      ],
      button: "Add storage",
    },
    topped_up: {
      subject: `${opts.companyName}: we added ${opts.gibAdded} GB of ComplyTrack storage`,
      heading: `${opts.gibAdded} GB of storage added`,
      lines: [
        `<strong>${company}</strong> reached its storage limit, so we added <strong>${opts.gibAdded} GB</strong> automatically, as set in Settings.`,
        `Your storage is now <strong>${capacity}</strong>, with <strong>${used}</strong> in use. The extra storage costs <strong>${monthly} a month</strong>. The first month is added to your next monthly bill, and it renews with your subscription after that.`,
        "You can reduce it, or switch automatic top-up off, in Settings under File storage.",
      ],
      button: "Manage storage",
    },
    top_up_failed: {
      subject: `${opts.companyName}: ComplyTrack storage is full and the automatic top-up failed`,
      heading: "Storage full: we couldn't add more",
      lines: [
        `<strong>${company}</strong> reached its storage limit of <strong>${capacity}</strong>. Automatic top-up is on, but we couldn't add ${opts.gibAdded} GB (${monthly} a month), so nothing was added and you have not been charged.`,
        "New uploads have stopped until storage is added. Nothing has been deleted.",
        "We'll try again on the first upload after 24 hours. To start uploading sooner, add storage in Settings under File storage, or contact ALPS Consultancy if it keeps happening.",
      ],
      button: "Add storage",
    },
  }[opts.kind];
  const html = `
    <h2 style="color: #1e293b; margin-top: 0;">${copy.heading}</h2>
    <p>Hi ${escapeHtml(opts.recipientName)},</p>
    ${copy.lines.map((line) => `<p>${line}</p>`).join("\n    ")}
    <p style="margin: 24px 0; text-align: center;">${emailButton(escapeHtml(opts.storageUrl), copy.button)}</p>
    <p>Best regards,<br><strong>ComplyTrack</strong></p>`;
  const text = [
    copy.heading,
    "",
    `Hi ${opts.recipientName},`,
    "",
    ...copy.lines.map((line) => line.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;/g, "'")),
    "",
    opts.storageUrl,
    "",
    "Best regards,",
    "ComplyTrack",
  ].join("\n");
  return { subject: copy.subject, html, text };
}

/**
 * Email one storage-limit event to the business's owners, once. Uses the
 * restart-safe lease pattern; the daily storage job resends anything a crash
 * left unsent. Returns the number of emails sent.
 */
export async function sendStorageLimitEmail(eventId: number, sendEmail: typeof sendSystemEmail = sendSystemEmail): Promise<number> {
  const claim = await claimEmailDelivery(EMAIL_JOB, String(eventId));
  if (!claim) return 0;
  let sent = 0;
  try {
    const rows = await db.execute(sql`
      SELECT e.client_id, e.kind, e.used_bytes::text AS used_bytes, e.capacity_bytes::text AS capacity_bytes,
             e.gib_added, e.emailed_at, c.name
        FROM storage_limit_events e JOIN clients c ON c.id = e.client_id
       WHERE e.id = ${eventId}
    `);
    const event = rows.rows[0] as Record<string, unknown> | undefined;
    if (!event || event.emailed_at) return 0;
    const clientId = Number(event.client_id);
    const owners = await storageOwnersOf(clientId);
    const storageUrl = `${getPublicAppUrl()}/settings#storage`;
    for (const owner of owners) {
      try {
        const { subject, html, text } = buildStorageLimitEmail({
          kind: event.kind as "full" | "topped_up" | "top_up_failed",
          recipientName: owner.name,
          companyName: String(event.name),
          usedBytes: Number(event.used_bytes),
          capacityBytes: Number(event.capacity_bytes),
          gibAdded: event.gib_added == null ? null : Number(event.gib_added),
          storageUrl,
        });
        await sendEmail({ to: owner.email, subject, html, text, idempotencyKey: emailDeliveryIdempotencyKey(claim, owner.id) });
        sent++;
      } catch (err) {
        defaultLogger.error({ err, clientId, userId: owner.id, eventId }, "Storage limit email failed");
      }
    }
    if (owners.length === 0) defaultLogger.warn({ clientId, eventId }, "Storage limit: no active owners to email");
    if (sent === 0 && owners.length > 0) return 0; // released below; the daily job retries
    await db.transaction(async (tx) => {
      await tx.execute(sql`UPDATE storage_limit_events SET emailed_at = now() WHERE id = ${eventId} AND emailed_at IS NULL`);
      await settleEmailDelivery(claim, tx);
    });
    return sent;
  } finally {
    if (sent === 0) await settleEmailDelivery(claim).catch(() => {});
  }
}

/** Events a crash or provider outage left unsent (older than the lease). */
export async function sendPendingStorageLimitEmails(sendEmail: typeof sendSystemEmail = sendSystemEmail): Promise<number> {
  const pending = await db.execute(sql`
    SELECT id FROM storage_limit_events
     WHERE emailed_at IS NULL AND created_at < now() - interval '15 minutes'
       AND created_at > now() - interval '7 days'
     ORDER BY id LIMIT 200
  `);
  let sent = 0;
  for (const row of pending.rows as Array<{ id: number }>) {
    sent += await sendStorageLimitEmail(Number(row.id), sendEmail).catch((err) => {
      defaultLogger.error({ err, eventId: row.id }, "Pending storage limit email failed");
      return 0;
    });
  }
  return sent;
}
