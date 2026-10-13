---
name: Stripe discount redemptions
description: Rules for enforcing single-use, recurring Stripe discounts without losing delayed Checkout webhooks.
---

Recurring discount-code use is an application-level entitlement as well as a Stripe coupon: reserve it with a unique token placed in Checkout metadata, then mark it redeemed from the signed completion webhook before returning a 200 response.

**Why:** Checkout can complete close to expiry and Stripe webhooks can be delayed. Releasing a reservation based only on a local timeout allows a completed discounted subscription to escape the one-use record and be redeemed again later.

**How to apply:** Tie a reservation to the exact Stripe Checkout session and expiry. Before replacing a timed-out claim, retrieve that session from Stripe: retain/mark completed sessions redeemed, release only Stripe-confirmed expired sessions, and keep uncertain records blocked. If session persistence fails, expire the live Checkout session before releasing the claim; fail closed if cleanup is uncertain.
**Per-client codes (manager-issued):** Discount codes are now unique per client — one row in billing_discount_codes storing only a SHA-256 hash + 4-char hint; the raw code is shown to the issuing manager exactly once. Reservation rows and Stripe metadata carry the hash, never the raw code. Redemption is client-wide (unique index on client_id): one lifetime discount per client, even after code replacement. Issue/replace and reserve both take a per-client pg_advisory_xact_lock inside a transaction, and reserve re-verifies the hash is still the active code under the lock, so replace-vs-checkout races are impossible.
**Existing subscribers:** `POST /billing/discount-code/redeem` lets a client that already pays apply its code. Under the same advisory lock it re-verifies the hash, records the single redemption as redeemed, and adds the coupon to the live subscription (existing discounts kept, `proration_behavior: none`, idempotency key per client+subscription) before commit, so a Stripe failure records nothing. Only platform operators (`platformOperator` on /auth/me) see the issue button.
