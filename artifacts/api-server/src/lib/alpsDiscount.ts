import type Stripe from "stripe";
import { randomUUID } from "crypto";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

export const ALPS_DISCOUNT_CODE = "ALPS50";

const ALPS_COUPON_ID = "complytrack_alps50_forever";
const RESERVATION_TIMEOUT_MINUTES = 60;

export interface AlpsDiscountReservation {
  code: string;
  token: string;
  expiresAt: Date;
}

export function normaliseAlpsDiscountCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const code = value.trim().toUpperCase();
  return code || null;
}

export async function reserveAlpsDiscount(
  clientId: number,
  code: string,
  stripe: Stripe,
): Promise<AlpsDiscountReservation | null> {
  const existingResult = await db.execute(sql`
    SELECT status, reservation_token, checkout_session_id, expires_at
    FROM billing_discount_redemptions
    WHERE client_id = ${clientId}
      AND code = ${code}
    LIMIT 1
  `);
  const existing = (existingResult.rows ?? [])[0] as
    | {
        status: string;
        reservation_token: string | null;
        checkout_session_id: string | null;
        expires_at: Date | null;
      }
    | undefined;

  if (existing) {
    if (
      existing.status !== "reserved" ||
      !existing.expires_at ||
      existing.expires_at.getTime() > Date.now() ||
      !existing.checkout_session_id ||
      !existing.reservation_token
    ) {
      return null;
    }

    // Never release a timed-out reservation from our own clock alone. Stripe
    // may have completed Checkout just before expiry while its webhook was
    // delayed, in which case the code must still be treated as redeemed.
    const session = await stripe.checkout.sessions.retrieve(existing.checkout_session_id);
    if (session.status === "complete") {
      await db.execute(sql`
        UPDATE billing_discount_redemptions
        SET status = 'redeemed',
            redeemed_at = COALESCE(redeemed_at, now())
        WHERE client_id = ${clientId}
          AND code = ${code}
          AND reservation_token = ${existing.reservation_token}
          AND status = 'reserved'
      `);
      return null;
    }

    if (session.status !== "expired") return null;

    await db.execute(sql`
      DELETE FROM billing_discount_redemptions
      WHERE client_id = ${clientId}
        AND code = ${code}
        AND reservation_token = ${existing.reservation_token}
        AND status = 'reserved'
    `);
  }

  const token = randomUUID();
  const expiresAt = new Date(Date.now() + RESERVATION_TIMEOUT_MINUTES * 60 * 1000);
  const result = await db.execute(sql`
    INSERT INTO billing_discount_redemptions
      (client_id, code, status, reservation_token, expires_at)
    VALUES
      (${clientId}, ${code}, 'reserved', ${token}, ${expiresAt})
    ON CONFLICT (client_id, code) DO NOTHING
    RETURNING id
  `);
  return (result.rows ?? []).length > 0 ? { code, token, expiresAt } : null;
}

export async function attachDiscountCheckoutSession(
  clientId: number,
  reservation: AlpsDiscountReservation,
  checkoutSessionId: string,
): Promise<void> {
  await db.execute(sql`
    UPDATE billing_discount_redemptions
    SET checkout_session_id = ${checkoutSessionId}
    WHERE client_id = ${clientId}
      AND code = ${reservation.code}
      AND reservation_token = ${reservation.token}
      AND status = 'reserved'
  `);
}

export async function releaseAlpsDiscountReservation(
  clientId: number,
  reservation: AlpsDiscountReservation,
): Promise<void> {
  await db.execute(sql`
    DELETE FROM billing_discount_redemptions
    WHERE client_id = ${clientId}
      AND code = ${reservation.code}
      AND reservation_token = ${reservation.token}
      AND status = 'reserved'
  `);
}

export async function recordAlpsDiscountCheckoutEvent(event: {
  type?: string;
  data?: { object?: Record<string, unknown> };
}): Promise<void> {
  if (event.type !== "checkout.session.completed" && event.type !== "checkout.session.expired") return;

  const checkout = event.data?.object ?? {};
  const metadata = (checkout.metadata ?? {}) as Record<string, unknown>;
  const code = normaliseAlpsDiscountCode(metadata.discountCode);
  const clientId = Number(metadata.clientId);
  const reservationToken = typeof metadata.discountReservationToken === "string"
    ? metadata.discountReservationToken
    : null;
  const checkoutSessionId = typeof checkout.id === "string" ? checkout.id : null;

  if (
    code !== ALPS_DISCOUNT_CODE ||
    !Number.isInteger(clientId) ||
    !reservationToken ||
    !checkoutSessionId
  ) return;

  if (event.type === "checkout.session.expired") {
    await db.execute(sql`
      DELETE FROM billing_discount_redemptions
      WHERE client_id = ${clientId}
        AND code = ${code}
        AND reservation_token = ${reservationToken}
        AND status = 'reserved'
        AND (checkout_session_id = ${checkoutSessionId} OR checkout_session_id IS NULL)
    `);
    return;
  }

  await db.execute(sql`
    UPDATE billing_discount_redemptions
    SET status = 'redeemed',
        redeemed_at = now()
    WHERE client_id = ${clientId}
      AND code = ${code}
      AND reservation_token = ${reservationToken}
      AND status = 'reserved'
      AND (checkout_session_id = ${checkoutSessionId} OR checkout_session_id IS NULL)
  `);
}

export async function getAlpsDiscountCouponId(stripe: Stripe): Promise<string> {
  try {
    const coupon = await stripe.coupons.retrieve(ALPS_COUPON_ID);
    if (!("deleted" in coupon)) {
      if (coupon.percent_off !== 50 || coupon.duration !== "forever") {
        throw new Error("The ALPS discount coupon is not configured for 50% off forever.");
      }
      return coupon.id;
    }
  } catch (error: any) {
    if (error?.code !== "resource_missing") throw error;
  }

  const coupon = await stripe.coupons.create(
    {
      id: ALPS_COUPON_ID,
      percent_off: 50,
      duration: "forever",
      name: "ALPS client 50% discount",
      metadata: { complytrack_discount_code: ALPS_DISCOUNT_CODE },
    },
    { idempotencyKey: `create-${ALPS_COUPON_ID}` },
  );
  return coupon.id;
}