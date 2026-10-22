import { db } from "@workspace/db";
import { aiUsageTable, clientsTable, type AiUsageFeature } from "@workspace/db/schema";
import { eq, sql } from "drizzle-orm";
import { findLiveSubscription } from "./billing";
import { isAiSubscriptionItem } from "./aiAddonItem";
import { logger } from "./logger";
import { aiCostUsdMicros, type AiCallUsage } from "./aiPricing";

export { aiCostUsdMicros, usageFromMessage, type AiCallUsage } from "./aiPricing";

/**
 * The AI features add-on (Steuart, 2026-10-22: "additional charge of £25 for
 * AI enabled. Users get £15 of value"). A business pays £25 a month for the
 * add-on and may spend up to AI_MONTHLY_ALLOWANCE_PENCE (default £15) of
 * Anthropic charges in each paid period; at that point the AI buttons stop
 * until the period renews. Every request to Claude goes through
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

/** AI use a business may have in each paid period, in pence (default £15). */
export function aiMonthlyAllowancePence(): number {
  return envPence("AI_MONTHLY_ALLOWANCE_PENCE", 1500);
}

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
  const usedPence = usdMicrosToPence(await spentUsdMicros(db, clientId, plan.periodStart));
  const percentUsed = plan.allowancePence > 0 ? Math.min(100, Math.round((usedPence / plan.allowancePence) * 100)) : 100;
  return {
    configured,
    active: true,
    plan: plan.kind,
    percentUsed,
    resetsAt: plan.kind === "addon" ? plan.periodEnd?.toISOString() ?? null : null,
    usedUp: usedPence >= plan.allowancePence,
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

/**
 * Reserve one AI request before it is sent: checks the add-on and the
 * allowance and writes a pending row at the estimated cost, under a
 * per-business lock so requests running together cannot overspend. A request
 * may start while any allowance is left, so one request can take a business
 * slightly past it. Returns the row to settle afterwards.
 */
export async function claimAiUse(input: {
  clientId: number;
  userId: number | null;
  feature: AiUsageFeature;
  /** Typical cost of this kind of request, held until the real cost is known. */
  estimatePence: number;
  /** What the person should do instead, e.g. "Type the actions in instead." */
  instead: string;
}): Promise<number> {
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
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${AI_LOCK_NS}, ${input.clientId})`);
    const usedPence = usdMicrosToPence(await spentUsdMicros(tx, input.clientId, plan.periodStart));
    if (usedPence >= plan.allowancePence) {
      throw new AiUnavailableError(
        "AI_ALLOWANCE_USED",
        plan.kind === "trial"
          ? `The AI allowance for your free trial is used up. It comes with the AI features add-on once you subscribe. ${input.instead}`
          : `This business has used its AI allowance for this month. It starts again ${formatResetDate(plan.periodEnd)}. ${input.instead}`,
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
