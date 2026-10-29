import { db } from "@workspace/db";
import { appSettingsTable, clientsTable } from "@workspace/db/schema";
import { and, eq } from "drizzle-orm";
import { logger } from "./logger";
import { escapeHtml, getPublicAppUrl, sendSystemEmail } from "./email";

// The ALPS setup service ("Would you like ALPS to set you up?"): a one-off
// £500 + VAT that Steuart chose to take with the business's first payment
// (29 Oct 2026). The subscription checkout adds it as a one-time line, so it
// is on the first invoice only; the Stripe webhook records it as paid, which
// stops a later checkout charging it again. A business that already pays
// monthly asks from the setup page and ALPS invoices it separately.

export const SETUP_SERVICE_FEE = "£500 + VAT";
export const SETUP_SERVICE_FEE_PENCE = 50_000;
/** app_settings key: when the business asked (setup page or checkout tick box). */
export const SETUP_ASSIST_SETTING = "setup_assist_requested";
/** app_settings key: when the setup fee was paid with a checkout. */
export const SETUP_SERVICE_PAID_SETTING = "setup_service_paid";
/** Checkout session metadata flag for a session that carries the setup fee. */
export const SETUP_SERVICE_METADATA_KEY = "setupService";

/**
 * The one-time checkout line for the setup fee. VAT is added on top by
 * Stripe Tax, like every other ComplyTrack price.
 */
export function setupServiceLineItem() {
  return {
    price_data: {
      currency: "gbp",
      unit_amount: SETUP_SERVICE_FEE_PENCE,
      tax_behavior: "exclusive" as const,
      product_data: {
        name: "ComplyTrack setup by ALPS (one-off)",
        description: "ALPS enters your sites, team, contractors and lists for you.",
        metadata: { complytrack_setup_service: "1" },
      },
    },
    quantity: 1,
  };
}

export type SetupServiceState = { fee: string; requestedAt: string | null; paidAt: string | null };

async function setting(clientId: number, key: string): Promise<string | null> {
  const [row] = await db.select({ value: appSettingsTable.value }).from(appSettingsTable)
    .where(and(eq(appSettingsTable.clientId, clientId), eq(appSettingsTable.key, key)));
  return row?.value ?? null;
}

function timestampFrom(raw: string | null, field: string): string | null {
  if (!raw) return null;
  try {
    const value = (JSON.parse(raw) as Record<string, unknown>)[field];
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

export async function getSetupServiceState(clientId: number): Promise<SetupServiceState> {
  return {
    fee: SETUP_SERVICE_FEE,
    requestedAt: timestampFrom(await setting(clientId, SETUP_ASSIST_SETTING), "requestedAt"),
    paidAt: timestampFrom(await setting(clientId, SETUP_SERVICE_PAID_SETTING), "paidAt"),
  };
}

/**
 * Stripe webhook: a completed, paid checkout that carried the setup fee marks
 * it paid (once) and tells ALPS. Throws only when the paid mark can't be
 * saved, so Stripe retries; the email is best-effort.
 */
export async function recordSetupServiceCheckoutEvent(event: {
  type?: string;
  data?: { object?: Record<string, unknown> };
}): Promise<void> {
  if (event.type !== "checkout.session.completed") return;
  const checkout = event.data?.object ?? {};
  const metadata = (checkout.metadata ?? {}) as Record<string, unknown>;
  if (metadata[SETUP_SERVICE_METADATA_KEY] !== "1") return;
  const clientId = Number(metadata.clientId);
  if (!Number.isInteger(clientId) || clientId <= 0) return;
  if (checkout.payment_status !== "paid") return;

  const paidAt = new Date().toISOString();
  const sessionId = typeof checkout.id === "string" ? checkout.id : null;
  const inserted = await db.insert(appSettingsTable)
    .values({ clientId, key: SETUP_SERVICE_PAID_SETTING, value: JSON.stringify({ paidAt, checkoutSessionId: sessionId }), updatedAt: new Date() })
    .onConflictDoNothing({ target: [appSettingsTable.clientId, appSettingsTable.key] })
    .returning({ id: appSettingsTable.id });
  // Ticking the box at checkout is a request too.
  await db.insert(appSettingsTable)
    .values({ clientId, key: SETUP_ASSIST_SETTING, value: JSON.stringify({ requestedAt: paidAt, requestedBy: "Ticked at checkout" }), updatedAt: new Date() })
    .onConflictDoNothing({ target: [appSettingsTable.clientId, appSettingsTable.key] });
  if (!inserted.length) return;

  const adminEmail = process.env.ADMIN_EMAIL?.trim();
  if (!adminEmail) {
    logger.warn({ clientId }, "ADMIN_EMAIL not configured: setup service payment not emailed");
    return;
  }
  try {
    const [client] = await db.select({ name: clientsTable.name }).from(clientsTable).where(eq(clientsTable.id, clientId));
    const businessName = client?.name ?? `Business ${clientId}`;
    const appUrl = getPublicAppUrl().replace(/\/+$/, "");
    await sendSystemEmail({
      to: adminEmail,
      subject: `Setup service paid: ${businessName}`,
      html: `
        <h2>Setup service paid</h2>
        <p><strong>${escapeHtml(businessName)}</strong> has paid the one-off ${SETUP_SERVICE_FEE} setup fee with its first payment, so ALPS can now set it up.</p>
        <p>The business is listed under Clients in <a href="${escapeHtml(appUrl)}">ComplyTrack</a>; the payment is in Stripe.</p>
      `,
      text: `Setup service paid\n\n${businessName} has paid the one-off ${SETUP_SERVICE_FEE} setup fee with its first payment, so ALPS can now set it up.\n\nThe business is listed under Clients in ComplyTrack: ${appUrl}`,
      idempotencyKey: `setup-service-paid-${clientId}`,
    });
  } catch (err) {
    logger.error({ err, clientId }, "Setup service payment email failed");
  }
}
