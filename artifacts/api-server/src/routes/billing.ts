import { Router } from "express";
import { db } from "@workspace/db";
import { clientsTable } from "@workspace/db/schema";
import { eq, sql } from "drizzle-orm";
import { requireAuth, getClientId, requireRole } from "../middleware/requireAuth";
import { getUncachableStripeClient, getStripePublishableKey } from "../lib/stripeClient";
import {
  countClientSites,
  getPerSitePrice,
  quantityForSiteCount,
  findLiveSubscription,
} from "../lib/billing";

const router = Router();

// GET /api/billing/config — returns publishable key + current plan info
router.get("/config", requireAuth, async (req, res) => {
  try {
    const publishableKey = await getStripePublishableKey();

    const clientId = getClientId(req);
    let subscription = null;
    let siteCount = 0;
    if (clientId) {
      const [client] = await db.select().from(clientsTable).where(eq(clientsTable.id, clientId)).limit(1);
      if (client?.stripeSubscriptionId) {
        const subRows = await db.execute(
          sql`SELECT * FROM stripe.subscriptions WHERE id = ${client.stripeSubscriptionId} LIMIT 1`
        );
        subscription = subRows.rows[0] ?? null;
      }
      if (client) {
        subscription = subscription ?? { status: client.subscriptionStatus ?? "trial" };
      }
      siteCount = await countClientSites(clientId);
    }

    const perSite = await getPerSitePrice();
    const billableQuantity = quantityForSiteCount(siteCount);
    const monthlyTotal = perSite ? perSite.unitAmount * billableQuantity : null;

    res.json({ publishableKey, subscription, siteCount, perSite, billableQuantity, monthlyTotal });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/billing/plans — list active products with prices
router.get("/plans", async (_req, res) => {
  try {
    const rows = await db.execute(sql`
      SELECT
        p.id AS product_id,
        p.name AS product_name,
        p.description AS product_description,
        p.metadata AS product_metadata,
        pr.id AS price_id,
        pr.unit_amount,
        pr.currency,
        pr.recurring
      FROM stripe.products p
      LEFT JOIN stripe.prices pr ON pr.product = p.id AND pr.active = true
      WHERE p.active = true
      ORDER BY pr.unit_amount ASC
    `);

    const map = new Map<string, any>();
    for (const r of rows.rows as any[]) {
      if (!map.has(r.product_id)) {
        map.set(r.product_id, {
          id: r.product_id,
          name: r.product_name,
          description: r.product_description,
          metadata: r.product_metadata ?? {},
          prices: [],
        });
      }
      if (r.price_id) {
        map.get(r.product_id)!.prices.push({
          id: r.price_id,
          unitAmount: r.unit_amount,
          currency: r.currency,
          interval: r.recurring?.interval ?? null,
        });
      }
    }

    const perSite = await getPerSitePrice();
    res.json({ perSite, plans: Array.from(map.values()) });
  } catch {
    res.json({ perSite: null, plans: [] });
  }
});

// POST /api/billing/checkout — create Stripe checkout session
router.post("/checkout", requireAuth, requireRole("consultant"), async (req, res) => {
  const { priceId, clientId: bodyClientId } = req.body as { priceId: string; clientId?: number };
  const clientId = bodyClientId ?? getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const [client] = await db.select().from(clientsTable).where(eq(clientsTable.id, clientId)).limit(1);
  if (!client) return res.status(404).json({ error: "Client not found" });

  try {
    const stripe = await getUncachableStripeClient();
    const baseUrl = `https://${process.env.REPLIT_DOMAINS?.split(",")[0]}`;

    // Per-site billing: the line is the £10/month-per-site price and the quantity
    // is the client's current number of sites (never below 1).
    const resolvedPriceId = priceId ?? (await getPerSitePrice())?.priceId;
    if (!resolvedPriceId) return res.status(400).json({ error: "No per-site price configured" });
    const quantity = quantityForSiteCount(await countClientSites(clientId));

    let customerId = client.stripeCustomerId ?? undefined;
    if (!customerId) {
      const customer = await stripe.customers.create({
        name: client.name,
        metadata: { clientId: String(clientId) },
      });
      customerId = customer.id;
      await db.update(clientsTable)
        .set({ stripeCustomerId: customerId, updatedAt: new Date() })
        .where(eq(clientsTable.id, clientId));
    } else {
      // Enforce one subscription per client: if a live subscription already
      // exists, don't create a second one — send them to the portal instead.
      const existing = await findLiveSubscription(customerId);
      if (existing) {
        return res.status(409).json({
          error: "This account already has an active subscription. Manage it from the billing portal.",
          hasSubscription: true,
        });
      }
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ["card"],
      line_items: [{ price: resolvedPriceId, quantity }],
      mode: "subscription",
      success_url: `${baseUrl}/?billing=success&clientId=${clientId}`,
      cancel_url: `${baseUrl}/?billing=cancel`,
      metadata: { clientId: String(clientId) },
    });

    res.json({ url: session.url });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/billing/portal — customer portal for managing subscription
router.post("/portal", requireAuth, requireRole("consultant"), async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const [client] = await db.select().from(clientsTable).where(eq(clientsTable.id, clientId)).limit(1);
  if (!client?.stripeCustomerId) return res.status(400).json({ error: "No Stripe customer for this client" });

  try {
    const stripe = await getUncachableStripeClient();
    const baseUrl = `https://${process.env.REPLIT_DOMAINS?.split(",")[0]}`;
    const session = await stripe.billingPortal.sessions.create({
      customer: client.stripeCustomerId,
      return_url: `${baseUrl}/`,
    });
    res.json({ url: session.url });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/billing/webhook — Stripe webhooks (registered raw in app.ts)
// Handled separately in app.ts before express.json()

export default router;
