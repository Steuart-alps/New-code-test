import { Router } from "express";
import { seedDemo } from "../lib/seedDemo";
import { ensureServicePrices, getServicePricePreflight } from "../lib/services";
import { requireAuth, requireConsultant } from "../middleware/requireAuth";
import { getClientId, requireClientAdmin } from "../middleware/requireAuth";
import { logger } from "../lib/logger";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { escapeHtml, sendSystemEmail } from "../lib/email";

const router = Router();

type DeletionClient = { id: number; name: string; eligible: boolean };
type DeletionRequest = {
  id: number;
  client_id: number;
  requested_at: Date;
  earliest_deletion_at: Date;
  notification_state: string;
  status: string;
};

async function deletionEligibility(clientId: number, consultant: boolean): Promise<DeletionClient | null> {
  const result = await db.execute(sql`
    SELECT c.id, c.name,
      (c.data_deleted_at IS NULL AND (${consultant} OR (
        (c.cancelled_at IS NOT NULL OR EXISTS (
          SELECT 1 FROM stripe.subscriptions s
          WHERE s.customer = c.stripe_customer_id AND s.status = 'canceled'
        ))
        AND NOT EXISTS (
          SELECT 1 FROM stripe.subscriptions live
          WHERE live.customer = c.stripe_customer_id
            AND live.status IN ('active', 'trialing', 'past_due')
        )
      ))) AS eligible
    FROM clients c WHERE c.id = ${clientId} LIMIT 1
  `);
  return (result.rows[0] as DeletionClient | undefined) ?? null;
}

// Account-level erasure request: records are kept for at least 30 days and
// remain untouched until an administrator has reviewed legal retention holds.
router.get("/data-deletion/request", requireAuth, requireClientAdmin, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "Select a client first" });
  try {
    const client = await deletionEligibility(clientId, req.currentUser!.role === "consultant");
    if (!client) return res.status(404).json({ error: "Client not found" });
    const result = await db.execute(sql`
      SELECT id, requested_at, earliest_deletion_at, notification_state, status
      FROM client_data_deletion_requests
      WHERE client_id = ${clientId} AND status IN ('pending','approved')
      LIMIT 1
    `);
    res.json({ eligible: client.eligible, request: result.rows[0] ?? null });
  } catch (err) {
    logger.error({ err, clientId }, "Could not load data deletion request");
    res.status(503).json({ error: "Deletion request status unavailable" });
  }
});

router.post("/data-deletion/request", requireAuth, requireClientAdmin, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "Select a client first" });
  const adminEmail = process.env.ADMIN_EMAIL?.trim();
  if (!adminEmail) return res.status(503).json({ error: "Deletion requests are temporarily unavailable. Contact support." });
  try {
    const consultant = req.currentUser!.role === "consultant";
    const client = await deletionEligibility(clientId, consultant);
    if (!client) return res.status(404).json({ error: "Client not found" });
    if (!client.eligible) return res.status(403).json({ error: "Data deletion can be requested after cancellation" });
    // Unique pending request per client, even across concurrent POSTs. A
    // repeated submission preserves the original 30-day start date.
    const inserted = await db.transaction(async tx => {
      // The deletion worker takes this same lock while checking review
      // status and deleting. An accepted request cannot race that worker.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(106, ${clientId})`);
      return tx.execute(sql`
      INSERT INTO client_data_deletion_requests
        (client_id, requested_by, earliest_deletion_at)
      SELECT c.id, ${req.currentUser!.id}, now() + interval '30 days'
      FROM clients c WHERE c.id = ${clientId}
        AND c.data_deleted_at IS NULL
        AND (${consultant} OR (
          (c.cancelled_at IS NOT NULL OR EXISTS (
            SELECT 1 FROM stripe.subscriptions s
            WHERE s.customer = c.stripe_customer_id AND s.status = 'canceled'
          ))
          AND NOT EXISTS (
            SELECT 1 FROM stripe.subscriptions live
            WHERE live.customer = c.stripe_customer_id
              AND live.status IN ('active', 'trialing', 'past_due')
          )
        ))
      ON CONFLICT (client_id) WHERE status IN ('pending','approved')
        DO UPDATE SET client_id = EXCLUDED.client_id
      RETURNING id, client_id, requested_at, earliest_deletion_at, notification_state, status
      `);
    });
    const request = inserted.rows[0] as DeletionRequest | undefined;
    if (!request) return res.status(409).json({ error: "Account status changed or deletion has begun; please refresh" });

    // Only the owner of a claim may hand off the alert. Never retry a
    // possibly-accepted message after a process interruption.
    const claimed = await db.execute(sql`
      UPDATE client_data_deletion_requests
        SET notification_state = 'sending'
      WHERE id = ${request.id} AND status IN ('pending','approved') AND notification_state = 'pending'
      RETURNING id
    `);
    if (claimed.rows.length > 0) {
      const requestedAt = new Date(request.requested_at);
      const requestDate = requestedAt.toLocaleDateString("en-GB", {
        year: "numeric", month: "long", day: "numeric", timeZone: "Europe/London",
      });
      const subject = `Data deletion requested: ${client.name} (client ${clientId})`;
      const text = `Client ${client.name} (ID ${clientId}) requested permanent data deletion on ${requestDate} (${requestedAt.toISOString()}). Earliest review date: ${new Date(request.earliest_deletion_at).toISOString()}. Manually check legal retention obligations and holds before any irreversible deletion. Request ID: ${request.id}.`;
      try {
        await sendSystemEmail({
          to: adminEmail,
          subject,
          text,
          html: `<p><strong>Account data deletion requested</strong></p><p>Client: ${escapeHtml(client.name)} (ID ${clientId})</p><p>Requested: ${escapeHtml(requestDate)} (${requestedAt.toISOString()})</p><p>Earliest deletion: ${new Date(request.earliest_deletion_at).toISOString()}</p><p>Manually review legal retention obligations and holds before any irreversible deletion. Request ID: ${request.id}.</p>`,
          idempotencyKey: `client-data-deletion:${request.id}`,
        });
      } catch (err) {
        logger.error({ err, clientId, requestId: request.id }, "Data deletion request notification failed");
        // Explicit provider rejection can be retried by resubmitting, with
        // the same provider idempotency key. No new deletion request is made.
        await db.execute(sql`
          UPDATE client_data_deletion_requests SET notification_state = 'pending'
          WHERE id = ${request.id} AND notification_state = 'sending'
        `);
        return res.status(503).json({ error: "Request saved, but the notification could not be sent. Please retry or contact support." });
      }
      try {
        await db.execute(sql`
          UPDATE client_data_deletion_requests
          SET notification_state = 'sent', email_sent_at = now()
          WHERE id = ${request.id} AND notification_state = 'sending'
        `);
      } catch (err) {
        // The provider already accepted it. Keep the request visible to
        // consultants, but never hand off a second email after an uncertain
        // persistence failure.
        logger.error({ err, clientId, requestId: request.id }, "Deletion request email accepted, but finalization failed");
        return res.status(503).json({ error: "Request saved. Administrator notification status needs manual review." });
      }
    }
    res.json({
      request: { id: request.id, requestedAt: request.requested_at, earliestDeletionAt: request.earliest_deletion_at, status: request.status },
      notificationPending: claimed.rows.length === 0 && request.notification_state !== "sent",
    });
  } catch (err) {
    logger.error({ err, clientId }, "Could not create data deletion request");
    res.status(503).json({ error: "Could not submit data deletion request" });
  }
});

router.get("/admin/data-deletion-requests", requireAuth, requireConsultant, async (req, res) => {
  try {
    const result = await db.execute(sql`
      SELECT r.id, r.client_id, c.name AS client_name, r.requested_at,
        r.earliest_deletion_at, r.notification_state, r.status, r.review_note
      FROM client_data_deletion_requests r
      JOIN clients c ON c.id = r.client_id
      WHERE r.status IN ('pending', 'approved')
        AND (r.client_id = ${req.currentUser!.clientId}
          OR EXISTS (
            SELECT 1 FROM consultant_clients cc
            WHERE cc.client_id = r.client_id AND cc.user_id = ${req.currentUser!.id}
          ))
      ORDER BY r.requested_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    logger.error({ err }, "Could not list pending data deletion requests");
    res.status(503).json({ error: "Pending deletion requests unavailable" });
  }
});

router.patch("/admin/data-deletion-requests/:id/review", requireAuth, requireConsultant, async (req, res) => {
  const id = Number(req.params.id);
  const decision = req.body?.decision;
  const note = typeof req.body?.note === "string" ? req.body.note.trim() : "";
  if (!Number.isSafeInteger(id) || id < 1 || !["approved", "refused"].includes(decision) || note.length < 10 || note.length > 2000) {
    return res.status(400).json({ error: "Choose approve or refuse and provide a review note (10–2000 characters)" });
  }
  try {
    const result = await db.transaction(async tx => {
      const selected = await tx.execute(sql`
        SELECT r.client_id FROM client_data_deletion_requests r
        WHERE r.id = ${id} AND r.status = 'pending'
          AND r.requested_by IS DISTINCT FROM ${req.currentUser!.id}
          AND (r.client_id = ${req.currentUser!.clientId}
            OR EXISTS (
              SELECT 1 FROM consultant_clients cc
              WHERE cc.client_id = r.client_id AND cc.user_id = ${req.currentUser!.id}
            ))
      `);
      const clientId = (selected.rows[0] as { client_id: number } | undefined)?.client_id;
      if (!clientId) return null;
      await tx.execute(sql`SELECT pg_advisory_xact_lock(106, ${clientId})`);
      const updated = await tx.execute(sql`
        UPDATE client_data_deletion_requests r
        SET status = ${decision}, reviewed_by = ${req.currentUser!.id},
            reviewed_at = now(), review_note = ${note}
        WHERE r.id = ${id} AND r.status = 'pending'
          AND r.requested_by IS DISTINCT FROM ${req.currentUser!.id}
          AND (r.client_id = ${req.currentUser!.clientId}
            OR EXISTS (SELECT 1 FROM consultant_clients cc
              WHERE cc.client_id = r.client_id AND cc.user_id = ${req.currentUser!.id}))
          AND (${decision} = 'refused' OR NOT EXISTS (
            SELECT 1 FROM privacy_retention_schedules h
            WHERE h.client_id = r.client_id AND h.active = true
              AND (h.legal_hold_active = true OR h.deletion_exception = true)
          ))
        RETURNING r.id, r.status, r.earliest_deletion_at
      `);
      return updated.rows[0] ?? { blocked: true };
    });
    if (!result) return res.status(404).json({ error: "Pending request not found for this consultant" });
    if ("blocked" in result) return res.status(409).json({ error: "A legal hold or deletion exception blocks approval" });
    res.json(result);
  } catch (err) {
    logger.error({ err, requestId: id }, "Could not review data deletion request");
    res.status(503).json({ error: "Review unavailable" });
  }
});

// Read-only launch check. This is deliberately separate from the repair
// endpoint below: an administrator can see every catalogue gap without
// creating Stripe products, changing a subscription, or granting access.
// GET /api/admin/service-price-preflight
router.get("/api/admin/service-price-preflight", requireAuth, requireConsultant, async (_req, res) => {
  try {
    const result = await getServicePricePreflight();
    res.status(result.ready ? 200 : 503).json(result);
  } catch (err: any) {
    logger.error({ err }, "Stripe service-price preflight failed");
    res.status(503).json({
      error: "Could not read the Stripe service-price catalogue",
      ready: false,
      required: [],
      configured: [],
      missing: [],
    });
  }
});

// One-shot demo seed endpoint, gated by a secret token.
// POST /api/admin/seed-demo  with header  Authorization: Bearer <DEMO_SEED_TOKEN>
router.post("/admin/seed-demo", async (req, res) => {
  const token = process.env.DEMO_SEED_TOKEN;
  if (!token) {
    return void res.status(503).json({ error: "Seed endpoint disabled (no token configured)." });
  }

  const auth = req.headers.authorization ?? "";
  const presented = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (presented !== token) {
    return void res.status(401).json({ error: "Invalid token" });
  }

  try {
    const result = await ensureServicePrices();
    logger.info({ result }, "Demo data seeded");
    res.json({ ok: true, ...result });
  } catch (err: any) {
    logger.error({ err }, "Demo seed failed");
    res.status(500).json({ error: err.message ?? "Seed failed" });
  }
});

// Ensure a Stripe price exists for every activatable module so clients can
// turn any of them on from their billing page. Idempotent — safe to call
// repeatedly; only creates prices for modules that are currently missing one.
// Consultant-only (platform administration action).
// POST /api/admin/ensure-service-prices
router.post("/admin/ensure-service-prices", requireAuth, requireConsultant, async (_req, res) => {
  try {
    const result = await ensureServicePrices();
    logger.info({ result }, "Ensured Stripe service prices");
    res.json({ ok: true, ...result });
  } catch (err: any) {
    logger.error({ err }, "Ensure service prices failed");
    res.status(500).json({ error: err.message ?? "Failed to ensure service prices" });
  }
});

export default router;
