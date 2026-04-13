import { Router } from "express";
import crypto from "crypto";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { requireAuth } from "../middleware/requireAuth";
import { getGcClient, GC_PLANS, type GcPlanSlug } from "../lib/gocardless";
import { logger } from "../lib/logger";

const router = Router();

const baseUrl = () =>
  process.env.APP_URL ??
  `https://${process.env.REPLIT_DOMAINS?.split(",")[0] ?? "localhost"}`;

// POST /billing/gocardless/start
// Creates a GoCardless redirect flow so the user can authorise a Direct Debit mandate.
router.post("/billing/gocardless/start", requireAuth, async (req, res) => {
  const { planSlug } = req.body as { planSlug?: string };

  if (!planSlug || !(planSlug in GC_PLANS)) {
    return res.status(400).json({ error: "Invalid plan. Choose: starter, professional, or enterprise." });
  }

  const userId = req.session.userId!;
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  if (!user) return res.status(404).json({ error: "User not found." });

  try {
    const client = getGcClient();
    const sessionToken = crypto.randomBytes(32).toString("hex");

    const redirectFlow = await client.redirectFlows.create({
      description: `ComplyTrack — ${GC_PLANS[planSlug as GcPlanSlug].name}`,
      session_token: sessionToken,
      success_redirect_url: `${baseUrl()}/api/billing/gocardless/complete`,
      prefilled_customer: {
        email: user.email,
        given_name: user.name.split(" ")[0] ?? user.name,
        family_name: user.name.split(" ").slice(1).join(" ") || undefined,
      },
    });

    // Store in session so we can complete the flow on return
    (req.session as any).gcSessionToken = sessionToken;
    (req.session as any).gcPlanSlug = planSlug;
    req.session.save();

    res.json({ redirectUrl: redirectFlow.redirect_url });
  } catch (err: any) {
    logger.error({ err }, "GoCardless redirect flow creation failed");
    res.status(500).json({ error: err.message ?? "Failed to start Direct Debit setup." });
  }
});

// GET /billing/gocardless/complete
// GoCardless redirects here after the customer authorises the mandate.
router.get("/billing/gocardless/complete", async (req, res) => {
  const { redirect_flow_id } = req.query as { redirect_flow_id?: string };

  if (!redirect_flow_id) {
    return res.redirect(`${baseUrl()}/signup?gc_error=missing_flow_id`);
  }

  const sessionToken = (req.session as any).gcSessionToken as string | undefined;
  const planSlug = (req.session as any).gcPlanSlug as string | undefined;
  const userId = req.session.userId;

  if (!sessionToken || !userId) {
    return res.redirect(`${baseUrl()}/login?gc_error=session_expired`);
  }

  try {
    const client = getGcClient();

    // Complete the redirect flow — this confirms the mandate
    const completedFlow = await client.redirectFlows.complete(redirect_flow_id, {
      session_token: sessionToken,
    });

    const mandateId = completedFlow.links?.mandate;
    const gcCustomerId = completedFlow.links?.customer;

    if (!mandateId) {
      throw new Error("No mandate returned from GoCardless.");
    }

    // Create the subscription on the mandate
    const plan = GC_PLANS[(planSlug as GcPlanSlug) ?? "professional"];
    const subscription = await client.subscriptions.create({
      amount: plan.amount,
      currency: "GBP",
      interval_unit: plan.intervalUnit,
      name: plan.name,
      links: { mandate: mandateId },
    });

    // Save GoCardless IDs + update subscription status on the user
    await db
      .update(usersTable)
      .set({
        gcMandateId: mandateId,
        gcSubscriptionId: subscription.id,
        gcCustomerId: gcCustomerId ?? null,
        subscriptionStatus: "active",
        updatedAt: new Date(),
      })
      .where(eq(usersTable.id, userId));

    // Clean up session
    delete (req.session as any).gcSessionToken;
    delete (req.session as any).gcPlanSlug;

    res.redirect(`${baseUrl()}/dashboard?billing=success`);
  } catch (err: any) {
    logger.error({ err }, "GoCardless mandate completion failed");
    res.redirect(`${baseUrl()}/dashboard?billing=gc_error&msg=${encodeURIComponent(err.message ?? "Unknown error")}`);
  }
});

// POST /billing/gocardless/webhook
// Handles GoCardless event webhooks.
router.post(
  "/billing/gocardless/webhook",
  (req, res, next) => {
    // Needs raw body for signature verification — handled by express.raw in app.ts
    next();
  },
  async (req, res) => {
    const secret = process.env.GOCARDLESS_WEBHOOK_SECRET;
    if (secret) {
      const signature = req.headers["webhook-signature"] as string;
      const body = req.body as Buffer;
      const expected = crypto
        .createHmac("sha256", secret)
        .update(body)
        .digest("hex");
      if (signature !== expected) {
        return res.status(498).json({ error: "Invalid webhook signature" });
      }
    }

    let payload: any;
    try {
      payload = JSON.parse((req.body as Buffer).toString("utf8"));
    } catch {
      return res.status(400).json({ error: "Invalid JSON" });
    }

    for (const event of payload.events ?? []) {
      logger.info({ resourceType: event.resource_type, action: event.action }, "GoCardless webhook event");

      if (event.resource_type === "subscriptions") {
        const subId = event.links?.subscription;
        if (!subId) continue;

        if (event.action === "cancelled" || event.action === "finished") {
          await db
            .update(usersTable)
            .set({ subscriptionStatus: "cancelled", updatedAt: new Date() })
            .where(eq(usersTable.gcSubscriptionId, subId));
        }
        if (event.action === "resumed") {
          await db
            .update(usersTable)
            .set({ subscriptionStatus: "active", updatedAt: new Date() })
            .where(eq(usersTable.gcSubscriptionId, subId));
        }
      }

      if (event.resource_type === "mandates") {
        const mandateId = event.links?.mandate;
        if (!mandateId) continue;
        if (event.action === "cancelled" || event.action === "failed" || event.action === "expired") {
          await db
            .update(usersTable)
            .set({ subscriptionStatus: "cancelled", updatedAt: new Date() })
            .where(eq(usersTable.gcMandateId, mandateId));
        }
        if (event.action === "reinstated") {
          await db
            .update(usersTable)
            .set({ subscriptionStatus: "active", updatedAt: new Date() })
            .where(eq(usersTable.gcMandateId, mandateId));
        }
      }
    }

    res.status(200).json({ success: true });
  },
);

export default router;
