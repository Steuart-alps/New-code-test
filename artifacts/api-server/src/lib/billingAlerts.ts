import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { getUncachableStripeClient } from "./stripeClient";
import { emailButton, escapeHtml, getPublicAppUrl, renderEmailLayout, sendSystemEmail } from "./email";
import { SERVICES, BUNDLE_KEY, BUNDLE_LABEL } from "./services";
import { AI_ADDON_LABEL, isAiSubscriptionItem } from "./aiAddonItem";
import { isStorageSubscriptionItem } from "./storageCapacity";
import { logger } from "./logger";

/**
 * Billing news for ALPS (ADMIN_EMAIL), from the Stripe webhook, recorded as
 * billing_alerts rows:
 *
 * - a business starts a paid subscription (its first paid invoice);
 * - a business cancels (or Stripe cancels it after failed payments), with the
 *   reason they picked in the billing portal;
 * - modules, AI, extra storage or sites added or removed.
 *
 * Every Monday a digest of the week goes to ALPS: net gain or loss, the
 * changes, cancellation reasons and the most used modules as bar charts, and
 * the current totals. Each change is also emailed on its own only when
 * EMAIL_BILLING_CHANGES_AT_ONCE is set. One row per change, claimed by
 * (kind, alert_key), so a webhook Stripe delivers twice counts once; a failed
 * send frees the claim. Nothing goes
 * to the business. Without ADMIN_EMAIL nothing is recorded or sent.
 */

type SqlExecutor = (query: any) => Promise<{ rows?: unknown[] }>;

type Coupon = { name?: string | null; percent_off?: number | null; amount_off?: number | null };

type AlertItem = {
  quantity?: number | null;
  price?: {
    id?: string | null;
    nickname?: string | null;
    unit_amount?: number | null;
    metadata?: Record<string, string> | null;
  } | null;
};

/** The parts of a Stripe subscription these alerts read. */
export interface AlertSubscription {
  id?: string;
  customer?: string | { id?: string } | null;
  status?: string | null;
  cancel_at_period_end?: boolean | null;
  cancel_at?: number | null;
  canceled_at?: number | null;
  ended_at?: number | null;
  start_date?: number | null;
  livemode?: boolean | null;
  cancellation_details?: { reason?: string | null; feedback?: string | null; comment?: string | null } | null;
  items?: { data?: AlertItem[] | null } | null;
  discounts?: Array<string | { coupon?: Coupon | null; source?: { coupon?: Coupon | string | null } | null }> | null;
}

export interface BillingAlertDependencies {
  execute?: SqlExecutor;
  sendEmail?: typeof sendSystemEmail;
  retrieveSubscription?: (subscriptionId: string) => Promise<AlertSubscription>;
  getAppUrl?: () => string;
  adminEmail?: string | null;
  now?: () => Date;
  /** Overrides EMAIL_BILLING_CHANGES_AT_ONCE (tests). */
  emailAtOnce?: boolean;
}

export type BillingAlertResult =
  | "sent"
  | "recorded"
  | "not_applicable"
  | "no_admin_email"
  | "unknown_business"
  | "already_sent";

/**
 * ALPS chose the Monday digest only (Oct 2026): every change is recorded
 * for it and none is emailed on its own. Set true to email each new
 * subscription, cancellation and plan change as it happens as well.
 */
export const EMAIL_BILLING_CHANGES_AT_ONCE = false;

/** The reasons the billing portal offers, and why Stripe itself cancels. */
export const CANCELLATION_REASON_LABELS: Record<string, string> = {
  too_expensive: "Too expensive",
  missing_features: "Missing features",
  switched_service: "Switched to another service",
  unused: "Not using it enough",
  customer_service: "Customer service",
  too_complex: "Too complicated",
  low_quality: "Quality",
  other: "Other",
  payment_failed: "Payment failed",
  payment_disputed: "Payment disputed",
  none: "No reason given",
};

// ---- Shared helpers -------------------------------------------------------

function emailsAtOnce(deps: BillingAlertDependencies): boolean {
  return deps.emailAtOnce ?? EMAIL_BILLING_CHANGES_AT_ONCE;
}

function adminAddress(deps: BillingAlertDependencies): string | null {
  const value = deps.adminEmail !== undefined ? deps.adminEmail : process.env.ADMIN_EMAIL;
  return value?.trim() || null;
}

function executor(deps: BillingAlertDependencies): SqlExecutor {
  return deps.execute ?? ((query) => db.execute(query) as Promise<{ rows?: unknown[] }>);
}

function retriever(deps: BillingAlertDependencies) {
  return deps.retrieveSubscription ?? (async (id: string) =>
    (await getUncachableStripeClient()).subscriptions.retrieve(id, { expand: ["discounts"] }) as unknown as AlertSubscription);
}

function appUrlOf(deps: BillingAlertDependencies): string {
  return (deps.getAppUrl?.() ?? getPublicAppUrl()).replace(/\/$/, "");
}

export function formatMoney(pence: number, currency = "gbp"): string {
  return new Intl.NumberFormat("en-GB", { style: "currency", currency: currency.toUpperCase() }).format(pence / 100);
}

function formatUkDate(value: Date | string | number | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(typeof value === "number" ? value * 1000 : value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/London" });
}

function customerIdOf(value: unknown): string | null {
  if (typeof value === "string" && value) return value;
  if (value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string") return (value as { id: string }).id;
  return null;
}

function stripeSubscriptionUrl(subscriptionId: string, livemode: boolean | null | undefined): string {
  return `https://dashboard.stripe.com/${livemode === false ? "test/" : ""}subscriptions/${encodeURIComponent(subscriptionId)}`;
}

function itemLabel(item: AlertItem): string {
  const quantity = Math.max(0, Number(item.quantity ?? 0) || 0);
  if (isAiSubscriptionItem(item)) return AI_ADDON_LABEL;
  if (isStorageSubscriptionItem(item)) return `Extra storage (${quantity} GB)`;
  const key = item.price?.metadata?.service_key ?? null;
  if (key === BUNDLE_KEY) return BUNDLE_LABEL;
  if (key) return (SERVICES as Record<string, { label: string }>)[key]?.label ?? key;
  return item.price?.nickname || "ComplyTrack";
}

/** Modules are charged per site, so a module's quantity is the number of sites. */
function isPerSiteItem(item: AlertItem): boolean {
  return !isAiSubscriptionItem(item) && !isStorageSubscriptionItem(item);
}

function describeItems(items: AlertItem[]): { bought: string[]; sites: number | null; storageGb: number } {
  const bought: string[] = [];
  let sites: number | null = null;
  let storageGb = 0;
  for (const item of items) {
    const quantity = Math.max(0, Number(item.quantity ?? 0) || 0);
    bought.push(itemLabel(item));
    if (isStorageSubscriptionItem(item)) storageGb += quantity;
    else if (isPerSiteItem(item)) sites = Math.max(sites ?? 0, quantity);
  }
  return { bought, sites, storageGb };
}

function couponsOf(subscription: AlertSubscription | null): Coupon[] {
  const coupons: Coupon[] = [];
  for (const discount of subscription?.discounts ?? []) {
    if (typeof discount === "string") continue;
    const coupon = discount.coupon ?? (typeof discount.source?.coupon === "object" ? discount.source?.coupon : null);
    if (coupon) coupons.push(coupon);
  }
  return coupons;
}

/** Monthly amount before VAT: list prices times quantities, less any discount. */
function monthlyBeforeVat(items: AlertItem[], coupons: Coupon[]): number {
  let total = items.reduce((sum, item) =>
    sum + (Number(item.price?.unit_amount ?? 0) || 0) * Math.max(0, Number(item.quantity ?? 0) || 0), 0);
  for (const coupon of coupons) {
    if (typeof coupon.percent_off === "number") total = Math.round(total * (1 - coupon.percent_off / 100));
    else if (typeof coupon.amount_off === "number") total = Math.max(0, total - coupon.amount_off);
  }
  return total;
}

async function findBusiness(execute: SqlExecutor, customerId: string) {
  const rows = await execute(sql`
    SELECT c.id, c.name, c.created_at, d.code_hint
    FROM clients c
    LEFT JOIN billing_discount_codes d ON d.client_id = c.id
    WHERE c.stripe_customer_id = ${customerId}
    LIMIT 1
  `);
  return (rows.rows ?? [])[0] as
    | { id: number; name: string; created_at: Date | string | null; code_hint: string | null }
    | undefined;
}

async function claim(execute: SqlExecutor, row: {
  kind: string; key: string; clientId: number | null; businessName: string | null;
  summary: string | null; monthlyPence: number; reason: string | null;
}): Promise<boolean> {
  const result = await execute(sql`
    INSERT INTO billing_alerts (kind, alert_key, client_id, business_name, summary, monthly_pence, reason)
    VALUES (${row.kind}, ${row.key}, ${row.clientId}, ${row.businessName}, ${row.summary}, ${row.monthlyPence}, ${row.reason})
    ON CONFLICT (kind, alert_key) DO NOTHING
    RETURNING id
  `);
  return (result.rows ?? []).length > 0;
}

/** A repeat delivery is answered without asking Stripe again. */
async function alreadyClaimed(execute: SqlExecutor, kind: string, key: string): Promise<boolean> {
  const result = await execute(sql`SELECT 1 FROM billing_alerts WHERE kind = ${kind} AND alert_key = ${key} LIMIT 1`);
  return (result.rows ?? []).length > 0;
}

async function release(execute: SqlExecutor, kind: string, key: string): Promise<void> {
  await execute(sql`DELETE FROM billing_alerts WHERE kind = ${kind} AND alert_key = ${key}`).catch(() => undefined);
}

function detailsTable(rows: Array<[string, string]>): string {
  return `<table style="border-collapse:collapse;margin:0 0 24px;">
        ${rows.map(([label, value]) => `<tr><td style="padding:6px 16px 6px 0;color:#64748b;vertical-align:top;white-space:nowrap;">${label}</td><td style="padding:6px 0;"><strong>${escapeHtml(value)}</strong></td></tr>`).join("")}
      </table>`;
}

/** Send one alert; on failure free its claim so a repeat delivery can retry. */
async function sendClaimed(
  deps: BillingAlertDependencies,
  claimKey: { kind: string; key: string },
  message: { to: string; subject: string; html: string; text: string },
): Promise<void> {
  try {
    await (deps.sendEmail ?? sendSystemEmail)({ ...message, idempotencyKey: `billing-alert:${claimKey.kind}:${claimKey.key}` });
  } catch (err) {
    await release(executor(deps), claimKey.kind, claimKey.key);
    throw err;
  }
}

// ---- New subscription -----------------------------------------------------

/** Subscription id on an invoice, in the Stripe API shape before and after 2025-03-31.basil. */
function invoiceSubscriptionId(invoice: Record<string, any>): string | null {
  for (const value of [invoice.parent?.subscription_details?.subscription, invoice.subscription]) {
    const id = customerIdOf(value);
    if (id) return id;
  }
  return null;
}

/** invoice.paid: the first paid invoice of a subscription means a business has started paying. */
export async function sendNewSubscriptionAlert(
  invoice: Record<string, any>,
  deps: BillingAlertDependencies = {},
): Promise<BillingAlertResult> {
  if (invoice.billing_reason !== "subscription_create") return "not_applicable";
  const subscriptionId = invoiceSubscriptionId(invoice);
  const customerId = customerIdOf(invoice.customer);
  if (!subscriptionId || !customerId) return "not_applicable";

  const adminEmail = adminAddress(deps);
  if (!adminEmail) {
    logger.info("ADMIN_EMAIL not configured — new subscription alert not sent");
    return "no_admin_email";
  }
  const execute = executor(deps);
  const client = await findBusiness(execute, customerId);
  if (!client) return "unknown_business";
  if (await alreadyClaimed(execute, "new_subscription", subscriptionId)) return "already_sent";

  // What they bought comes from the subscription; Stripe's own line
  // descriptions stand in if it cannot be read.
  let subscription: AlertSubscription | null = null;
  try {
    subscription = await retriever(deps)(subscriptionId);
  } catch (err) {
    logger.warn({ err, subscriptionId }, "Could not read the new subscription for the ALPS alert; using the invoice lines");
  }
  const fromItems = describeItems(subscription?.items?.data ?? []);
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

  const coupon = couponsOf(subscription)[0];
  const discountName = coupon?.name ?? (typeof coupon?.percent_off === "number" ? `${coupon.percent_off}% off` : null);
  let discount = "None";
  if (discountName || discountOff > 0) {
    discount = discountName ?? "Discount applied";
    if (client.code_hint) discount += ` (ALPS code ending ${client.code_hint})`;
    if (discountOff > 0) discount += `, ${formatMoney(discountOff, currency)} off this payment`;
  }

  const summary = `${bought.join(", ") || "Subscription"}${fromItems.sites ? `, ${fromItems.sites} site${fromItems.sites === 1 ? "" : "s"}` : ""}, ${formatMoney(beforeVat, currency)} a month + VAT${discount === "None" ? "" : `. Discount: ${discount}`}`;
  const claimKey = { kind: "new_subscription", key: subscriptionId };
  if (!(await claim(execute, { ...claimKey, clientId: client.id, businessName: client.name, summary, monthlyPence: beforeVat, reason: null }))) {
    return "already_sent";
  }
  if (!emailsAtOnce(deps)) return "recorded";

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
  const appUrl = appUrlOf(deps);
  const stripeUrl = stripeSubscriptionUrl(subscriptionId, invoice.livemode);
  const html = renderEmailLayout({
    subtitle: "New subscription",
    bodyHtml: `
      <h2 style="margin:0 0 12px;font-size:22px;color:#0f172a;">${escapeHtml(client.name)} has subscribed</h2>
      <p style="margin:0 0 16px;">A business has started paying for ComplyTrack.</p>
      ${detailsTable(rows)}
      <p style="margin:0 0 24px;">${emailButton(escapeHtml(stripeUrl), "Open in Stripe")}</p>
      <p style="margin:0;font-size:14px;color:#64748b;">The business is listed under Clients in <a href="${escapeHtml(appUrl)}/clients" style="color:#2563eb;">ComplyTrack</a>.</p>`,
  });
  await sendClaimed(deps, claimKey, {
    to: adminEmail,
    subject: `New ComplyTrack subscription: ${client.name}`,
    html,
    text: `${client.name} has subscribed to ComplyTrack\n\n${rows.map(([label, value]) => `${label}: ${value}`).join("\n")}\n\nStripe: ${stripeUrl}\nComplyTrack: ${appUrl}/clients`,
  });
  logger.info({ clientId: client.id, subscriptionId }, "New subscription alert sent to ALPS");
  return "sent";
}

// ---- Cancellation ---------------------------------------------------------

function isCancelling(subscription: AlertSubscription): boolean {
  return subscription.status === "canceled"
    || subscription.cancel_at_period_end === true
    || (typeof subscription.cancel_at === "number" && subscription.status !== "incomplete_expired");
}

function cancellationReasonKey(subscription: AlertSubscription): string {
  const details = subscription.cancellation_details;
  if (details?.reason === "payment_failed" || details?.reason === "payment_disputed") return details.reason;
  const feedback = details?.feedback;
  return feedback && CANCELLATION_REASON_LABELS[feedback] ? feedback : "none";
}

/**
 * customer.subscription.updated / .deleted: a cancellation scheduled in the
 * billing portal, or a subscription Stripe ended. One email per subscription;
 * the later "ended" event of a scheduled cancellation sends nothing more.
 */
export async function sendCancellationAlert(
  payload: AlertSubscription,
  deps: BillingAlertDependencies = {},
): Promise<BillingAlertResult> {
  const subscriptionId = typeof payload.id === "string" ? payload.id : null;
  const customerId = customerIdOf(payload.customer);
  if (!subscriptionId || !customerId || !isCancelling(payload)) return "not_applicable";

  const adminEmail = adminAddress(deps);
  if (!adminEmail) {
    logger.info("ADMIN_EMAIL not configured — cancellation alert not sent");
    return "no_admin_email";
  }
  const execute = executor(deps);
  const client = await findBusiness(execute, customerId);
  if (!client) return "unknown_business";
  if (await alreadyClaimed(execute, "cancellation", subscriptionId)) return "already_sent";

  // A delayed event must not announce a cancellation that was since undone.
  let subscription: AlertSubscription = payload;
  try {
    subscription = await retriever(deps)(subscriptionId);
  } catch (err) {
    logger.warn({ err, subscriptionId }, "Could not re-read the cancelled subscription; using the webhook copy");
  }
  if (!isCancelling(subscription)) return "not_applicable";

  const items = subscription.items?.data ?? payload.items?.data ?? [];
  const { bought, sites } = describeItems(items);
  const monthly = monthlyBeforeVat(items, couponsOf(subscription));
  const reasonKey = cancellationReasonKey(subscription);
  const reason = CANCELLATION_REASON_LABELS[reasonKey]!;
  const comment = subscription.cancellation_details?.comment?.trim() || null;
  const accessEnds = formatUkDate(subscription.cancel_at ?? subscription.ended_at ?? subscription.canceled_at ?? null);

  const ended = subscription.status === "canceled";
  const summary = `${bought.join(", ") || "Subscription"}${sites ? `, ${sites} site${sites === 1 ? "" : "s"}` : ""}, ${formatMoney(monthly)} a month + VAT. ${ended ? "Access ended" : "Access ends"} ${accessEnds ?? "on a date not known"}. Reason: ${reason}${comment ? ` ("${comment}")` : ""}`;
  const claimKey = { kind: "cancellation", key: subscriptionId };
  if (!(await claim(execute, { ...claimKey, clientId: client.id, businessName: client.name, summary, monthlyPence: monthly, reason: reasonKey }))) {
    return "already_sent";
  }
  if (!emailsAtOnce(deps)) return "recorded";

  const rows: Array<[string, string]> = [
    ["Business", client.name],
    ["Had", bought.join(", ") || "Not known"],
    ...(sites ? [["Sites", String(sites)] as [string, string]] : []),
    ["Monthly amount lost", `${formatMoney(monthly)} + VAT`],
    [ended ? "Access ended" : "Access ends", accessEnds ?? "Not known"],
    ["Reason", reason],
    ...(comment ? [["Their comment", comment] as [string, string]] : []),
    ["Paying since", formatUkDate(subscription.start_date ?? null) ?? "Not known"],
    ["Signed up", formatUkDate(client.created_at) ?? "Not known"],
  ];
  const appUrl = appUrlOf(deps);
  const stripeUrl = stripeSubscriptionUrl(subscriptionId, subscription.livemode ?? payload.livemode);
  const html = renderEmailLayout({
    subtitle: "Cancellation",
    bodyHtml: `
      <h2 style="margin:0 0 12px;font-size:22px;color:#0f172a;">${escapeHtml(client.name)} has cancelled</h2>
      <p style="margin:0 0 16px;">${ended
        ? "This business's ComplyTrack subscription has ended."
        : "This business has cancelled ComplyTrack. They keep access until the date below, so there is still time to talk to them."}</p>
      ${detailsTable(rows)}
      <p style="margin:0 0 24px;">${emailButton(escapeHtml(stripeUrl), "Open in Stripe")}</p>
      <p style="margin:0;font-size:14px;color:#64748b;">The business is listed under Clients in <a href="${escapeHtml(appUrl)}/clients" style="color:#2563eb;">ComplyTrack</a>.</p>`,
  });
  await sendClaimed(deps, claimKey, {
    to: adminEmail,
    subject: `ComplyTrack cancellation: ${client.name}`,
    html,
    text: `${client.name} has cancelled ComplyTrack\n\n${rows.map(([label, value]) => `${label}: ${value}`).join("\n")}\n\nStripe: ${stripeUrl}\nComplyTrack: ${appUrl}/clients`,
  });
  logger.info({ clientId: client.id, subscriptionId }, "Cancellation alert sent to ALPS");
  return "sent";
}

/**
 * A cancellation undone in the portal ("Renew") before access ended: drop it
 * from the week's figures, so a later cancellation is announced again.
 */
export async function withdrawCancellation(payload: AlertSubscription, deps: BillingAlertDependencies = {}): Promise<boolean> {
  if (typeof payload.id !== "string" || isCancelling(payload)) return false;
  const result = await executor(deps)(sql`
    DELETE FROM billing_alerts WHERE kind = 'cancellation' AND alert_key = ${payload.id} RETURNING id
  `);
  const withdrawn = (result.rows ?? []).length > 0;
  if (withdrawn) logger.info({ subscriptionId: payload.id }, "Cancellation withdrawn — removed from the ALPS billing digest");
  return withdrawn;
}

// ---- Plan changes ---------------------------------------------------------

/**
 * customer.subscription.updated with changed items: modules, AI, storage or
 * sites added or removed. Recorded for the Monday digest (one row per Stripe
 * event), and emailed at once only when EMAIL_BILLING_CHANGES_AT_ONCE is set.
 */
export async function recordPlanChange(
  event: { id?: string; data?: { object?: AlertSubscription; previous_attributes?: Record<string, any> } },
  deps: BillingAlertDependencies = {},
): Promise<BillingAlertResult> {
  const subscription = event.data?.object;
  const previousItems = event.data?.previous_attributes?.items?.data as AlertItem[] | undefined;
  const customerId = customerIdOf(subscription?.customer);
  if (!event.id || !subscription?.id || !customerId || !Array.isArray(previousItems)) return "not_applicable";
  if (!["active", "past_due", "trialing"].includes(String(subscription.status))) return "not_applicable";

  const before = describeItems(previousItems);
  const after = describeItems(subscription.items?.data ?? []);
  const countLabels = (labels: string[]) => labels.reduce((m, l) => m.set(l, (m.get(l) ?? 0) + 1), new Map<string, number>());
  const strip = (label: string) => label.replace(/ \(\d+ GB\)$/, "");
  const beforeLabels = countLabels(before.bought.map(strip));
  const afterLabels = countLabels(after.bought.map(strip));
  const added = [...afterLabels.keys()].filter((l) => !beforeLabels.has(l) && l !== "Extra storage");
  const removed = [...beforeLabels.keys()].filter((l) => !afterLabels.has(l) && l !== "Extra storage");
  const changes: string[] = [];
  if (added.length) changes.push(`added ${added.join(", ")}`);
  if (removed.length) changes.push(`removed ${removed.join(", ")}`);
  if (before.sites !== null && after.sites !== null && before.sites !== after.sites) changes.push(`sites ${before.sites} → ${after.sites}`);
  if (before.storageGb !== after.storageGb) changes.push(`extra storage ${before.storageGb} GB → ${after.storageGb} GB`);
  if (changes.length === 0) return "not_applicable";

  const adminEmail = adminAddress(deps);
  if (!adminEmail) return "no_admin_email";
  const execute = executor(deps);
  const client = await findBusiness(execute, customerId);
  if (!client) return "unknown_business";

  const coupons = couponsOf(subscription);
  const delta = monthlyBeforeVat(subscription.items?.data ?? [], coupons) - monthlyBeforeVat(previousItems, coupons);
  const sign = delta >= 0 ? "+" : "−";
  const summary = `${changes.join("; ")} (${sign}${formatMoney(Math.abs(delta))} a month + VAT)`;
  const claimKey = { kind: "plan_change", key: event.id };
  if (!(await claim(execute, { ...claimKey, clientId: client.id, businessName: client.name, summary, monthlyPence: delta, reason: null }))) {
    return "already_sent";
  }
  if (!emailsAtOnce(deps)) return "recorded";

  const html = renderEmailLayout({
    subtitle: "Plan change",
    bodyHtml: `
      <h2 style="margin:0 0 12px;font-size:22px;color:#0f172a;">${escapeHtml(client.name)} changed their plan</h2>
      <p style="margin:0 0 24px;">${escapeHtml(summary.charAt(0).toUpperCase() + summary.slice(1))}.</p>
      <p style="margin:0;">${emailButton(escapeHtml(stripeSubscriptionUrl(subscription.id, subscription.livemode)), "Open in Stripe")}</p>`,
  });
  await sendClaimed(deps, claimKey, {
    to: adminEmail,
    subject: `ComplyTrack plan change: ${client.name}`,
    html,
    text: `${client.name} changed their plan: ${summary}`,
  });
  return "sent";
}

// ---- Monday digest ----------------------------------------------------------

/** Audit-log tables grouped into the modules customers know. Setup tables (sites, users, templates) are left out. */
const MODULE_TABLE_PREFIXES: Array<[RegExp, string]> = [
  [/^fire_/, "FireTrack"],
  [/^legionella_/, "LegionellaTrack"],
  [/^(food_safety_|kitchen_|allergen_)/, "KitchenTrack"],
  [/^(pool_|swim_)/, "AquaTrack"],
  [/^hot_tub/, "HotTubTrack"],
  [/^pat_/, "PATtrack"],
  [/^pest_/, "PestTrack"],
  [/^premises_/, "PremisesTrack"],
  [/^room_track_/, "RoomTrack"],
  [/^tree_/, "TreeTrack"],
  [/^green_/, "GreenTrack"],
  [/^bike/, "BikeTrack"],
  [/^daily_/, "DailyTrack"],
  [/^coshh_/, "COSHHTrack"],
  [/^(train_track_|staff_training_|staff_roster|staff_shift_|doc_acknowledgements)/, "TrainTrack"],
  [/^fix_track_/, "FixTrack"],
  [/^(doc_track_|client_documents|site_documents)/, "DocTrack"],
  [/^safe_/, "SafeTrack"],
  [/^incidents$/, "IncidentTrack"],
  [/^asbestos_/, "Asbestos"],
  [/^privacy_/, "Privacy"],
  [/^contractor/, "Contractors"],
  [/^compliance_/, "Compliance checks"],
  [/^task/, "Tasks"],
  [/^(track_actions|track_evidence)$/, "Actions"],
  [/^(inspection_reports|certificate_defects)$/, "Report actions"],
];

export function moduleForTable(table: string): string | null {
  for (const [pattern, label] of MODULE_TABLE_PREFIXES) if (pattern.test(table)) return label;
  return null;
}

type BarRow = { label: string; value: number; note?: string; colour: string };

/** A bar chart made of table cells, which every email client shows. */
function barChart(rows: BarRow[]): string {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return `<table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="border-collapse:collapse;margin:0 0 24px;">
    ${rows.map((row) => {
      const pct = row.value > 0 ? Math.max(4, Math.round((row.value / max) * 100)) : 0;
      return `<tr>
        <td style="width:38%;padding:5px 10px 5px 0;font-size:15px;vertical-align:middle;">${escapeHtml(row.label)}</td>
        <td style="padding:5px 0;vertical-align:middle;">${pct > 0
          ? `<table cellpadding="0" cellspacing="0" role="presentation" width="${pct}%" style="border-collapse:collapse;"><tr><td style="background:${row.colour};height:18px;border-radius:4px;line-height:18px;">&nbsp;</td></tr></table>`
          : "&nbsp;"}</td>
        <td style="width:28%;padding:5px 0 5px 10px;font-size:15px;font-weight:700;text-align:right;vertical-align:middle;white-space:nowrap;">${escapeHtml(String(row.value))}${row.note ? ` <span style="font-weight:400;color:#64748b;">${escapeHtml(row.note)}</span>` : ""}</td>
      </tr>`;
    }).join("")}
  </table>`;
}

function signedMoney(pence: number): string {
  return `${pence > 0 ? "+" : pence < 0 ? "−" : ""}${formatMoney(Math.abs(pence))}`;
}

function signedCount(n: number): string {
  return `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n)}`;
}

export interface BillingDigestResult { sent: boolean; reason?: "no_admin_email" | "already_sent" }

/**
 * Monday 08:00 (UK): the week's billing news for ALPS. One per week, claimed
 * by the week's start date, so a restart or a second instance sends nothing more.
 */
export async function runBillingDigest(deps: BillingAlertDependencies = {}): Promise<BillingDigestResult> {
  const adminEmail = adminAddress(deps);
  if (!adminEmail) {
    logger.info("ADMIN_EMAIL not configured — weekly billing digest not sent");
    return { sent: false, reason: "no_admin_email" };
  }
  const execute = executor(deps);
  const now = deps.now?.() ?? new Date();
  const from = new Date(now.getTime() - 7 * 86_400_000);
  const weekKey = now.toLocaleDateString("en-CA", { timeZone: "Europe/London" });

  const changeRows = (await execute(sql`
    SELECT kind, business_name, summary, monthly_pence, reason, created_at
    FROM billing_alerts
    WHERE kind IN ('new_subscription', 'cancellation', 'plan_change')
      AND created_at >= ${from.toISOString()}::timestamptz AND created_at < ${now.toISOString()}::timestamptz
    ORDER BY created_at
  `)).rows as Array<{ kind: string; business_name: string | null; summary: string | null; monthly_pence: number; reason: string | null }>;
  const ofKind = (kind: string) => changeRows.filter((r) => r.kind === kind);
  const added = ofKind("new_subscription");
  const cancelled = ofKind("cancellation");
  const planChanges = ofKind("plan_change");
  const sum = (rows: typeof changeRows) => rows.reduce((s, r) => s + (Number(r.monthly_pence) || 0), 0);
  const gained = sum(added);
  const lost = sum(cancelled);
  const planDelta = sum(planChanges);
  const net = gained - lost + planDelta;

  const reasonCounts = new Map<string, number>();
  for (const row of cancelled) {
    const label = CANCELLATION_REASON_LABELS[row.reason ?? "none"] ?? CANCELLATION_REASON_LABELS.none!;
    reasonCounts.set(label, (reasonCounts.get(label) ?? 0) + 1);
  }

  const trials = (await execute(sql`
    SELECT name, created_at FROM clients
    WHERE created_at >= ${from.toISOString()}::timestamptz AND created_at < ${now.toISOString()}::timestamptz
      AND trial_ends_at IS NOT NULL AND data_deleted_at IS NULL
    ORDER BY created_at
  `)).rows as Array<{ name: string; created_at: Date | string }>;

  const totals = ((await execute(sql`
    SELECT
      count(*) FILTER (WHERE subscription_status IN ('active', 'past_due'))::int AS paying,
      count(*) FILTER (WHERE COALESCE(subscription_status, 'trial') NOT IN ('active', 'past_due')
        AND trial_ends_at > now())::int AS on_trial
    FROM clients
    WHERE data_deleted_at IS NULL
  `)).rows ?? [])[0] as { paying: number; on_trial: number } | undefined;

  // Records saved or changed this week, by module, across every business.
  // Compliance checks count when worked on, not when a new business's
  // starter checks are created.
  const activity = (await execute(sql`
    SELECT table_name, client_id, count(*)::int AS changes
    FROM audit_log
    WHERE changed_at >= ${from.toISOString()}::timestamptz AND changed_at < ${now.toISOString()}::timestamptz
      AND (action = 'update' OR (action = 'create' AND table_name NOT LIKE 'compliance\\_%'))
    GROUP BY table_name, client_id
  `)).rows as Array<{ table_name: string; client_id: number; changes: number }>;
  const byModule = new Map<string, { changes: number; clients: Set<number> }>();
  for (const row of activity) {
    const module = moduleForTable(row.table_name);
    if (!module) continue;
    const entry = byModule.get(module) ?? { changes: 0, clients: new Set<number>() };
    entry.changes += Number(row.changes) || 0;
    entry.clients.add(Number(row.client_id));
    byModule.set(module, entry);
  }
  const topModules = [...byModule.entries()]
    .map(([label, v]) => [label, { changes: v.changes, businesses: v.clients.size }] as const)
    .sort((a, b) => b[1].changes - a[1].changes)
    .slice(0, 10);

  if (!(await claim(execute, { kind: "weekly_digest", key: weekKey, clientId: null, businessName: null, summary: null, monthlyPence: net, reason: null }))) {
    return { sent: false, reason: "already_sent" };
  }

  const netBusinesses = added.length - cancelled.length;
  const fromLabel = formatUkDate(from)!;
  const toLabel = formatUkDate(new Date(now.getTime() - 1))!;
  const netColour = net > 0 ? "#16a34a" : net < 0 ? "#dc2626" : "#0f172a";
  const card = (label: string, value: string, note: string, colour = "#0f172a") =>
    `<td style="width:33%;padding:12px;background:#f8fafc;border-radius:10px;vertical-align:top;">
      <div style="font-size:13px;color:#64748b;">${label}</div>
      <div style="font-size:24px;font-weight:800;color:${colour};">${escapeHtml(value)}</div>
      <div style="font-size:13px;color:#64748b;">${escapeHtml(note)}</div>
    </td>`;
  const list = (title: string, rows: Array<{ business_name: string | null; summary: string | null }>) => rows.length === 0 ? "" : `
      <h3 style="margin:24px 0 8px;font-size:17px;color:#0f172a;">${title}</h3>
      <ul style="margin:0;padding-left:20px;">${rows.map((r) => `<li style="margin:0 0 6px;"><strong>${escapeHtml(r.business_name ?? "A deleted business")}</strong>: ${escapeHtml(r.summary ?? "")}</li>`).join("")}</ul>`;

  const html = renderEmailLayout({
    subtitle: "Weekly billing digest",
    bodyHtml: `
      <h2 style="margin:0 0 4px;font-size:22px;color:#0f172a;">Your week in ComplyTrack</h2>
      <p style="margin:0 0 20px;color:#64748b;">${escapeHtml(fromLabel)} to ${escapeHtml(toLabel)}</p>
      <table width="100%" cellpadding="0" cellspacing="8" role="presentation" style="margin:0 0 16px;"><tr>
        ${card("New", `+${added.length}`, `+${formatMoney(gained)} a month`, "#16a34a")}
        ${card("Cancelled", `−${cancelled.length}`, `−${formatMoney(lost)} a month`, cancelled.length ? "#dc2626" : "#0f172a")}
        ${card("Net", signedCount(netBusinesses), `${signedMoney(net)} a month`, netColour)}
      </tr></table>
      <p style="margin:0 0 20px;font-size:14px;color:#64748b;">Amounts are monthly, before VAT. Net includes modules, AI, storage and sites added or removed (${signedMoney(planDelta)} a month).</p>
      <h3 style="margin:0 0 8px;font-size:17px;color:#0f172a;">New and cancelled</h3>
      ${barChart([
        { label: "New subscriptions", value: added.length, colour: "#16a34a" },
        { label: "Cancellations", value: cancelled.length, colour: "#dc2626" },
        { label: "New free trials", value: trials.length, colour: "#2563eb" },
      ])}
      <h3 style="margin:0 0 8px;font-size:17px;color:#0f172a;">Why businesses cancelled</h3>
      ${reasonCounts.size === 0
        ? `<p style="margin:0 0 24px;">No cancellations this week.</p>`
        : barChart([...reasonCounts.entries()].sort((a, b) => b[1] - a[1]).map(([label, value]) => ({ label, value, colour: "#f59e0b" })))}
      <h3 style="margin:0 0 8px;font-size:17px;color:#0f172a;">Most used modules</h3>
      <p style="margin:0 0 8px;font-size:14px;color:#64748b;">Records saved or updated this week, across all businesses.</p>
      ${topModules.length === 0
        ? `<p style="margin:0 0 24px;">No records were saved this week.</p>`
        : barChart(topModules.map(([label, v]) => ({ label, value: v.changes, note: `in ${v.businesses} business${v.businesses === 1 ? "" : "es"}`, colour: "#2563eb" })))}
      ${list("New subscriptions", added)}
      ${list("Cancellations", cancelled)}
      ${list("Plan changes", planChanges)}
      ${trials.length ? `
      <h3 style="margin:24px 0 8px;font-size:17px;color:#0f172a;">New free trials</h3>
      <ul style="margin:0;padding-left:20px;">${trials.map((t) => `<li style="margin:0 0 6px;"><strong>${escapeHtml(t.name)}</strong>, signed up ${escapeHtml(formatUkDate(t.created_at) ?? "")}</li>`).join("")}</ul>` : ""}
      <h3 style="margin:24px 0 8px;font-size:17px;color:#0f172a;">Now</h3>
      <p style="margin:0 0 24px;"><strong>${totals?.paying ?? 0}</strong> paying business${totals?.paying === 1 ? "" : "es"} and <strong>${totals?.on_trial ?? 0}</strong> on a free trial.</p>
      <p style="margin:0;">${emailButton(`${escapeHtml(appUrlOf(deps))}/clients`, "Open Clients")}</p>`,
  });

  const textList = (title: string, rows: Array<{ business_name: string | null; summary: string | null }>) =>
    rows.length ? `\n${title}\n${rows.map((r) => `- ${r.business_name ?? "A deleted business"}: ${r.summary ?? ""}`).join("\n")}\n` : "";
  const text = [
    `ComplyTrack weekly billing digest, ${fromLabel} to ${toLabel}`,
    "",
    `New: +${added.length} (+${formatMoney(gained)} a month)`,
    `Cancelled: −${cancelled.length} (−${formatMoney(lost)} a month)`,
    `Plan changes: ${signedMoney(planDelta)} a month`,
    `Net: ${signedCount(netBusinesses)} business${Math.abs(netBusinesses) === 1 ? "" : "es"}, ${signedMoney(net)} a month (before VAT)`,
    `New free trials: ${trials.length}`,
    "",
    "Why businesses cancelled:",
    ...(reasonCounts.size ? [...reasonCounts.entries()].map(([label, n]) => `- ${label}: ${n}`) : ["- No cancellations this week"]),
    "",
    "Most used modules (records saved or updated):",
    ...(topModules.length ? topModules.map(([label, v]) => `- ${label}: ${v.changes} (in ${v.businesses} business${v.businesses === 1 ? "" : "es"})`) : ["- None"]),
    textList("New subscriptions", added) + textList("Cancellations", cancelled) + textList("Plan changes", planChanges),
    `Now: ${totals?.paying ?? 0} paying, ${totals?.on_trial ?? 0} on a free trial.`,
  ].join("\n");

  try {
    await (deps.sendEmail ?? sendSystemEmail)({
      to: adminEmail,
      subject: `ComplyTrack week: ${signedCount(netBusinesses)} business${Math.abs(netBusinesses) === 1 ? "" : "es"}, ${signedMoney(net)} a month`,
      html,
      text,
      idempotencyKey: `billing-alert:weekly_digest:${weekKey}`,
    });
  } catch (err) {
    await release(execute, "weekly_digest", weekKey);
    throw err;
  }
  return { sent: true };
}
