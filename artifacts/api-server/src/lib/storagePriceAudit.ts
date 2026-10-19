/**
 * Periodic check that the Stripe storage add-on price still matches the
 * provider rate plus ALPS margin (see storagePricing.ts for the rules).
 *
 * Safety: it reads one Stripe price and writes only its own alert-state row
 * (audit_key "storage_addon_price" in service_price_audit_state, shared with
 * the service-price audit). It never creates or archives prices, changes
 * subscriptions or charges anyone; purchases are paused by the purchase route
 * itself while the price is out of line.
 *
 * Alerting: one ADMIN_EMAIL message per distinct finding, persisted so a later
 * run or a restart does not repeat it; a changed finding is re-alerted and
 * recovery is reported once. A failed email is retried on the next run.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { sendSystemEmail } from "./email";
import { logger } from "./logger";
import { isStripeCatalogueVerified } from "./stripeStartup";
import {
  checkStorageAddonPrice,
  storagePriceFingerprint,
  type StoragePriceCheck,
  type StoragePriceCheckResult,
} from "./storagePricing";

export const STORAGE_PRICE_AUDIT_KEY = "storage_addon_price";
/** Hourly at :35, off the :25 service-price audit and the busy :00/:30 marks. */
export const STORAGE_PRICE_AUDIT_CRON = "35 * * * *";

export interface StoragePriceAuditMessage {
  subject: string;
  text: string;
  html: string;
  idempotencyKey: string;
}

export type StoragePriceAuditNotifier = (message: StoragePriceAuditMessage) => Promise<"emailed" | "logged">;

export const notifyOperatorsOfStoragePrice: StoragePriceAuditNotifier = async (message) => {
  const adminEmail = process.env.ADMIN_EMAIL?.trim();
  if (!adminEmail) {
    logger.error({ subject: message.subject, detail: message.text }, "ADMIN_EMAIL not configured — storage add-on price alert logged only");
    return "logged";
  }
  await sendSystemEmail({ to: adminEmail, subject: message.subject, html: message.html, text: message.text, idempotencyKey: message.idempotencyKey });
  return "emailed";
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

function asHtml(title: string, text: string): string {
  return `<div style="font-family: Arial, sans-serif;"><h2>${escapeHtml(title)}</h2><pre style="white-space:pre-wrap;font-family:inherit;">${escapeHtml(text)}</pre></div>`;
}

export function formatStoragePriceAlert(check: StoragePriceCheck, openedAt: Date): StoragePriceAuditMessage {
  const fx = `${check.usdExchangeRate ?? "?"} GBP/USD${check.exchangeRateAssumed ? " (STORAGE_USD_EXCHANGE_RATE unset, cautious fallback)" : ""}`;
  const text = [
    check.message,
    "",
    `Stripe price: ${check.priceId} (${check.currency.toUpperCase()}), configured ${check.configuredUnitAmount ?? "?"} pence per GiB-month; the app sells at ${check.expectedUnitAmount} pence (£1 per 10 GiB).`,
    `Cost: ${check.providerUsdPerGibMonth ?? "?"} USD provider rate × (1 + ${check.markupPercent ?? "?"}% margin) × ${fx} = ${check.exactUnitAmount ?? "?"}, rounded up to ${check.costUnitAmount ?? "?"} pence.`,
    "",
    "New storage purchases are paused until this is fixed. Existing storage subscriptions are unchanged.",
    "Fix: if costs have risen, raise STORAGE_PACK_PRICE_PENCE in the code (a new Stripe price is then created) or correct STORAGE_PROVIDER_USD_PER_GIB_MONTH, STORAGE_ALPS_MARKUP_PERCENT or STORAGE_USD_EXCHANGE_RATE. If STORAGE_ADDON_PRICE_ID is set, point it at a monthly GBP price of the sale amount or unset it. Customers already on an old price keep it until moved in Stripe.",
    "Check any time: GET /api/admin/storage-price-check (platform operators).",
  ].join("\n");
  const subject = check.status === "drift"
    ? "[ComplyTrack] Storage add-on price no longer covers costs: purchases paused"
    : "[ComplyTrack] Storage add-on price check misconfigured: purchases paused";
  return {
    subject,
    text,
    html: asHtml(subject.replace("[ComplyTrack] ", ""), text),
    idempotencyKey: `storage-price-audit:${openedAt.getTime()}:${storagePriceFingerprint(check)}`,
  };
}

export function formatStoragePriceRecovery(openedAt: Date | null): StoragePriceAuditMessage {
  const text = "The Stripe storage add-on price matches the provider rate plus margin again (or the add-on is no longer offered). New storage purchases are available.";
  return {
    subject: "[ComplyTrack] Storage add-on price back in line",
    text,
    html: asHtml("Storage add-on price back in line", text),
    idempotencyKey: `storage-price-audit:${(openedAt ?? new Date(0)).getTime()}:recovered`,
  };
}

export interface StoragePriceAuditResult {
  status: "unavailable" | "healthy" | "alert" | "ongoing" | "recovered";
  check: StoragePriceCheckResult;
  delivered?: "emailed" | "logged" | "failed";
}

/** One audit run, serialised across instances on the single state row. */
export async function runStoragePriceAudit(options: {
  check?: () => Promise<StoragePriceCheckResult>;
  notify?: StoragePriceAuditNotifier;
  now?: () => Date;
} = {}): Promise<StoragePriceAuditResult> {
  const check = await (options.check ?? (() => checkStorageAddonPrice({ maxAgeMs: 0 })))();
  const notify = options.notify ?? notifyOperatorsOfStoragePrice;
  const now = (options.now ?? (() => new Date()))();
  // Not knowing is not a recovery: leave any open incident as it is.
  if (check.status === "unavailable") return { status: "unavailable", check };
  const problem = check.status === "drift" || check.status === "misconfigured" ? check : null;

  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`service-price-audit:${STORAGE_PRICE_AUDIT_KEY}`}))`);
    await tx.execute(sql`
      INSERT INTO service_price_audit_state (audit_key) VALUES (${STORAGE_PRICE_AUDIT_KEY})
      ON CONFLICT (audit_key) DO NOTHING
    `);
    const row = (await tx.execute(sql`
      SELECT incident_fingerprint, incident_opened_at, notified_fingerprint
      FROM service_price_audit_state WHERE audit_key = ${STORAGE_PRICE_AUDIT_KEY}
      FOR UPDATE
    `)).rows[0] as { incident_fingerprint: string | null; incident_opened_at: Date | string | null; notified_fingerprint: string | null };
    const openedAt = row.incident_opened_at ? new Date(row.incident_opened_at) : null;
    const stamp = now.toISOString();
    const touch = () => tx.execute(sql`
      UPDATE service_price_audit_state SET last_checked_at = ${stamp}::timestamptz, updated_at = now()
      WHERE audit_key = ${STORAGE_PRICE_AUDIT_KEY}
    `);

    if (problem) {
      const fingerprint = storagePriceFingerprint(problem);
      if (fingerprint === row.notified_fingerprint) {
        await touch();
        return { status: "ongoing" as const, check };
      }
      const incidentOpenedAt = openedAt ?? now;
      let delivered: StoragePriceAuditResult["delivered"];
      try {
        delivered = await notify(formatStoragePriceAlert(problem, incidentOpenedAt));
      } catch (err) {
        delivered = "failed";
        logger.error({ err }, "Storage add-on price alert could not be delivered; will retry next run");
      }
      const notified = delivered !== "failed";
      await tx.execute(sql`
        UPDATE service_price_audit_state SET
          incident_fingerprint = ${fingerprint},
          incident_issues = ${JSON.stringify(problem)}::jsonb,
          incident_opened_at = ${incidentOpenedAt.toISOString()}::timestamptz,
          notified_fingerprint = ${notified ? fingerprint : row.notified_fingerprint},
          notified_at = CASE WHEN ${notified}::boolean THEN ${stamp}::timestamptz ELSE notified_at END,
          last_checked_at = ${stamp}::timestamptz,
          updated_at = now()
        WHERE audit_key = ${STORAGE_PRICE_AUDIT_KEY}
      `);
      return { status: "alert" as const, check, delivered };
    }

    if (!row.incident_fingerprint) {
      await touch();
      return { status: "healthy" as const, check };
    }
    let delivered: StoragePriceAuditResult["delivered"];
    if (row.notified_fingerprint) {
      try {
        delivered = await notify(formatStoragePriceRecovery(openedAt));
      } catch (err) {
        delivered = "failed";
        logger.error({ err }, "Storage add-on price recovery notice could not be delivered; will retry next run");
      }
    }
    if (delivered === "failed") {
      await touch();
    } else {
      logger.info({ check }, "Storage add-on price back in line");
      await tx.execute(sql`
        UPDATE service_price_audit_state SET
          incident_fingerprint = NULL, incident_issues = '[]'::jsonb, incident_opened_at = NULL,
          notified_fingerprint = NULL, notified_at = ${stamp}::timestamptz,
          last_checked_at = ${stamp}::timestamptz, updated_at = now()
        WHERE audit_key = ${STORAGE_PRICE_AUDIT_KEY}
      `);
    }
    return { status: "recovered" as const, check, ...(delivered ? { delivered } : {}) };
  });
}

/** Scheduler wrapper: never throws into node-cron, and waits for Stripe. */
export async function runScheduledStoragePriceAudit(): Promise<void> {
  if (!isStripeCatalogueVerified()) return;
  try {
    const result = await runStoragePriceAudit();
    if (result.status === "alert" || result.status === "recovered") logger.info({ result }, "Storage add-on price audit complete");
  } catch (err) {
    logger.error({ err }, "Storage add-on price audit failed");
  }
}
