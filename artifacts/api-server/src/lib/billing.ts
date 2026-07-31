import { db } from "@workspace/db";
import { clientsTable, sitesTable } from "@workspace/db/schema";
import { eq, sql } from "drizzle-orm";
import { getUncachableStripeClient } from "./stripeClient";
import { logger } from "./logger";

export const PER_SITE_UNIT_AMOUNT = 1000; // £10.00 in pence
export const PER_SITE_CURRENCY = "gbp";

/** Number of sites (buildings) belonging to a client. */
export async function countClientSites(clientId: number): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(sitesTable)
    .where(eq(sitesTable.clientId, clientId));
  return rows[0]?.count ?? 0;
}

/** Subscription quantity is the site count, but never below 1 (Stripe requires >= 1). */
export function quantityForSiteCount(siteCount: number): number {
  return Math.max(siteCount, 1);
}

export interface PerSitePrice {
  priceId: string;
  unitAmount: number;
  currency: string;
  interval: string | null;
}

/**
 * Resolve the active per-site monthly price from the Stripe-synced tables.
 * After the per-site migration there is a single active recurring product, so we
 * take the cheapest active monthly price on an active product.
 */
export async function getPerSitePrice(): Promise<PerSitePrice | null> {
  return getServicePrice("core");
}

/**
 * Resolve the active per-site monthly price for a service by its
 * `service_key` price metadata. For "core", falls back to the legacy
 * cheapest-active-monthly-price lookup so pre-metadata deployments keep
 * working until the seed script has been re-run.
 */
export async function getServicePrice(serviceKey: string): Promise<PerSitePrice | null> {
  try {
    const rows = await db.execute(sql`
      SELECT pr.id AS price_id, pr.unit_amount, pr.currency, pr.recurring
      FROM stripe.prices pr
      JOIN stripe.products p ON p.id = pr.product
      WHERE p.active = true
        AND pr.active = true
        AND (pr.recurring->>'interval') = 'month'
        AND pr.metadata->>'service_key' = ${serviceKey}
      ORDER BY pr.unit_amount ASC
      LIMIT 1
    `);
    if (!rows.rows[0] && serviceKey === "core") {
      // Legacy fallback: single-product era with no metadata. Exclude any
      // price that carries a different service_key so add-on prices can never
      // masquerade as the core plan.
      const legacy = await db.execute(sql`
        SELECT pr.id AS price_id, pr.unit_amount, pr.currency, pr.recurring
        FROM stripe.prices pr
        JOIN stripe.products p ON p.id = pr.product
        WHERE p.active = true
          AND pr.active = true
          AND (pr.recurring->>'interval') = 'month'
          AND (pr.metadata->>'service_key') IS NULL
        ORDER BY pr.unit_amount ASC
        LIMIT 1
      `);
      rows.rows[0] = legacy.rows[0];
    }
    const r = rows.rows[0] as any;
    if (!r) return null;
    return {
      priceId: r.price_id,
      unitAmount: Number(r.unit_amount),
      currency: r.currency,
      interval: r.recurring?.interval ?? "month",
    };
  } catch (err) {
    logger.error({ err }, "Failed to resolve per-site price");
    return null;
  }
}

/**
 * Find a client's current "live" subscription (active, trialing or past_due) by
 * looking it up dynamically against the Stripe API by customer id. Returns null
 * when the customer has no such subscription. We enforce one subscription per
 * client, so the first match is the canonical one.
 */
export async function findLiveSubscription(customerId: string) {
  const stripe = await getUncachableStripeClient();
  const subs = await stripe.subscriptions.list({
    customer: customerId,
    status: "all",
    limit: 10,
  });
  return (
    subs.data.find((s) =>
      ["active", "trialing", "past_due"].includes(s.status),
    ) ?? null
  );
}

// ---------------------------------------------------------------------------
// Per-client serialization of quantity syncs.
//
// Two site changes landing at nearly the same moment could otherwise interleave
// their read-count → update-Stripe steps and apply updates out of order,
// briefly leaving the billed quantity out of step with the real site count.
// Each client's syncs run one at a time; because every run re-reads the site
// count and current subscription state at its start, the last run in the chain
// always converges Stripe to the true count. A pending flag coalesces bursts:
// if a sync is already queued (not yet started) for a client, additional
// requests piggyback on it instead of queueing more redundant Stripe calls.
// ---------------------------------------------------------------------------
const syncChains = new Map<number, Promise<QuantityCorrection | null>>();
const syncPending = new Set<number>();

/**
 * Details of a subscription quantity change applied by a sync — i.e. billing
 * drift that was detected and corrected.
 */
export interface QuantityCorrection {
  clientId: number;
  clientName: string | null;
  subscriptionId: string;
  fromQuantity: number;
  toQuantity: number;
}

/**
 * Bring a client's Stripe subscription quantity in line with their current site
 * count (no proration: added sites are charged a full month immediately,
 * removed sites get no refund). Best-effort: logs and returns on any problem so the
 * triggering site create/delete still succeeds. Concurrent calls for the same
 * client are serialized (and coalesced) so updates can't land out of order.
 * Resolves with the correction applied, or null when nothing changed.
 */
export function syncClientSubscriptionQuantity(
  clientId: number,
): Promise<QuantityCorrection | null> {
  // Already queued but not started: that run will read the latest state.
  if (syncPending.has(clientId)) {
    return syncChains.get(clientId) ?? Promise.resolve(null);
  }
  syncPending.add(clientId);

  const prev = syncChains.get(clientId) ?? Promise.resolve(null);
  const run = prev.then(() => {
    // Now starting: later callers must queue a fresh run to observe their changes.
    syncPending.delete(clientId);
    return doSyncClientSubscriptionQuantity(clientId);
  });
  // Never propagate rejections into the chain (doSync catches internally anyway).
  const chained = run.catch(() => null);
  syncChains.set(clientId, chained);
  chained.finally(() => {
    // Drop the map entry once the chain is fully drained to avoid unbounded growth.
    if (syncChains.get(clientId) === chained) {
      syncChains.delete(clientId);
    }
  });
  return run;
}

/**
 * Reconcile every client that has a Stripe customer: re-run the quantity sync
 * so any billing drift (missed webhooks, transient Stripe failures) self-heals
 * without waiting for the next site change. Clients are processed sequentially
 * to keep Stripe API usage gentle; each sync is best-effort and never throws.
 */
export async function reconcileAllSubscriptionQuantities(): Promise<{
  clients: number;
  corrections: QuantityCorrection[];
}> {
  const clients = await db
    .select({ id: clientsTable.id })
    .from(clientsTable)
    .where(sql`${clientsTable.stripeCustomerId} IS NOT NULL`);
  const corrections: QuantityCorrection[] = [];
  for (const c of clients) {
    const correction = await syncClientSubscriptionQuantity(c.id);
    if (correction) {
      logger.warn(
        {
          clientId: correction.clientId,
          clientName: correction.clientName,
          subscriptionId: correction.subscriptionId,
          fromQuantity: correction.fromQuantity,
          toQuantity: correction.toQuantity,
        },
        "Billing drift corrected: subscription quantity did not match site count",
      );
      corrections.push(correction);
    }
  }

  // Retry any outbox charges that a previous run failed to collect (e.g. a
  // crash between the quantity update and the invoice, or a declined card).
  const pending = await db.execute(sql`
    SELECT DISTINCT client_id FROM billing_pending_charges WHERE status = 'pending'
  `);
  for (const row of (pending.rows ?? []) as unknown as { client_id: number }[]) {
    try {
      await processPendingCharges(row.client_id);
    } catch (err) {
      logger.error({ err, clientId: row.client_id }, "Pending charge retry failed");
    }
  }

  return { clients: clients.length, corrections };
}

// Namespace for advisory lock keys so we don't collide with other lock users.
const BILLING_SYNC_LOCK_NS = 0x42494c4c; // "BILL"

async function doSyncClientSubscriptionQuantity(
  clientId: number,
): Promise<QuantityCorrection | null> {
  try {
    // Cross-instance serialization: the in-process queue above only covers a
    // single server process. A Postgres transaction-scoped advisory lock keyed
    // by client id guarantees that even with multiple API instances, only one
    // sync per client runs at a time; each waits its turn and then re-reads
    // the latest site count, so the final Stripe quantity matches reality.
    return await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(${BILLING_SYNC_LOCK_NS}, ${clientId})`,
      );
      return await syncWithStripe(clientId, tx);
    });
  } catch (err) {
    logger.error({ err, clientId }, "Failed to sync subscription quantity");
    return null;
  }
}

type DbLike = Pick<typeof db, "select" | "execute">;

async function syncWithStripe(
  clientId: number,
  dbc: DbLike = db,
): Promise<QuantityCorrection | null> {
  try {
    const [client] = await dbc
      .select()
      .from(clientsTable)
      .where(eq(clientsTable.id, clientId))
      .limit(1);
    if (!client?.stripeCustomerId) return null; // not a paying customer yet

    const active = await findLiveSubscription(client.stripeCustomerId);
    if (!active) return null;

    // Resize every per-site service line item (core plan, add-ons, bundle) in
    // lockstep — each is billed per site. Items are recognised by service_key
    // price metadata, or by matching the resolved core price (legacy, pre-
    // metadata). Subscriptions with no per-site item (e.g. legacy tiers) are
    // left untouched.
    const perSite = await getPerSitePrice();
    const perSiteItems = active.items.data.filter(
      (i) => i.price?.metadata?.service_key || (perSite && i.price?.id === perSite.priceId),
    );
    if (perSiteItems.length === 0) {
      logger.info(
        { clientId, subscriptionId: active.id },
        "No per-site line item on subscription; skipping quantity sync",
      );
      return null;
    }

    const desired = quantityForSiteCount(await countClientSites(clientId));
    // All per-site items are kept at the same quantity; use the max as the
    // reference so a partial previous update still converges.
    const current = Math.max(...perSiteItems.map((i) => i.quantity ?? 0));
    if (perSiteItems.every((i) => (i.quantity ?? 0) === desired)) return null;

    // Billing policy: no proration in either direction.
    // - Adding sites: the full monthly fee per added site is charged
    //   immediately (one month's access), regardless of where we are in the
    //   billing period.
    // - Removing sites: no refunds or credits; the paid month simply runs out
    //   and the next renewal bills the lower quantity.
    const added = desired - current;

    const stripe = await getUncachableStripeClient();
    // No proration: quantity changes take effect on the next invoice, so a
    // month is always billed in full regardless of when sites are added or
    // removed. Keeps invoices and tax simple.
    await stripe.subscriptions.update(active.id, {
      items: perSiteItems.map((i) => ({ id: i.id, quantity: desired })),
      proration_behavior: "none",
    });

    if (added > 0) {
      logger.info(
        { clientId, subscriptionId: active.id, fromQuantity: current, quantity: desired, added },
        "Increased subscription quantity; full-month charge queued",
      );
      await processPendingCharges(clientId);
    } else {
      logger.info(
        { clientId, subscriptionId: active.id, fromQuantity: current, quantity: desired },
        "Decreased subscription quantity (no refund/credit)",
      );
    }
    return {
      clientId,
      clientName: client.name ?? null,
      subscriptionId: active.id,
      fromQuantity: current,
      toQuantity: desired,
    };
  } catch (err) {
    logger.error({ err, clientId }, "Failed to sync subscription quantity");
    return null;
  }
}

interface PendingChargeRow {
  id: number;
  client_id: number;
  sites_added: number;
  amount: number;
  currency: string;
  stripe_invoice_id: string | null;
  created_at: string | Date;
}

/**
 * Record charge intent for a newly added site. MUST be called in the same
 * database transaction that inserts the site row, so a crash can never lose
 * the billable event and the event can never exist without the site.
 * One row per site, enforced by a unique index on site_id.
 * Amount is resolved at charge time (amount = 0 means "look up current
 * per-site price"), and whether the client is actually billable (has a live
 * per-site subscription) is also decided at charge time.
 */
export async function queueSiteAddedCharge(
  dbc: DbLike,
  clientId: number,
  siteId: number,
): Promise<void> {
  await dbc.execute(sql`
    INSERT INTO billing_pending_charges
      (client_id, site_id, sites_added, amount, currency)
    VALUES (${clientId}, ${siteId}, 1, 0, '')
    ON CONFLICT (site_id) WHERE site_id IS NOT NULL DO NOTHING
  `);
}

/**
 * Charge every pending outbox row for a client: one dedicated invoice per row
 * (scoped invoice items — never sweeps unrelated pending items). Idempotent:
 * the Stripe invoice id is stored on the row as soon as the invoice exists, so
 * retries only re-attempt collection, never create a second invoice.
 */
export async function processPendingCharges(clientId: number): Promise<void> {
  const [client] = await db
    .select()
    .from(clientsTable)
    .where(eq(clientsTable.id, clientId))
    .limit(1);
  if (!client?.stripeCustomerId) return;

  const stripe = await getUncachableStripeClient();

  // Process rows one at a time, each under an atomic claim: the row is locked
  // with FOR UPDATE SKIP LOCKED inside a transaction, so concurrent workers
  // (other API instances, the reconcile cron) can never process the same row
  // simultaneously. All Stripe calls use idempotency keys derived from the row
  // id, so even a crash after invoice creation but before the commit of
  // stripe_invoice_id cannot create a second invoice on retry.
  //
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const done = await db.transaction(async (tx) => {
      const claimed = await tx.execute(sql`
        SELECT id, client_id, sites_added, amount, currency, stripe_invoice_id, created_at
        FROM billing_pending_charges
        WHERE client_id = ${clientId} AND status = 'pending'
        ORDER BY id
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      `);
      const row = (claimed.rows ?? [])[0] as unknown as PendingChargeRow | undefined;
      if (!row) return true; // nothing left (or another worker holds the lock)

      // Charge decisions are made at charge time, not enqueue time:
      // only clients with a live per-site subscription are billable, and the
      // amount is the current per-site price. Non-billable rows (trial
      // clients, legacy plans) are skipped permanently.
      const [active, perSite] = await Promise.all([
        findLiveSubscription(client.stripeCustomerId!),
        getPerSitePrice(),
      ]);
      // Per-site monthly rate for this client = sum of all their per-site
      // service items (core + add-ons, or the bundle), so an added site is
      // charged for every service they subscribe to.
      const perSiteServiceItems = (active?.items.data ?? []).filter(
        (i) => i.price?.metadata?.service_key || (perSite && i.price?.id === perSite.priceId),
      );
      const perSiteRate = perSiteServiceItems.reduce(
        (sum, i) => sum + (i.price?.unit_amount ?? 0),
        0,
      );
      // A site added BEFORE the subscription existed is already covered by
      // the initial checkout quantity — charging it again would double-bill.
      const rawCreated = row.created_at;
      const queuedAt =
        rawCreated instanceof Date
          ? rawCreated.getTime()
          : new Date(
              // Timestamps are stored in UTC without a zone marker.
              rawCreated.endsWith("Z") || rawCreated.includes("+") ? rawCreated : `${rawCreated}Z`,
            ).getTime();
      const subscriptionStartedAt = active ? active.created * 1000 : 0;
      // Skip only rows STRICTLY earlier than the subscription. Timestamps are
      // second-granularity; a site added in the same second as checkout must
      // still be billed (never lose a valid charge at the boundary).
      const preSubscription = queuedAt < subscriptionStartedAt;
      const billable = active && perSiteServiceItems.length > 0 && perSiteRate > 0 && !preSubscription;
      if (!billable) {
        await tx.execute(sql`
          UPDATE billing_pending_charges
          SET status = 'skipped', charged_at = now()
          WHERE id = ${row.id}
        `);
        logger.info(
          { clientId, pendingChargeId: row.id },
          "Skipped added-site charge: no live per-site subscription",
        );
        return false;
      }
      const amount = row.amount > 0 ? row.amount : row.sites_added * perSiteRate;
      const currency = row.currency || perSiteServiceItems[0]?.price?.currency || "gbp";

      const itemDescription = `${row.sites_added} additional site${row.sites_added === 1 ? "" : "s"} — 1 month access (no proration)`;

      let invoiceId = row.stripe_invoice_id;
      if (!invoiceId) {
        // Durable duplicate guard that outlives Stripe idempotency-key
        // retention: look for an invoice already tagged with this row id.
        try {
          const existing = await stripe.invoices.search({
            query: `metadata['pending_charge_id']:'${row.id}'`,
            limit: 1,
          });
          if (existing.data[0]?.id) invoiceId = existing.data[0].id;
        } catch (err) {
          logger.warn({ err, clientId }, "Invoice metadata search failed; relying on idempotency key");
        }
      }
      if (!invoiceId) {
        // Dedicated invoice; exclude unrelated pending invoice items. The
        // idempotency key ties the invoice to this outbox row forever.
        const invoice = await stripe.invoices.create(
          {
            customer: client.stripeCustomerId!,
            auto_advance: true,
            pending_invoice_items_behavior: "exclude",
            description: itemDescription,
            automatic_tax: { enabled: true },
            metadata: { pending_charge_id: String(row.id), client_id: String(clientId) },
          },
          { idempotencyKey: `pending-charge-invoice-${row.id}` },
        );
        if (!invoice.id) {
          // Malformed response — park the row for manual attention instead of
          // tight-looping; drift alerting surfaces 'error' rows.
          await tx.execute(sql`
            UPDATE billing_pending_charges SET status = 'error' WHERE id = ${row.id}
          `);
          logger.error({ clientId, pendingChargeId: row.id }, "Stripe returned invoice without id");
          return false;
        }
        invoiceId = invoice.id;
      }
      if (invoiceId !== row.stripe_invoice_id) {
        await tx.execute(sql`
          UPDATE billing_pending_charges
          SET stripe_invoice_id = ${invoiceId}
          WHERE id = ${row.id}
        `);
      }

      let invoice = await stripe.invoices.retrieve(invoiceId);
      if (invoice.status === "draft") {
        // Attach the (single) line item. Idempotency key guarantees exactly
        // one item even if a previous attempt crashed mid-way.
        await stripe.invoiceItems.create(
          {
            customer: client.stripeCustomerId!,
            invoice: invoiceId,
            amount,
            currency,
            description: itemDescription,
          },
          { idempotencyKey: `pending-charge-item-${row.id}` },
        );
        invoice = await stripe.invoices.finalizeInvoice(invoiceId);
      }
      if (invoice.status === "open") {
        try {
          invoice = await stripe.invoices.pay(invoiceId, undefined, {
            idempotencyKey: `pending-charge-pay-${row.id}`,
          });
        } catch (err) {
          // Card declined etc. — auto_advance keeps retrying; row stays pending.
          logger.warn(
            { err, clientId, invoiceId },
            "Added-site invoice payment failed; will retry via reconciliation",
          );
        }
      }
      if (invoice.status === "paid" || invoice.status === "void" || invoice.status === "uncollectible") {
        await tx.execute(sql`
          UPDATE billing_pending_charges
          SET status = ${invoice.status === "paid" ? "charged" : invoice.status}, charged_at = now()
          WHERE id = ${row.id}
        `);
        logger.info(
          { clientId, invoiceId, amount: row.amount, invoiceStatus: invoice.status },
          "Resolved pending added-site charge",
        );
        return false; // resolved this row; look for the next one
      }
      // Still open/awaiting payment: keep row pending but stop iterating —
      // the same row would be re-selected forever in this loop otherwise.
      return true;
    });
    if (done) break;
  }
}
