import { db } from "@workspace/db";
import { aiTopUpsTable, aiUsageTable, appSettingsTable, clientsTable, type AiUsageFeature } from "@workspace/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { collectAddonFirstMonthInvoice, findLiveSubscription, type AddonPaymentResult } from "./billing";
import { AI_ADDON_CURRENCY, AI_ADDON_LABEL, isAiSubscriptionItem } from "./aiAddonItem";
import { getUncachableStripeClient } from "./stripeClient";
import { emailButton, escapeHtml, getPublicAppUrl, sendSystemEmail } from "./email";
import { logger } from "./logger";
import { aiCostUsdMicros, type AiCallUsage } from "./aiPricing";

export { aiCostUsdMicros, usageFromMessage, type AiCallUsage } from "./aiPricing";

/**
 * The AI features add-on (Steuart, 2026-10-27: "£15, with £10 allocated to
 * Claude, and £5 to me ... With top up charges as and when required", per
 * business). A business pays £15 a month for the add-on and may spend up to
 * AI_MONTHLY_ALLOWANCE_PENCE (default £10) of Anthropic charges in each paid
 * period, plus any top-ups bought in that period (default £6 for £4 more, the
 * same split). An owner buys a top-up in Settings, or switches on automatic
 * top-ups (at most AI_AUTO_TOP_UP_LIMIT a period); otherwise the AI buttons
 * stop until the period renews. Every request to Claude goes through
 * claimAiUse → settleAiUse, which keeps a priced ledger in ai_usage.
 *
 * Without ANTHROPIC_API_KEY nothing is offered at all. Without the add-on on
 * the business's live subscription, AI is unavailable (trials included,
 * unless AI_TRIAL_ALLOWANCE_PENCE gives them a small amount to try).
 */

function envPence(name: string, fallback: number): number {
  const raw = Number(process.env[name] ?? fallback);
  return Number.isInteger(raw) && raw >= 0 ? raw : fallback;
}

/** AI use a business may have in each paid period, in pence (default £10). */
export function aiMonthlyAllowancePence(): number {
  return envPence("AI_MONTHLY_ALLOWANCE_PENCE", 1000);
}

/** What a top-up costs, in pence before VAT (default £6). */
export function aiTopUpPricePence(): number {
  const pence = envPence("AI_TOP_UP_PRICE_PENCE", 600);
  return pence > 0 ? pence : 600;
}

/** AI use a top-up adds until the add-on renews, in pence (default £4). */
export function aiTopUpAllowancePence(): number {
  return envPence("AI_TOP_UP_ALLOWANCE_PENCE", 400);
}

/** Most automatic top-ups in one period (default 3, so at most £18 a month unasked). */
export function aiAutoTopUpLimit(): number {
  return envPence("AI_AUTO_TOP_UP_LIMIT", 3);
}

/** App setting an owner switches on for automatic top-ups. */
export const AI_AUTO_TOP_UP_SETTING = "aiAutoTopUp";

/** AI use a business on a free trial may have over the whole trial (default none). */
export function aiTrialAllowancePence(): number {
  return envPence("AI_TRIAL_ALLOWANCE_PENCE", 0);
}

/** Pounds per US dollar used to turn Anthropic's charges into the allowance (default 0.80). */
export function aiUsdToGbp(): number {
  const raw = Number(process.env.AI_USD_TO_GBP ?? "0.8");
  return Number.isFinite(raw) && raw > 0 && raw < 5 ? raw : 0.8;
}

export function usdMicrosToPence(micros: number): number {
  return (micros * aiUsdToGbp()) / 10_000;
}

function penceToUsdMicros(pence: number): number {
  return Math.ceil((pence * 10_000) / aiUsdToGbp());
}

export function aiConfigured(): boolean {
  return !!process.env.ANTHROPIC_API_KEY?.trim();
}

export type AiPlan =
  | { kind: "addon"; periodStart: Date; periodEnd: Date | null; allowancePence: number }
  | { kind: "trial"; periodStart: Date; periodEnd: Date | null; allowancePence: number }
  | { kind: "none" };

const PLAN_TTL_MS = 5 * 60_000;
const planCache = new Map<number, { plan: AiPlan; expiresAt: number }>();

export function invalidateAiPlan(clientId: number): void {
  planCache.delete(clientId);
}

const fromStripeTime = (value: unknown) => typeof value === "number" && value > 0 ? new Date(value * 1000) : null;

/**
 * Whether the business has paid for AI, and the period its allowance covers:
 * the add-on item's current billing period, so £25 paid always buys one
 * period's allowance. Stripe lookups are cached for five minutes; a failed
 * lookup falls back to the last answer, or to no AI (it costs money).
 */
export async function getAiPlan(clientId: number): Promise<AiPlan> {
  const cached = planCache.get(clientId);
  if (cached && cached.expiresAt > Date.now()) return cached.plan;

  const [client] = await db.select({
    trialEndsAt: clientsTable.trialEndsAt,
    stripeCustomerId: clientsTable.stripeCustomerId,
    createdAt: clientsTable.createdAt,
  }).from(clientsTable).where(eq(clientsTable.id, clientId)).limit(1);
  if (!client) return { kind: "none" };

  let plan: AiPlan = { kind: "none" };
  if (client.stripeCustomerId) {
    try {
      const subscription = await findLiveSubscription(client.stripeCustomerId);
      const item = subscription?.items.data.find(isAiSubscriptionItem) as
        | { current_period_start?: number; current_period_end?: number } | undefined;
      if (subscription && item) {
        const raw = subscription as unknown as { current_period_start?: number; current_period_end?: number };
        const periodStart = fromStripeTime(item.current_period_start) ?? fromStripeTime(raw.current_period_start);
        const periodEnd = fromStripeTime(item.current_period_end) ?? fromStripeTime(raw.current_period_end);
        plan = {
          kind: "addon",
          // Without a period from Stripe, count from the start of this calendar month.
          periodStart: periodStart ?? new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)),
          periodEnd,
          allowancePence: aiMonthlyAllowancePence(),
        };
      }
    } catch (err) {
      logger.warn({ err, clientId }, "AI add-on lookup failed; using the last known answer");
      return cached?.plan ?? { kind: "none" };
    }
  }
  const trialRunning = !client.trialEndsAt || client.trialEndsAt.getTime() > Date.now();
  if (plan.kind === "none" && trialRunning && aiTrialAllowancePence() > 0) {
    plan = { kind: "trial", periodStart: client.createdAt, periodEnd: client.trialEndsAt, allowancePence: aiTrialAllowancePence() };
  }
  planCache.set(clientId, { plan, expiresAt: Date.now() + PLAN_TTL_MS });
  return plan;
}

/** AI use added by top-ups paid for since `since` (the add-on's period start). */
async function topUpAllowancePence(executor: Pick<typeof db, "execute">, clientId: number, since: Date): Promise<number> {
  const result = await executor.execute(sql`
    SELECT coalesce(sum(allowance_pence), 0) AS pence FROM ai_top_ups
     WHERE client_id = ${clientId} AND status IN ('paid', 'unknown') AND created_at >= ${since.toISOString()}
  `);
  return Number((result.rows[0] as { pence?: unknown } | undefined)?.pence ?? 0);
}

/** The period's allowance: the plan's, plus top-ups for an add-on. */
async function periodAllowancePence(executor: Pick<typeof db, "execute">, clientId: number, plan: Exclude<AiPlan, { kind: "none" }>): Promise<number> {
  return plan.allowancePence + (plan.kind === "addon" ? await topUpAllowancePence(executor, clientId, plan.periodStart) : 0);
}

async function spentUsdMicros(executor: Pick<typeof db, "execute">, clientId: number, since: Date): Promise<number> {
  const result = await executor.execute(sql`
    SELECT coalesce(sum(cost_usd_micros), 0) AS spent FROM ai_usage
     WHERE client_id = ${clientId} AND created_at >= ${since.toISOString()}
  `);
  return Number((result.rows[0] as { spent?: unknown } | undefined)?.spent ?? 0);
}

export interface AiStatus {
  /** ANTHROPIC_API_KEY is set, so AI can be offered at all. */
  configured: boolean;
  /** The business has the add-on (or a trial allowance) right now. */
  active: boolean;
  plan: "addon" | "trial" | "none";
  /** Share of this period's allowance used, 0-100. */
  percentUsed: number;
  /** When the allowance starts again (the add-on's renewal), if known. */
  resetsAt: string | null;
  /** True when the allowance is used up for this period. */
  usedUp: boolean;
}

/** What the screens show about AI for a business. */
export async function getAiStatus(clientId: number): Promise<AiStatus> {
  const configured = aiConfigured();
  const plan = await getAiPlan(clientId);
  if (plan.kind === "none") {
    return { configured, active: false, plan: "none", percentUsed: 0, resetsAt: null, usedUp: false };
  }
  const [usedPence, allowancePence] = await Promise.all([
    spentUsdMicros(db, clientId, plan.periodStart).then(usdMicrosToPence),
    periodAllowancePence(db, clientId, plan),
  ]);
  const percentUsed = allowancePence > 0 ? Math.min(100, Math.round((usedPence / allowancePence) * 100)) : 100;
  return {
    configured,
    active: true,
    plan: plan.kind,
    percentUsed,
    resetsAt: plan.kind === "addon" ? plan.periodEnd?.toISOString() ?? null : null,
    usedUp: usedPence >= allowancePence,
  };
}

/** Why AI cannot be used now. The message is shown to the person as it is. */
export class AiUnavailableError extends Error {
  constructor(
    readonly code: "AI_NOT_CONFIGURED" | "AI_ADDON_REQUIRED" | "AI_ALLOWANCE_USED",
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const AI_LOCK_NS = 0x41495553; // "AIUS"

function formatResetDate(date: Date | null): string {
  if (!date) return "when the add-on renews";
  return `on ${date.toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: "Europe/London" })}`;
}

interface AiClaim {
  clientId: number;
  userId: number | null;
  feature: AiUsageFeature;
  /** Typical cost of this kind of request, held until the real cost is known. */
  estimatePence: number;
  /** What the person should do instead, e.g. "Type the actions in instead." */
  instead: string;
}

/**
 * Reserve one AI request before it is sent: checks the add-on and the
 * allowance and writes a pending row at the estimated cost, under a
 * per-business lock, so requests running together cannot overspend. A request
 * may start while any allowance is left, so one request can take a business
 * slightly past it. When the allowance has run out and the owner has switched
 * on automatic top-ups, one is bought and the request tried again. Returns the
 * row to settle afterwards.
 */
export async function claimAiUse(input: AiClaim): Promise<number> {
  if (!aiConfigured()) {
    throw new AiUnavailableError("AI_NOT_CONFIGURED", `ComplyTrack's AI is not switched on yet. ${input.instead}`, 503);
  }
  const plan = await getAiPlan(input.clientId);
  if (plan.kind === "none") {
    throw new AiUnavailableError(
      "AI_ADDON_REQUIRED",
      `This needs the AI features add-on, which an owner can switch on in Settings, Billing. ${input.instead}`,
      402,
    );
  }
  try {
    return await claimWithinAllowance(input, plan);
  } catch (err) {
    if (!(err instanceof AiUnavailableError) || err.code !== "AI_ALLOWANCE_USED" || plan.kind !== "addon") throw err;
    if (!(await autoTopUp(input.clientId, input.userId, plan))) throw err;
    return claimWithinAllowance(input, plan);
  }
}

async function claimWithinAllowance(input: AiClaim, plan: Exclude<AiPlan, { kind: "none" }>): Promise<number> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${AI_LOCK_NS}, ${input.clientId})`);
    const usedPence = usdMicrosToPence(await spentUsdMicros(tx, input.clientId, plan.periodStart));
    if (usedPence >= await periodAllowancePence(tx, input.clientId, plan)) {
      throw new AiUnavailableError(
        "AI_ALLOWANCE_USED",
        plan.kind === "trial"
          ? `The AI allowance for your free trial is used up. It comes with the AI features add-on once you subscribe. ${input.instead}`
          : `This business has used its AI allowance for this month. It starts again ${formatResetDate(plan.periodEnd)}, or an owner can buy a top-up in Settings, Billing. ${input.instead}`,
        429,
      );
    }
    const [row] = await tx.insert(aiUsageTable).values({
      clientId: input.clientId,
      userId: input.userId,
      feature: input.feature,
      status: "pending",
      costUsdMicros: penceToUsdMicros(input.estimatePence),
    }).returning({ id: aiUsageTable.id });
    return row.id;
  });
}

/**
 * Record what a claimed request really cost. Pass null when nothing reached
 * Claude (for example the file could not be read), which frees the estimate.
 */
export async function settleAiUse(id: number, usage: AiCallUsage | null, ok: boolean): Promise<void> {
  try {
    await db.update(aiUsageTable).set({
      status: ok ? "done" : "failed",
      model: usage?.model ?? null,
      inputTokens: usage?.inputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      cacheReadTokens: usage?.cacheReadTokens ?? 0,
      cacheWriteTokens: usage?.cacheWriteTokens ?? 0,
      webSearches: usage?.webSearches ?? 0,
      costUsdMicros: usage ? aiCostUsdMicros(usage) : 0,
      settledAt: new Date(),
    }).where(eq(aiUsageTable.id, id));
  } catch (err) {
    // The pending row keeps counting at its estimate, so the allowance stays safe.
    logger.error({ err, aiUsageId: id }, "Could not record the cost of an AI request");
  }
}

// ── Top-ups ─────────────────────────────────────────────────────────────────

export async function isAiAutoTopUpOn(clientId: number): Promise<boolean> {
  const [row] = await db.select({ value: appSettingsTable.value }).from(appSettingsTable)
    .where(and(eq(appSettingsTable.clientId, clientId), eq(appSettingsTable.key, AI_AUTO_TOP_UP_SETTING))).limit(1);
  return row?.value === "true";
}

export async function setAiAutoTopUp(clientId: number, enabled: boolean): Promise<void> {
  await db.insert(appSettingsTable)
    .values({ clientId, key: AI_AUTO_TOP_UP_SETTING, value: String(enabled) })
    .onConflictDoUpdate({ target: [appSettingsTable.clientId, appSettingsTable.key], set: { value: String(enabled) } });
}

/** Top-ups paid for (or awaiting confirmation) in the add-on's current period. */
export async function countAiTopUps(clientId: number, since: Date): Promise<number> {
  const result = await db.execute(sql`
    SELECT count(*)::int AS n FROM ai_top_ups
     WHERE client_id = ${clientId} AND status IN ('paid', 'unknown') AND created_at >= ${since.toISOString()}
  `);
  return Number((result.rows[0] as { n?: unknown } | undefined)?.n ?? 0);
}

export type AiTopUpResult = "paid" | "unknown" | "failed" | "pending" | "no_addon";

const formatPounds = (pence: number) => `£${(pence / 100).toFixed(2)}`;

/**
 * Buy one top-up: charged at once as a one-off invoice, it adds
 * aiTopUpAllowancePence of AI use until the add-on renews. A repeated
 * requestId never charges again; it returns the first attempt's outcome
 * ("pending" while that is still being charged). "unknown" means Stripe may
 * have taken the payment, so the top-up counts until someone checks.
 */
export async function buyAiTopUp(input: {
  clientId: number;
  userId: number | null;
  requestId: string;
  automatic: boolean;
  log?: Pick<typeof logger, "error">;
}): Promise<AiTopUpResult> {
  const log = input.log ?? logger;
  const plan = await getAiPlan(input.clientId);
  if (plan.kind !== "addon") return "no_addon";
  const [client] = await db.select({ stripeCustomerId: clientsTable.stripeCustomerId })
    .from(clientsTable).where(eq(clientsTable.id, input.clientId)).limit(1);
  if (!client?.stripeCustomerId) return "no_addon";

  const amount = aiTopUpPricePence();
  const allowance = aiTopUpAllowancePence();
  const [row] = await db.insert(aiTopUpsTable).values({
    clientId: input.clientId,
    userId: input.userId,
    requestId: input.requestId,
    automatic: input.automatic,
    amountPence: amount,
    allowancePence: allowance,
    currency: AI_ADDON_CURRENCY,
    status: "pending",
  }).onConflictDoNothing().returning({ id: aiTopUpsTable.id });
  if (!row) {
    const [earlier] = await db.select({ status: aiTopUpsTable.status }).from(aiTopUpsTable)
      .where(and(eq(aiTopUpsTable.clientId, input.clientId), eq(aiTopUpsTable.requestId, input.requestId))).limit(1);
    return (earlier?.status ?? "pending") as AiTopUpResult;
  }

  let payment: AddonPaymentResult;
  try {
    const stripe = await getUncachableStripeClient();
    payment = await collectAddonFirstMonthInvoice(stripe, {
      customerId: client.stripeCustomerId,
      amount,
      currency: AI_ADDON_CURRENCY,
      description: `${AI_ADDON_LABEL} top-up: ${formatPounds(allowance)} more AI use until the add-on renews`,
      metadata: { ai_top_up: String(row.id), client_id: String(input.clientId), automatic: String(input.automatic) },
      idempotencyPrefix: `ai-top-up-${input.clientId}-${input.requestId}`,
    });
  } catch (err) {
    log.error({ err, clientId: input.clientId, topUpId: row.id }, "AI top-up charge failed");
    payment = "not_collected";
  }
  const status: AiTopUpResult = payment === "paid" ? "paid" : payment === "unknown" ? "unknown" : "failed";
  await db.update(aiTopUpsTable).set({ status, settledAt: new Date() }).where(eq(aiTopUpsTable.id, row.id));
  if (status === "unknown") {
    log.error({ clientId: input.clientId, topUpId: row.id }, "AI top-up payment outcome unknown; counted until checked in Stripe");
  }
  return status;
}

/** A declined automatic top-up is not tried again for this long. */
const AUTO_TOP_UP_RETRY_MS = 24 * 60 * 60_000;

const AI_TOP_UP_LOCK_NS = 0x41495455; // "AITU"

/**
 * Buy a top-up because the allowance ran out, when the owner has switched
 * automatic top-ups on and this period's limit is not reached. Purchases for
 * one business are taken one at a time under a lock, and a request that waited
 * for another's top-up uses it instead of buying again. Returns whether more
 * allowance is now available.
 */
async function autoTopUp(clientId: number, userId: number | null, plan: Extract<AiPlan, { kind: "addon" }>): Promise<boolean> {
  if (!(await isAiAutoTopUpOn(clientId))) return false;
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${AI_TOP_UP_LOCK_NS}, ${clientId})`);
    const usedPence = usdMicrosToPence(await spentUsdMicros(tx, clientId, plan.periodStart));
    if (usedPence < await periodAllowancePence(tx, clientId, plan)) return true;
    const result = await tx.execute(sql`
      SELECT count(*)::int AS n,
             max(created_at) FILTER (WHERE status = 'failed') AS last_failed
        FROM ai_top_ups
       WHERE client_id = ${clientId} AND automatic AND created_at >= ${plan.periodStart.toISOString()}
    `);
    const stats = result.rows[0] as { n?: unknown; last_failed?: unknown } | undefined;
    const count = Number(stats?.n ?? 0);
    const lastFailed = stats?.last_failed ? new Date(stats.last_failed as string) : null;
    if (lastFailed && Date.now() - lastFailed.getTime() < AUTO_TOP_UP_RETRY_MS) return false;
    // Declined attempts count towards the limit too, so a bad card is never charged repeatedly.
    if (count >= aiAutoTopUpLimit()) return false;
    const outcome = await buyAiTopUp({
      clientId,
      userId,
      requestId: `auto-${Math.floor(plan.periodStart.getTime() / 1000)}-${count + 1}`,
      automatic: true,
    });
    if (outcome !== "pending" && outcome !== "no_addon") {
      void emailAutoTopUp(clientId, outcome === "failed" ? "failed" : "paid").catch((err) =>
        logger.error({ err, clientId }, "AI automatic top-up email failed"));
    }
    return outcome === "paid" || outcome === "unknown";
  });
}

/** Tell the owners an automatic top-up was charged, or that it was declined. */
async function emailAutoTopUp(clientId: number, kind: "paid" | "failed"): Promise<void> {
  const [client] = await db.select({ name: clientsTable.name }).from(clientsTable).where(eq(clientsTable.id, clientId)).limit(1);
  const owners = await db.execute(sql`
    SELECT id, name, email FROM users
     WHERE client_id = ${clientId} AND active AND role IN ('consultant', 'client_admin')
       AND email IS NOT NULL AND email <> ''
     ORDER BY id LIMIT 30
  `);
  const company = client?.name ?? "Your business";
  const price = formatPounds(aiTopUpPricePence());
  const url = `${getPublicAppUrl()}/settings#ai`;
  const copy = kind === "paid"
    ? {
      subject: `${company}: we topped up your ComplyTrack AI allowance`,
      heading: "AI allowance topped up",
      lines: [
        `<strong>${escapeHtml(company)}</strong> used this month's AI allowance, so we added a top-up automatically, as set in Settings.`,
        `It cost <strong>${price}</strong> (plus VAT), charged now, and its AI use lasts until the AI features add-on renews.`,
        `There are at most ${aiAutoTopUpLimit()} automatic top-ups a month. You can switch them off in Settings, under AI features.`,
      ],
    }
    : {
      subject: `${company}: the automatic AI top-up failed`,
      heading: "We couldn't top up your AI allowance",
      lines: [
        `<strong>${escapeHtml(company)}</strong> used this month's AI allowance. Automatic top-ups are on, but the ${price} charge didn't go through, so nothing was added and you have not been charged.`,
        "AI buttons stay off until the add-on renews. Everything else works as normal.",
        "We'll try again after 24 hours. To use AI sooner, check your card and buy a top-up in Settings, under AI features.",
      ],
    };
  for (const owner of owners.rows as Array<{ id: number; name: string | null; email: string }>) {
    const name = owner.name ?? "";
    const html = `
    <h2 style="color: #1e293b; margin-top: 0;">${copy.heading}</h2>
    <p>Hi ${escapeHtml(name)},</p>
    ${copy.lines.map((line) => `<p>${line}</p>`).join("\n    ")}
    <p style="margin: 24px 0; text-align: center;">${emailButton(escapeHtml(url), "Open AI settings")}</p>
    <p>Best regards,<br><strong>ComplyTrack</strong></p>`;
    const text = [copy.heading, "", `Hi ${name},`, "", ...copy.lines.map((line) => line.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;|&#039;/g, "'").replace(/&amp;/g, "&")), "", url, "", "Best regards,", "ComplyTrack"].join("\n");
    await sendSystemEmail({ to: owner.email, subject: copy.subject, html, text });
  }
}
