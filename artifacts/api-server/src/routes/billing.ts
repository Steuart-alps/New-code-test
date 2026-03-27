import { Router } from "express";
import { db } from "@workspace/db";
import { clientsTable } from "@workspace/db/schema";
import { eq, sql } from "drizzle-orm";
import { requireAuth, getClientId, requireRole } from "../middleware/requireAuth";
import { getUncachableStripeClient, getStripePublishableKey } from "../lib/stripeClient";

const router = Router();

// GET /api/billing/config — returns publishable key + current plan info
router.get("/config", requireAuth, async (req, res) => {
  try {
    const publishableKey = await getStripePublishableKey();

    const clientId = getClientId(req);
    let subscription = null;
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
    }

    res.json({ publishableKey, subscription });
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

    res.json({ plans: Array.from(map.values()) });
  } catch {
    res.json({ plans: [] });
  }
});

// POST /api/billing/checkout — create Stripe checkout session
router.post("/checkout", requireAuth, requireRole("consultant"), async (req, res) => {
  const { priceId, clientId: bodyClientId } = req.body as { priceId: string; clientId?: number };
  const clientId = bodyClientId ?? getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  if (!priceId) return res.status(400).json({ error: "priceId required" });

  const [client] = await db.select().from(clientsTable).where(eq(clientsTable.id, clientId)).limit(1);
  if (!client) return res.status(404).json({ error: "Client not found" });

  try {
    const stripe = await getUncachableStripeClient();
    const baseUrl = `https://${process.env.REPLIT_DOMAINS?.split(",")[0]}`;

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
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ["card"],
      line_items: [{ price: priceId, quantity: 1 }],
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
