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
  const { clientId: bodyClientId } = req.body as { clientId?: number };
  const clientId = bodyClientId ?? getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const [client] = await db.select().from(clientsTable).where(eq(clientsTable.id, clientId)).limit(1);
  if (!client) return res.status(404).json({ error: "Client not found" });

  try {
    const stripe = await getUncachableStripeClient();
    const baseUrl = `https://${process.env.REPLIT_DOMAINS?.split(",")[0]}`;

    // Per-site billing: the line is always the server-resolved £10/month-per-site
    // price (never a client-supplied priceId), and the quantity is the client's
    // current number of sites (never below 1).
    const resolvedPriceId = (await getPerSitePrice())?.priceId;
    if (!resolvedPriceId) return res.status(400).json({ error: "No per-site price configured" });
    const quantity = quantityForSiteCount(await countClientSites(clientId));

    const billingEmail = req.currentUser?.email ?? undefined;
    let customerId = client.stripeCustomerId ?? undefined;
    if (!customerId) {
      const customer = await stripe.customers.create({
        name: client.name,
        email: billingEmail,
        metadata: { clientId: String(clientId) },
      });
      customerId = customer.id;
      await db.update(clientsTable)
        .set({ stripeCustomerId: customerId, updatedAt: new Date() })
        .where(eq(clientsTable.id, clientId));
    } else {
      // Backfill the billing email so Stripe invoice/receipt emails reach the
      // consultant even for customers created before emails were captured.
      if (billingEmail) {
        try {
          const existingCustomer = await stripe.customers.retrieve(customerId);
          if (!("deleted" in existingCustomer) && !existingCustomer.email) {
            await stripe.customers.update(customerId, { email: billingEmail });
          }
        } catch {
          // Non-fatal: checkout still works without the email backfill.
        }
      }
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

// GET /api/billing/invoices — list the client's Stripe invoices (scoped to
// the authenticated client's own Stripe customer; customer id is always
// resolved server-side, never taken from the request).
router.get("/invoices", requireAuth, requireRole("consultant"), async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const [client] = await db.select().from(clientsTable).where(eq(clientsTable.id, clientId)).limit(1);
  if (!client) return res.status(404).json({ error: "Client not found" });
  if (!client.stripeCustomerId) return res.json({ invoices: [] });

  try {
    const stripe = await getUncachableStripeClient();
    const list = await stripe.invoices.list({ customer: client.stripeCustomerId, limit: 24 });
    const invoices = list.data
      .filter((inv) => inv.status !== "draft")
      .map((inv) => ({
        id: inv.id,
        number: inv.number,
        status: inv.status,
        created: inv.created,
        currency: inv.currency,
        amountDue: inv.amount_due,
        amountPaid: inv.amount_paid,
        hostedInvoiceUrl: inv.hosted_invoice_url ?? null,
        invoicePdf: inv.invoice_pdf ?? null,
      }));
    res.json({ invoices });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Billing policy: each billing period is one calendar month and there are
// no refunds. The portal configuration below enforces this — cancellation
// only takes effect at the end of the already-paid month (no immediate
// cancel, no prorated refund), and plan/quantity self-service is disabled
// because site count is managed by the app (which itself never prorates).
const PORTAL_CONFIG_MARKER = "complytrack_no_refund_v1";
let cachedPortalConfigId: string | null = null;

async function findPortalConfigByMarker(stripe: any): Promise<string | null> {
  // Paginate the full list so an older config is never missed (which would
  // cause a duplicate to be created).
  let startingAfter: string | undefined;
  for (;;) {
    const page = await stripe.billingPortal.configurations.list({
      limit: 100,
      active: true,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    const found = page.data.find((c: any) => c.metadata?.marker === PORTAL_CONFIG_MARKER);
    if (found) return found.id;
    if (!page.has_more || page.data.length === 0) return null;
    startingAfter = page.data[page.data.length - 1].id;
  }
}

async function getNoRefundPortalConfigId(stripe: any): Promise<string> {
  if (cachedPortalConfigId) return cachedPortalConfigId;

  const found = await findPortalConfigByMarker(stripe);
  if (found) {
    cachedPortalConfigId = found;
    return found;
  }

  // Serialize first-time creation across concurrent requests and instances
  // with a session-level advisory lock, then re-check before creating so
  // only one configuration ever exists for the marker.
  const LOCK_KEY = 792_314_601; // arbitrary app-unique key for portal config creation
  await db.execute(sql`SELECT pg_advisory_lock(${LOCK_KEY})`);
  try {
    if (cachedPortalConfigId) return cachedPortalConfigId;
    const recheck = await findPortalConfigByMarker(stripe);
    if (recheck) {
      cachedPortalConfigId = recheck;
      return recheck;
    }
    const created = await createNoRefundPortalConfig(stripe);
    cachedPortalConfigId = created;
    return created;
  } finally {
    await db.execute(sql`SELECT pg_advisory_unlock(${LOCK_KEY})`).catch(() => {});
  }
}

async function createNoRefundPortalConfig(stripe: any): Promise<string> {
  const created = await stripe.billingPortal.configurations.create({
    metadata: { marker: PORTAL_CONFIG_MARKER },
    business_profile: {
      headline: "ComplyTrack billing — monthly billing, cancellations take effect at the end of the paid month.",
    },
    features: {
      invoice_history: { enabled: true },
      payment_method_update: { enabled: true },
      customer_update: { enabled: true, allowed_updates: ["email", "address"] },
      subscription_cancel: {
        enabled: true,
        mode: "at_period_end",
        cancellation_reason: {
          enabled: true,
          options: ["too_expensive", "missing_features", "switched_service", "unused", "other"],
        },
      },
      subscription_update: { enabled: false },
    },
  });
  cachedPortalConfigId = created.id;
  return created.id;
}

// POST /api/billing/portal — customer portal for managing subscription
router.post("/portal", requireAuth, requireRole("consultant"), async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const [client] = await db.select().from(clientsTable).where(eq(clientsTable.id, clientId)).limit(1);
  if (!client?.stripeCustomerId) return res.status(400).json({ error: "No Stripe customer for this client" });

  try {
    const stripe = await getUncachableStripeClient();
    const baseUrl = `https://${process.env.REPLIT_DOMAINS?.split(",")[0]}`;
    const configuration = await getNoRefundPortalConfigId(stripe);
    const session = await stripe.billingPortal.sessions.create({
      customer: client.stripeCustomerId,
      configuration,
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
