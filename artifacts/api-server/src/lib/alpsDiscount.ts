import type Stripe from "stripe";
import { createHash, randomBytes, randomUUID } from "crypto";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const ALPS_COUPON_ID = "complytrack_alps50_forever";
const RESERVATION_TIMEOUT_MINUTES = 60;

// ─── Manager-issued per-client discount codes ────────────────────────────────
// Each client can be issued exactly one active code by a manager (consultant).
// Only a SHA-256 hash of the code is stored; the raw code is returned once at
// issue time so the manager can copy it and share it privately.

// Crockford-style alphabet without ambiguous characters (0/O, 1/I/L).
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";

export function generateDiscountCode(): string {
  const bytes = randomBytes(16);
  let out = "";
  for (let i = 0; i < 16; i++) {
    out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    if (i % 4 === 3 && i < 15) out += "-";
  }
  return `ALPS-${out}`;
}

export function hashDiscountCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

export type DiscountCodeLifecycle = "none" | "available" | "reserved" | "redeemed";

function toIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export interface DiscountCodeStatus {
  status: DiscountCodeLifecycle;
  hint: string | null;
  issuedAt: string | null;
  redeemedAt: string | null;
}

async function getClientRedemptionRow(clientId: number): Promise<
  | { status: string; redeemed_at: Date | string | null }
  | undefined
> {
  const result = await db.execute(sql`
    SELECT status, redeemed_at
    FROM billing_discount_redemptions
    WHERE client_id = ${clientId}
    LIMIT 1
  `);
  return (result.rows ?? [])[0] as { status: string; redeemed_at: Date | string | null } | undefined;
}

export async function getClientDiscountCodeStatus(clientId: number): Promise<DiscountCodeStatus> {
  const issuedResult = await db.execute(sql`
    SELECT code_hint, created_at
    FROM billing_discount_codes
    WHERE client_id = ${clientId}
    LIMIT 1
  `);
  const issued = (issuedResult.rows ?? [])[0] as
    | { code_hint: string; created_at: Date | string }
    | undefined;

  const redemption = await getClientRedemptionRow(clientId);
  if (redemption?.status === "redeemed") {
    return {
      status: "redeemed",
      hint: issued?.code_hint ?? null,
      issuedAt: toIso(issued?.created_at),
      redeemedAt: toIso(redemption.redeemed_at),
    };
  }
  if (redemption?.status === "reserved") {
    return {
      status: "reserved",
      hint: issued?.code_hint ?? null,
      issuedAt: toIso(issued?.created_at),
      redeemedAt: null,
    };
  }
  if (!issued) return { status: "none", hint: null, issuedAt: null, redeemedAt: null };
  return {
    status: "available",
    hint: issued.code_hint,
    issuedAt: toIso(issued.created_at),
    redeemedAt: null,
  };
}

/**
 * Issue (or replace) the client's discount code. Refuses while a Checkout
 * reservation is open or after the client has already redeemed a discount.
 * Returns the raw code exactly once.
 */
// Advisory-lock namespace for discount state transitions. Both issue/replace
// and checkout reservation take this per-client transaction lock so the two
// check-then-write flows can never interleave.
const DISCOUNT_LOCK_NS = 823901;

export async function issueClientDiscountCode(
  clientId: number,
  createdBy: number | null,
): Promise<{ code: string; hint: string } | { error: "reserved" | "redeemed" }> {
  const code = generateDiscountCode();
  const hint = code.slice(-4);
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${DISCOUNT_LOCK_NS}, ${clientId})`);
    const redemptionResult = await tx.execute(sql`
      SELECT status FROM billing_discount_redemptions
      WHERE client_id = ${clientId}
      LIMIT 1
    `);
    const redemption = (redemptionResult.rows ?? [])[0] as { status: string } | undefined;
    if (redemption?.status === "redeemed") return { error: "redeemed" as const };
    if (redemption?.status === "reserved") return { error: "reserved" as const };

    await tx.execute(sql`
      INSERT INTO billing_discount_codes (client_id, code_hash, code_hint, created_by)
      VALUES (${clientId}, ${hashDiscountCode(code)}, ${hint}, ${createdBy})
      ON CONFLICT (client_id) DO UPDATE
        SET code_hash = EXCLUDED.code_hash,
            code_hint = EXCLUDED.code_hint,
            created_by = EXCLUDED.created_by,
            created_at = now(),
            replaced_at = now()
    `);
    return { code, hint };
  });
}

/** True only when the entered code matches the client's currently issued code. */
export async function verifyClientDiscountCode(clientId: number, enteredCode: string): Promise<boolean> {
  const result = await db.execute(sql`
    SELECT 1 FROM billing_discount_codes
    WHERE client_id = ${clientId}
      AND code_hash = ${hashDiscountCode(enteredCode)}
    LIMIT 1
  `);
  return (result.rows ?? []).length > 0;
}

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

/**
 * Reserve the client's single lifetime discount for a Checkout session.
 *
 * `codeHash` is the SHA-256 hash of the code the client entered — raw codes
 * are never persisted past the checkout request. The whole state transition
 * runs inside a transaction holding the per-client discount advisory lock so
 * it cannot interleave with issue/replace: the hash is re-verified as the
 * currently active code under the lock before the reservation is written.
 */
export async function reserveAlpsDiscount(
  clientId: number,
  codeHash: string,
  stripe: Stripe,
): Promise<AlpsDiscountReservation | null> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${DISCOUNT_LOCK_NS}, ${clientId})`);

    // Re-verify under the lock: the manager may have replaced the code
    // between checkout validation and this reservation.
    const activeResult = await tx.execute(sql`
      SELECT 1 FROM billing_discount_codes
      WHERE client_id = ${clientId} AND code_hash = ${codeHash}
      LIMIT 1
    `);
    if ((activeResult.rows ?? []).length === 0) return null;

    // The lookup is client-wide (not per code): each client may ever redeem
    // ONE discount, so a redeemed or reserved row for any code blocks a new
    // reserve even after the manager replaced the code.
    const existingResult = await tx.execute(sql`
      SELECT code, status, reservation_token, checkout_session_id, expires_at
      FROM billing_discount_redemptions
      WHERE client_id = ${clientId}
      LIMIT 1
    `);
    const existing = (existingResult.rows ?? [])[0] as
      | {
          code: string;
          status: string;
          reservation_token: string | null;
          checkout_session_id: string | null;
          expires_at: Date | string | null;
        }
      | undefined;

    if (existing) {
      const expiresAtMs = existing.expires_at ? new Date(existing.expires_at).getTime() : NaN;
      if (
        existing.status !== "reserved" ||
        !existing.expires_at ||
        Number.isNaN(expiresAtMs) ||
        expiresAtMs > Date.now() ||
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
        await tx.execute(sql`
          UPDATE billing_discount_redemptions
          SET status = 'redeemed',
              redeemed_at = COALESCE(redeemed_at, now())
          WHERE client_id = ${clientId}
            AND code = ${existing.code}
            AND reservation_token = ${existing.reservation_token}
            AND status = 'reserved'
        `);
        return null;
      }

      if (session.status !== "expired") return null;

      await tx.execute(sql`
        DELETE FROM billing_discount_redemptions
        WHERE client_id = ${clientId}
          AND code = ${existing.code}
          AND reservation_token = ${existing.reservation_token}
          AND status = 'reserved'
      `);
    }

    const token = randomUUID();
    const expiresAt = new Date(Date.now() + RESERVATION_TIMEOUT_MINUTES * 60 * 1000);
    const result = await tx.execute(sql`
      INSERT INTO billing_discount_redemptions
        (client_id, code, status, reservation_token, expires_at)
      VALUES
        (${clientId}, ${codeHash}, 'reserved', ${token}, ${expiresAt})
      ON CONFLICT (client_id) DO NOTHING
      RETURNING id
    `);
    return (result.rows ?? []).length > 0 ? { code: codeHash, token, expiresAt } : null;
  });
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
    !code ||
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
      metadata: { complytrack_discount_code: "alps_client_50" },
    },
    { idempotencyKey: `create-${ALPS_COUPON_ID}` },
  );
  return coupon.id;
}