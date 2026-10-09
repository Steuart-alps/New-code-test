import { jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Operator-alert state for the periodic, read-only Stripe service-price audit.
 * One row per audit (currently only `service_prices`). It records the
 * unresolved incident and what operators were last told, so the same incident
 * is not re-alerted on every run or after a restart, and recovery is reported.
 * It never stores Stripe credentials or customer data.
 */
export const servicePriceAuditStateTable = pgTable("service_price_audit_state", {
  auditKey: text("audit_key").primaryKey(),
  incidentFingerprint: text("incident_fingerprint"),
  incidentIssues: jsonb("incident_issues").notNull().default([]),
  incidentOpenedAt: timestamp("incident_opened_at", { withTimezone: true }),
  notifiedFingerprint: text("notified_fingerprint"),
  notifiedAt: timestamp("notified_at", { withTimezone: true }),
  lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ServicePriceAuditState = typeof servicePriceAuditStateTable.$inferSelect;
