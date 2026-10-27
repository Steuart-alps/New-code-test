import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { getUncachableStripeClient } from "./stripeClient";
import { emailButton, escapeHtml, getPublicAppUrl, renderEmailLayout, sendSystemEmail } from "./email";
import { SERVICES, BUNDLE_KEY, BUNDLE_LABEL } from "./services";
import { AI_ADDON_LABEL, isAiSubscriptionItem } from "./aiAddonItem";
import { isStorageSubscriptionItem } from "./storageCapacity";
import { logger } from "./logger";

/**
 * Tells ALPS (ADMIN_EMAIL) when a business starts a paid subscription, for
 * example when a free trial converts. Sent from the Stripe webhook on the
 * first paid invoice of a subscription, once per subscription: a row in
 * new_subscription_alerts is claimed before sending, so a webhook Stripe
 * delivers twice sends one email. A business that cancels and later
 * subscribes again has a new subscription and is announced again. To ALPS
 * only; nothing goes to the business. Without ADMIN_EMAIL it only logs.
 */

type SqlExecutor = (query: any) => Promise<{ rows?: unknown[] }>;

/** The parts of a Stripe subscription the alert reads. */
export interface AlertSubscription {
  items?: { data?: Array<{
    quantity?: number | null;
    price?: { id?: string | null; nickname?: string | null; metadata?: Record<string, string> | null } | null;
  }> } | null;
  discounts?: Array<string | {
    coupon?: { name?: string | null; percent_off?: number | null } | null;
    source?: { coupon?: { name?: string | null; percent_off?: number | null } | string | null } | null;
  }> | null;
}

export interface NewSubscriptionAlertDependencies {
  execute?: SqlExecutor;
  sendEmail?: typeof sendSystemEmail;
  retrieveSubscription?: (subscriptionId: string) => Promise<AlertSubscription>;
  getAppUrl?: () => string;
  adminEmail?: string | null;
}

export type NewSubscriptionAlertResult =
  | "sent"
  | "not_new_subscription"
  | "no_admin_email"
  | "unknown_business"
  | "already_sent";

/** Subscription id on an invoice, in the Stripe API shape before and after 2025-03-31.basil. */
function invoiceSubscriptionId(invoice: Record<string, any>): string | null {
  const candidates = [invoice.parent?.subscription_details?.subscription, invoice.subscription];
  for (const value of candidates) {
    if (typeof value === "string" && value) return value;
    if (value && typeof value === "object" && typeof value.id === "string") return value.id;
  }
  return null;
}

function formatMoney(pence: number, currency: string): string {
  return new Intl.NumberFormat("en-GB", { style: "currency", currency: currency.toUpperCase() }).format(pence / 100);
}

function formatUkDate(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/London" });
}

/** "FireTrack, KitchenTrack" and the number of sites, from the subscription items. */
function describeItems(subscription: AlertSubscription): { bought: string[]; sites: number | null } {
  const bought: string[] = [];
  let sites: number | null = null;
  for (const item of subscription.items?.data ?? []) {
    const quantity = Math.max(0, Number(item.quantity ?? 0) || 0);
    if (isAiSubscriptionItem(item)) { bought.push(AI_ADDON_LABEL); continue; }
    if (isStorageSubscriptionItem(item)) { bought.push(`Extra storage (${quantity} GB)`); continue; }
    const key = item.price?.metadata?.service_key ?? null;
    const label = key === BUNDLE_KEY
      ? BUNDLE_LABEL
      : key
        ? (SERVICES as Record<string, { label: string }>)[key]?.label ?? key
        : item.price?.nickname || "ComplyTrack";
    bought.push(label);
    // Modules are charged per site, so their quantity is the number of sites.
    sites = Math.max(sites ?? 0, quantity);
  }
  return { bought, sites };
}

function describeDiscount(subscription: AlertSubscription | null): string | null {
  for (const discount of subscription?.discounts ?? []) {
    if (typeof discount === "string") continue;
    const coupon = discount.coupon ?? (typeof discount.source?.coupon === "object" ? discount.source?.coupon : null);
    if (coupon?.name) return coupon.name;
    if (typeof coupon?.percent_off === "number") return `${coupon.percent_off}% off`;
  }
  return null;
}

export async function sendNewSubscriptionAlert(
  invoice: Record<string, any>,
  deps: NewSubscriptionAlertDependencies = {},
): Promise<NewSubscriptionAlertResult> {
  if (invoice.billing_reason !== "subscription_create") return "not_new_subscription";
  const subscriptionId = invoiceSubscriptionId(invoice);
  const customerId = typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id;
  if (!subscriptionId || typeof customerId !== "string") return "not_new_subscription";

  const adminEmail = (deps.adminEmail !== undefined ? deps.adminEmail : process.env.ADMIN_EMAIL)?.trim();
  if (!adminEmail) {
    logger.info("ADMIN_EMAIL not configured — new subscription alert not sent");
    return "no_admin_email";
  }

  const execute: SqlExecutor = deps.execute ?? ((query) => db.execute(query) as Promise<{ rows?: unknown[] }>);
  const clientRows = await execute(sql`
    SELECT c.id, c.name, c.created_at, d.code_hint
    FROM clients c
    LEFT JOIN billing_discount_codes d ON d.client_id = c.id
    WHERE c.stripe_customer_id = ${customerId}
    LIMIT 1
  `);
  const client = (clientRows.rows ?? [])[0] as
    | { id: number; name: string; created_at: Date | string | null; code_hint: string | null }
    | undefined;
  if (!client) return "unknown_business";

  const claim = await execute(sql`
    INSERT INTO new_subscription_alerts (stripe_subscription_id, client_id)
    VALUES (${subscriptionId}, ${client.id})
    ON CONFLICT (stripe_subscription_id) DO NOTHING
    RETURNING stripe_subscription_id
  `);
  if ((claim.rows ?? []).length === 0) return "already_sent";

  try {
    // What they bought comes from the subscription; Stripe's own line
    // descriptions stand in if it cannot be read.
    let subscription: AlertSubscription | null = null;
    try {
      const retrieve = deps.retrieveSubscription ?? (async (id: string) =>
        (await getUncachableStripeClient()).subscriptions.retrieve(id, { expand: ["discounts"] }) as unknown as AlertSubscription);
      subscription = await retrieve(subscriptionId);
    } catch (err) {
      logger.warn({ err, subscriptionId }, "Could not read the new subscription for the ALPS alert; using the invoice lines");
    }
    const fromItems = subscription ? describeItems(subscription) : { bought: [], sites: null };
    const bought = fromItems.bought.length > 0
      ? fromItems.bought
      : ((invoice.lines?.data ?? []) as Array<{ description?: string | null }>)
          .map((line) => line.description?.trim())
          .filter((d): d is string => Boolean(d));

    const currency = typeof invoice.currency === "string" ? invoice.currency : "gbp";
    const total = Number(invoice.total ?? invoice.amount_paid ?? 0) || 0;
    const beforeVat = Number(invoice.total_excluding_tax ?? total) || 0;
    const vat = Math.max(0, total - beforeVat);
    const paid = Number(invoice.amount_paid ?? total) || 0;
    const discountOff = ((invoice.total_discount_amounts ?? []) as Array<{ amount?: number }>)
      .reduce((sum, d) => sum + (Number(d.amount) || 0), 0);

    const discountName = describeDiscount(subscription);
    let discount = "None";
    if (discountName || discountOff > 0) {
      discount = discountName ?? "Discount applied";
      if (client.code_hint) discount += ` (ALPS code ending ${client.code_hint})`;
      if (discountOff > 0) discount += `, ${formatMoney(discountOff, currency)} off this payment`;
    }

    const rows: Array<[string, string]> = [
      ["Business", client.name],
      ["Paid by", typeof invoice.customer_email === "string" && invoice.customer_email ? invoice.customer_email : "Not given"],
      ["Bought", bought.join(", ") || "Not known"],
      ...(fromItems.sites ? [["Sites", String(fromItems.sites)] as [string, string]] : []),
      ["Monthly amount", vat > 0
        ? `${formatMoney(beforeVat, currency)} + VAT ${formatMoney(vat, currency)} = ${formatMoney(total, currency)}`
        : formatMoney(total, currency)],
      ["Paid today", formatMoney(paid, currency)],
      ["Discount", discount],
      ["Signed up", formatUkDate(client.created_at) ?? "Not known"],
    ];

    const appUrl = (deps.getAppUrl?.() ?? getPublicAppUrl()).replace(/\/$/, "");
    const stripeUrl = `https://dashboard.stripe.com/${invoice.livemode === false ? "test/" : ""}subscriptions/${encodeURIComponent(subscriptionId)}`;
    const html = renderEmailLayout({
      subtitle: "New subscription",
      bodyHtml: `
      <h2 style="margin:0 0 12px;font-size:22px;color:#0f172a;">${escapeHtml(client.name)} has subscribed</h2>
      <p style="margin:0 0 16px;">A business has started paying for ComplyTrack.</p>
      <table style="border-collapse:collapse;margin:0 0 24px;">
        ${rows.map(([label, value]) => `<tr><td style="padding:6px 16px 6px 0;color:#64748b;vertical-align:top;white-space:nowrap;">${label}</td><td style="padding:6px 0;"><strong>${escapeHtml(value)}</strong></td></tr>`).join("")}
      </table>
      <p style="margin:0 0 24px;">${emailButton(escapeHtml(stripeUrl), "Open in Stripe")}</p>
      <p style="margin:0;font-size:14px;color:#64748b;">The business is listed under Clients in <a href="${escapeHtml(appUrl)}/clients" style="color:#2563eb;">ComplyTrack</a>.</p>`,
    });

    await (deps.sendEmail ?? sendSystemEmail)({
      to: adminEmail,
      subject: `New ComplyTrack subscription: ${client.name}`,
      html,
      text: `${client.name} has subscribed to ComplyTrack\n\n${rows.map(([label, value]) => `${label}: ${value}`).join("\n")}\n\nStripe: ${stripeUrl}\nComplyTrack: ${appUrl}/clients`,
      idempotencyKey: `new-subscription-alert:${subscriptionId}`,
    });
    logger.info({ clientId: client.id, subscriptionId }, "New subscription alert sent to ALPS");
    return "sent";
  } catch (err) {
    // Not sent: free the claim so a repeat delivery of the webhook can retry.
    await execute(sql`DELETE FROM new_subscription_alerts WHERE stripe_subscription_id = ${subscriptionId}`)
      .catch(() => undefined);
    throw err;
  }
}
