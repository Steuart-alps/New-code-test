import { Router } from "express";
import { db } from "@workspace/db";
import { clientsTable } from "@workspace/db/schema";
import { eq, sql } from "drizzle-orm";
import { requireAuth, getClientId, requireRole } from "../middleware/requireAuth";
import { getUncachableStripeClient, getStripePublishableKey } from "../lib/stripeClient";
import {
  countClientSites,
  getPerSitePrice,
  getServicePrice,
  quantityForSiteCount,
  findLiveSubscription,
} from "../lib/billing";
import { invalidateTrialLock, isClientBillingLocked } from "../lib/trialLock";
import {
  SERVICES,
  ADDON_KEYS,
  BUNDLE_KEY,
  BUNDLE_LABEL,
  SERVICE_CAP_PENCE,
  getEntitledServices,
  invalidateEntitlements,
  type ServiceKey,
} from "../lib/services";

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

    // Per-service breakdown: which branches the client has, and the per-site
    // monthly rate across all of them (capped by the bundle price).
    let entitled: "all" | ServiceKey[] = ["core"];
    let activeAddons: string[] = [];
    let hasBundle = false;
    let subscribed = false;
    let perSiteRate = perSite?.unitAmount ?? 0;
    if (clientId) {
      entitled = await getEntitledServices(clientId);
      const [client] = await db.select().from(clientsTable).where(eq(clientsTable.id, clientId)).limit(1);
      if (client?.stripeCustomerId) {
        try {
          const live = await findLiveSubscription(client.stripeCustomerId);
          if (live) {
            subscribed = true;
            perSiteRate = 0;
            for (const item of live.items.data) {
              const key = item.price?.metadata?.service_key;
              if (key === BUNDLE_KEY) hasBundle = true;
              if (key && key !== BUNDLE_KEY && key !== "core") activeAddons.push(key);
              if (key || (perSite && item.price?.id === perSite.priceId)) {
                perSiteRate += item.price?.unit_amount ?? 0;
              }
            }
            perSiteRate = Math.min(perSiteRate, SERVICE_CAP_PENCE);
          }
        } catch {
          // best-effort; fall back to core-only rate
        }
      }
    }
    const monthlyTotal = perSiteRate * billableQuantity;

    // Offboarding fields — expose so the frontend can warn about pending deletion.
    let cancelledAt: string | null = null;
    let dataDeletionScheduledAt: string | null = null;
    let dataDeletedAt: string | null = null;
    if (clientId) {
      const [offRow] = await db.execute(sql`
        SELECT cancelled_at, data_deletion_scheduled_at, data_deleted_at
          FROM clients WHERE id = ${clientId}
      `).then((r) => r.rows as Array<{
        cancelled_at: string | null;
        data_deletion_scheduled_at: string | null;
        data_deleted_at: string | null;
      }>);
      if (offRow) {
        cancelledAt = offRow.cancelled_at;
        dataDeletionScheduledAt = offRow.data_deletion_scheduled_at;
        dataDeletedAt = offRow.data_deleted_at;
      }
    }

    res.json({
      publishableKey,
      subscription,
      siteCount,
      perSite,
      billableQuantity,
      monthlyTotal,
      cancelledAt,
      dataDeletionScheduledAt,
      dataDeletedAt,
      services: {
        entitled,
        addons: activeAddons,
        bundle: hasBundle,
        // True only when a LIVE Stripe subscription exists — unlike
        // `subscription.status`, which falls back to the local
        // clients.subscription_status field and can say "active" for demo/
        // trial accounts with no Stripe customer.
        subscribed,
        perSiteRate,
        capPence: SERVICE_CAP_PENCE,
        catalog: [
          ...Object.entries(SERVICES).map(([key, s]) => ({ key, label: s.label, amountPence: s.amountPence })),
          { key: BUNDLE_KEY, label: BUNDLE_LABEL, amountPence: SERVICE_CAP_PENCE },
        ],
      },
    });
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

// POST /api/billing/checkout — create Stripe checkout session.
// Consultants AND client admins may pay: when a trial expires the client's
// own admin must be able to set up billing, not just the consultant.
router.post("/checkout", requireAuth, requireRole("consultant", "client_admin"), async (req, res) => {
  const { clientId: bodyClientId, services: requestedServices, bundle } = req.body as {
    clientId?: number;
    services?: string[];
    bundle?: boolean;
  };
  const clientId = bodyClientId ?? getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const [client] = await db.select().from(clientsTable).where(eq(clientsTable.id, clientId)).limit(1);
  if (!client) return res.status(404).json({ error: "Client not found" });

  try {
    const stripe = await getUncachableStripeClient();
    const baseUrl = `https://${process.env.REPLIT_DOMAINS?.split(",")[0]}`;

    // Per-site billing: prices are always server-resolved (never client-supplied
    // price ids); the client only picks WHICH services, and quantity is the
    // client's current number of sites (never below 1).
    const quantity = quantityForSiteCount(await countClientSites(clientId));
    const lineItems: { price: string; quantity: number }[] = [];
    if (bundle) {
      const bundlePrice = await getServicePrice(BUNDLE_KEY);
      if (!bundlePrice) return res.status(400).json({ error: "Bundle price not configured" });
      lineItems.push({ price: bundlePrice.priceId, quantity });
    } else {
      const corePrice = await getPerSitePrice();
      if (!corePrice) return res.status(400).json({ error: "No per-site price configured" });
      lineItems.push({ price: corePrice.priceId, quantity });
      const requested = Array.from(new Set(requestedServices ?? []));
      const unknown = requested.filter((s) => !(ADDON_KEYS as readonly string[]).includes(s));
      if (unknown.length > 0) {
        return res.status(400).json({ error: `Unknown service(s): ${unknown.join(", ")}` });
      }
      for (const addon of requested) {
        const price = await getServicePrice(addon);
        if (!price) return res.status(400).json({ error: `Price not configured for ${addon}` });
        lineItems.push({ price: price.priceId, quantity });
      }
    }

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
      line_items: lineItems,
      mode: "subscription",
      success_url: `${baseUrl}/?billing=success&clientId=${clientId}`,
      cancel_url: `${baseUrl}/?billing=cancel`,
      metadata: { clientId: String(clientId) },
      automatic_tax: { enabled: true },
      customer_update: { address: "auto" },
    });

    res.json({ url: session.url });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/billing/services — add or remove a per-site add-on service on the
// client's live subscription. Policy mirrors sites: adding charges a full
// month immediately (no proration); removing takes effect immediately with no
// refund. The bundle is only selectable at checkout, not here.
router.post("/services", requireAuth, requireRole("consultant", "client_admin"), async (req, res) => {
  const { service, action } = req.body as { service?: string; action?: string };
  if (!service || !(ADDON_KEYS as readonly string[]).includes(service)) {
    return res.status(400).json({ error: "Unknown service" });
  }
  if (action !== "add" && action !== "remove") {
    return res.status(400).json({ error: "Action must be 'add' or 'remove'" });
  }
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const [client] = await db.select().from(clientsTable).where(eq(clientsTable.id, clientId)).limit(1);
  if (!client?.stripeCustomerId) {
    return res.status(400).json({ error: "No billing account yet — subscribe first" });
  }

  try {
    const stripe = await getUncachableStripeClient();
    const sub = await findLiveSubscription(client.stripeCustomerId);
    if (!sub) {
      return res.status(400).json({ error: "No active subscription — subscribe first" });
    }
    if (sub.items.data.some((i) => i.price?.metadata?.service_key === BUNDLE_KEY)) {
      return res.status(400).json({ error: "This account has the Complete bundle — all services are already included" });
    }

    const price = await getServicePrice(service);
    if (!price) return res.status(400).json({ error: "Service price not configured" });
    const existingItem = sub.items.data.find((i) => i.price?.metadata?.service_key === service);
    const quantity = quantityForSiteCount(await countClientSites(clientId));

    if (action === "add") {
      if (existingItem) return res.status(409).json({ error: "Service already active" });

      // Add the line for renewals (no proration), then charge the current
      // month in full immediately — same no-proration policy as added sites.
      // Idempotency keys are scoped to subscription + service + billing period
      // so a double-click can't double-charge, while re-adding the service in
      // a later period bills again as expected.
      const periodStart = sub.items.data[0]?.current_period_start ?? sub.created;
      await stripe.subscriptions.update(
        sub.id,
        {
          items: [{ price: price.priceId, quantity }],
          proration_behavior: "none",
        },
        { idempotencyKey: `svc-add-${sub.id}-${service}-${periodStart}` },
      );

      const amount = price.unitAmount * quantity;
      const label = SERVICES[service as ServiceKey].label;
      const description = `${label} — 1 month access, ${quantity} site${quantity === 1 ? "" : "s"} (no proration)`;
      try {
        // Charge the current month up front. If the invoice can't even be
        // created/finalized, the item add is rolled back below so the service
        // is never silently enabled without its first month's charge.
        const invoice = await stripe.invoices.create(
          {
            customer: client.stripeCustomerId,
            auto_advance: true,
            pending_invoice_items_behavior: "exclude",
            description,
            automatic_tax: { enabled: true },
            metadata: { addon_service: service, client_id: String(clientId), period_start: String(periodStart) },
          },
          { idempotencyKey: `svc-add-inv-${sub.id}-${service}-${periodStart}` },
        );
        await stripe.invoiceItems.create(
          {
            customer: client.stripeCustomerId,
            invoice: invoice.id!,
            amount,
            currency: price.currency,
            description,
          },
          { idempotencyKey: `svc-add-item-${sub.id}-${service}-${periodStart}` },
        );
        const finalized = await stripe.invoices.finalizeInvoice(invoice.id!);
        if (finalized.status === "open") {
          await stripe.invoices
            .pay(invoice.id!, undefined, { idempotencyKey: `svc-add-pay-${sub.id}-${service}-${periodStart}` })
            .catch((err) => {
              // Card declined etc. — auto_advance retries; access stays on.
              res.locals.paymentPending = true;
              req.log?.warn?.({ err, clientId, service }, "Add-on invoice payment failed; Stripe will retry");
            });
        }
      } catch (err: any) {
        // Roll back the item add: enabling a service without collecting its
        // first month would violate the pay-up-front policy.
        try {
          const fresh = await findLiveSubscription(client.stripeCustomerId);
          const added = fresh?.items.data.find((i) => i.price?.metadata?.service_key === service);
          if (added) await stripe.subscriptionItems.del(added.id, { proration_behavior: "none" });
        } catch (rollbackErr) {
          req.log?.error?.({ rollbackErr, clientId, service }, "Add-on rollback failed — manual attention needed");
        }
        invalidateEntitlements(clientId);
        req.log?.error?.({ err, clientId, service }, "Add-on immediate charge failed; item rolled back");
        return res.status(502).json({ error: "We couldn't complete the charge, so the service wasn't enabled. Please try again." });
      }
    } else {
      if (!existingItem) return res.status(409).json({ error: "Service not active" });
      await stripe.subscriptionItems.del(existingItem.id, { proration_behavior: "none" });
    }

    invalidateEntitlements(clientId);
    const entitled = await getEntitledServices(clientId);
    res.json({ ok: true, entitled, paymentPending: !!res.locals.paymentPending });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/billing/invoices — list the client's Stripe invoices (scoped to
// the authenticated client's own Stripe customer; customer id is always
// resolved server-side, never taken from the request).
router.get("/invoices", requireAuth, requireRole("consultant", "client_admin"), async (req, res) => {
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
router.post("/portal", requireAuth, requireRole("consultant", "client_admin"), async (req, res) => {
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

// POST /api/billing/refresh-access — drop the cached trial-lock decision for
// the caller's client and re-check Stripe fresh. Called by the lock screen
// after checkout so a new subscription restores access immediately instead of
// waiting out the cache TTL.
router.post("/refresh-access", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.json({ billingLocked: false });
  try {
    invalidateTrialLock(clientId);
    invalidateEntitlements(clientId);
    const billingLocked = await isClientBillingLocked(clientId);
    res.json({ billingLocked });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/billing/webhook — Stripe webhooks (registered raw in app.ts)
// Handled separately in app.ts before express.json()

export default router;
