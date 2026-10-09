/**
 * Periodic, read-only audit of the Stripe-synced service-price catalogue.
 *
 * Startup and `check:service-prices` only see the catalogue at one moment. A
 * price or product archived in Stripe afterwards (or a second active monthly
 * price added) reaches the synced `stripe.*` mirror through webhooks, and would
 * otherwise surface only when a client's add-on activation fails. This job
 * re-runs the same preflight on a schedule and alerts operators.
 *
 * Safety: it only reads the synced mirror (no Stripe API calls) and writes only
 * its own alert-state row. It never deactivates prices, repairs products,
 * alters subscriptions or charges anyone.
 *
 * Alerting: one alert per distinct unresolved incident (the set of affected
 * services and reasons), persisted in `service_price_audit_state` so neither a
 * later run nor a restart repeats it; a changed set is re-alerted; recovery is
 * reported once. A failed email is retried on the next run.
 */
import { createHash } from "node:crypto";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { getServicePricePreflight, type ServicePricePreflight } from "./services";
import { sendSystemEmail } from "./email";
import { logger } from "./logger";

export const SERVICE_PRICE_AUDIT_KEY = "service_prices";
/** Hourly at :25 — off the busy :00/:30 marks used by the daily jobs. */
export const SERVICE_PRICE_AUDIT_CRON = "25 * * * *";

export type ServicePriceIssue = ServicePricePreflight["issues"][number];

export interface ServicePriceAuditStateSnapshot {
  incidentFingerprint: string | null;
  incidentIssues: ServicePriceIssue[];
  incidentOpenedAt: Date | null;
  notifiedFingerprint: string | null;
}

export type ServicePriceAuditDecision =
  | { kind: "healthy" }
  | { kind: "ongoing"; issues: ServicePriceIssue[] }
  | {
      kind: "alert";
      /** "opened" for a new incident, "changed" when the affected set differs from the last alert. */
      change: "opened" | "changed";
      fingerprint: string;
      issues: ServicePriceIssue[];
      /** Services named in the previous alert that are no longer affected. */
      resolved: ServicePriceIssue[];
      openedAt: Date;
    }
  | { kind: "recovered"; previous: ServicePriceIssue[]; openedAt: Date | null }
  /** An incident that was never successfully alerted has cleared. */
  | { kind: "cleared_unnotified"; previous: ServicePriceIssue[] };

export function servicePriceIncidentFingerprint(issues: readonly ServicePriceIssue[]): string {
  return issues.map((issue) => `${issue.key}:${issue.reason}`).sort().join(",");
}

/** Pure alert/dedupe policy, kept separate so it is testable without a database. */
export function decideServicePriceAudit(
  state: ServicePriceAuditStateSnapshot,
  preflight: Pick<ServicePricePreflight, "ready" | "issues">,
  now: Date,
): ServicePriceAuditDecision {
  if (preflight.ready || preflight.issues.length === 0) {
    if (state.notifiedFingerprint) {
      return { kind: "recovered", previous: state.incidentIssues, openedAt: state.incidentOpenedAt };
    }
    if (state.incidentFingerprint) {
      return { kind: "cleared_unnotified", previous: state.incidentIssues };
    }
    return { kind: "healthy" };
  }
  const fingerprint = servicePriceIncidentFingerprint(preflight.issues);
  if (fingerprint === state.notifiedFingerprint) {
    return { kind: "ongoing", issues: preflight.issues };
  }
  const current = new Set(preflight.issues.map((issue) => `${issue.key}:${issue.reason}`));
  const resolved = state.notifiedFingerprint
    ? state.incidentIssues.filter((issue) => !current.has(`${issue.key}:${issue.reason}`))
    : [];
  return {
    kind: "alert",
    change: state.notifiedFingerprint ? "changed" : "opened",
    fingerprint,
    issues: preflight.issues,
    resolved,
    openedAt: state.incidentOpenedAt ?? now,
  };
}

function describeIssue(issue: ServicePriceIssue): string {
  return issue.reason === "missing"
    ? "no active monthly GBP price"
    : "more than one active monthly GBP price";
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

export interface ServicePriceAuditMessage {
  subject: string;
  text: string;
  html: string;
  idempotencyKey: string;
}

/** Operator-facing message for an alert or recovery decision (no secrets, no customer data). */
export function formatServicePriceAuditMessage(
  decision: Extract<ServicePriceAuditDecision, { kind: "alert" | "recovered" }>,
): ServicePriceAuditMessage {
  const incidentId = (decision.openedAt ?? new Date(0)).getTime();
  if (decision.kind === "recovered") {
    const labels = decision.previous.map((issue) => issue.label);
    const text = [
      "The Stripe service-price catalogue is complete again: every service has exactly one active monthly GBP price.",
      labels.length ? `Previously affected: ${labels.join(", ")}.` : "",
      "No prices, products, subscriptions or charges were changed by this check.",
    ].filter(Boolean).join("\n");
    return {
      subject: "[ComplyTrack] Stripe service prices recovered",
      text,
      html: `<div style="font-family: Arial, sans-serif;"><h2>Stripe service prices recovered</h2>${text.split("\n").map((line) => `<p>${escapeHtml(line)}</p>`).join("")}</div>`,
      idempotencyKey: `service-price-audit:${incidentId}:recovered`,
    };
  }
  const labels = decision.issues.map((issue) => issue.label);
  const lines = decision.issues.map((issue) => `- ${issue.label} (${issue.key}): ${describeIssue(issue)}`);
  const resolvedLines = decision.resolved.map((issue) => `- ${issue.label} (${issue.key})`);
  const text = [
    decision.change === "opened"
      ? "The periodic Stripe service-price audit found services that clients cannot currently activate:"
      : "The set of Stripe service-price problems has changed. Currently affected:",
    ...lines,
    ...(resolvedLines.length ? ["", "No longer affected:", ...resolvedLines] : []),
    "",
    "Missing prices: restore an active monthly GBP price with metadata service_key for each service (or run POST /api/admin/ensure-service-prices).",
    "Duplicate prices: review in Stripe which price backs existing subscriptions before archiving any; nothing is deactivated automatically.",
    "This alert is sent once per incident; you will be told when it changes or recovers.",
  ].join("\n");
  const html = `<div style="font-family: Arial, sans-serif;"><h2>Stripe service-price problem</h2><pre style="white-space:pre-wrap;font-family:inherit;">${escapeHtml(text)}</pre></div>`;
  const digest = createHash("sha256").update(decision.fingerprint).digest("hex").slice(0, 16);
  return {
    subject: `[ComplyTrack] Stripe service prices ${decision.change === "opened" ? "need attention" : "changed"}: ${labels.join(", ")}`,
    text,
    html,
    idempotencyKey: `service-price-audit:${incidentId}:${digest}`,
  };
}

export type ServicePriceAuditNotifier = (message: ServicePriceAuditMessage) => Promise<"emailed" | "logged">;

/**
 * Default delivery: ADMIN_EMAIL via the system mailer. Without ADMIN_EMAIL the
 * error log is the alert, consistent with the billing drift alert.
 */
export const notifyOperatorsOfServicePrices: ServicePriceAuditNotifier = async (message) => {
  const adminEmail = process.env.ADMIN_EMAIL?.trim();
  if (!adminEmail) {
    logger.error({ subject: message.subject, detail: message.text }, "ADMIN_EMAIL not configured — Stripe service-price audit alert logged only");
    return "logged";
  }
  await sendSystemEmail({
    to: adminEmail,
    subject: message.subject,
    html: message.html,
    text: message.text,
    idempotencyKey: message.idempotencyKey,
  });
  return "emailed";
};

export interface ServicePriceAuditResult {
  status: "read_failed" | ServicePriceAuditDecision["kind"];
  issues: ServicePriceIssue[];
  delivered?: "emailed" | "logged" | "failed";
}

function parseIssues(value: unknown): ServicePriceIssue[] {
  const raw = typeof value === "string" ? JSON.parse(value) : value;
  return Array.isArray(raw) ? raw as ServicePriceIssue[] : [];
}

/**
 * One audit run. Serialised across instances with a transaction-scoped
 * advisory lock on the single state row. The email is sent before commit with
 * a stable idempotency key, so a crash after delivery re-sends at most into the
 * provider's dedupe window rather than losing the alert.
 */
export async function runServicePriceAudit(options: {
  readPreflight?: () => Promise<ServicePricePreflight>;
  notify?: ServicePriceAuditNotifier;
  now?: () => Date;
} = {}): Promise<ServicePriceAuditResult> {
  const readPreflight = options.readPreflight ?? getServicePricePreflight;
  const notify = options.notify ?? notifyOperatorsOfServicePrices;
  const now = (options.now ?? (() => new Date()))();

  let preflight: ServicePricePreflight;
  try {
    preflight = await readPreflight();
  } catch (err) {
    // A read failure is not a recovery: leave the incident state untouched.
    logger.warn({ err }, "Stripe service-price audit could not read the synced catalogue");
    return { status: "read_failed", issues: [] };
  }

  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`service-price-audit:${SERVICE_PRICE_AUDIT_KEY}`}))`);
    await tx.execute(sql`
      INSERT INTO service_price_audit_state (audit_key) VALUES (${SERVICE_PRICE_AUDIT_KEY})
      ON CONFLICT (audit_key) DO NOTHING
    `);
    const row = (await tx.execute(sql`
      SELECT incident_fingerprint, incident_issues, incident_opened_at, notified_fingerprint
      FROM service_price_audit_state WHERE audit_key = ${SERVICE_PRICE_AUDIT_KEY}
      FOR UPDATE
    `)).rows[0] as {
      incident_fingerprint: string | null;
      incident_issues: unknown;
      incident_opened_at: Date | string | null;
      notified_fingerprint: string | null;
    };
    const state: ServicePriceAuditStateSnapshot = {
      incidentFingerprint: row.incident_fingerprint,
      incidentIssues: parseIssues(row.incident_issues),
      incidentOpenedAt: row.incident_opened_at ? new Date(row.incident_opened_at) : null,
      notifiedFingerprint: row.notified_fingerprint,
    };
    const decision = decideServicePriceAudit(state, preflight, now);

    let delivered: ServicePriceAuditResult["delivered"];
    if (decision.kind === "alert" || decision.kind === "recovered") {
      const message = formatServicePriceAuditMessage(decision);
      try {
        delivered = await notify(message);
      } catch (err) {
        delivered = "failed";
        logger.error({ err, subject: message.subject }, "Stripe service-price audit alert could not be delivered; will retry next run");
      }
    }

    if (decision.kind === "alert") {
      logger.error(
        { issues: decision.issues, resolved: decision.resolved, change: decision.change },
        "Stripe service-price audit: affected modules cannot be activated",
      );
      const notified = delivered !== "failed";
      await tx.execute(sql`
        UPDATE service_price_audit_state SET
          incident_fingerprint = ${decision.fingerprint},
          incident_issues = ${JSON.stringify(decision.issues)}::jsonb,
          incident_opened_at = ${decision.openedAt.toISOString()}::timestamptz,
          notified_fingerprint = ${notified ? decision.fingerprint : state.notifiedFingerprint},
          notified_at = CASE WHEN ${notified}::boolean THEN ${now.toISOString()}::timestamptz ELSE notified_at END,
          last_checked_at = ${now.toISOString()}::timestamptz,
          updated_at = now()
        WHERE audit_key = ${SERVICE_PRICE_AUDIT_KEY}
      `);
    } else if (decision.kind === "recovered" && delivered === "failed") {
      // Keep the incident open so the recovery notice is retried next run.
      await tx.execute(sql`
        UPDATE service_price_audit_state SET last_checked_at = ${now.toISOString()}::timestamptz, updated_at = now()
        WHERE audit_key = ${SERVICE_PRICE_AUDIT_KEY}
      `);
    } else if (decision.kind === "recovered" || decision.kind === "cleared_unnotified") {
      logger.info({ previous: decision.previous }, "Stripe service-price audit: catalogue recovered");
      await tx.execute(sql`
        UPDATE service_price_audit_state SET
          incident_fingerprint = NULL, incident_issues = '[]'::jsonb, incident_opened_at = NULL,
          notified_fingerprint = NULL, notified_at = ${now.toISOString()}::timestamptz,
          last_checked_at = ${now.toISOString()}::timestamptz, updated_at = now()
        WHERE audit_key = ${SERVICE_PRICE_AUDIT_KEY}
      `);
    } else {
      await tx.execute(sql`
        UPDATE service_price_audit_state SET last_checked_at = ${now.toISOString()}::timestamptz, updated_at = now()
        WHERE audit_key = ${SERVICE_PRICE_AUDIT_KEY}
      `);
    }

    return {
      status: decision.kind,
      issues: preflight.issues,
      ...(delivered ? { delivered } : {}),
    };
  });
}

/** Scheduler wrapper: never throws into node-cron. */
export async function runScheduledServicePriceAudit(): Promise<void> {
  try {
    const result = await runServicePriceAudit();
    if (result.status !== "healthy" && result.status !== "ongoing") {
      logger.info({ result }, "Stripe service-price audit complete");
    }
  } catch (err) {
    logger.error({ err }, "Stripe service-price audit failed");
  }
}
