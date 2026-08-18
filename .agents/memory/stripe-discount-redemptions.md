---
name: Stripe discount redemptions
description: Rules for enforcing single-use, recurring Stripe discounts without losing delayed Checkout webhooks.
---

Recurring discount-code use is an application-level entitlement as well as a Stripe coupon: reserve it with a unique token placed in Checkout metadata, then mark it redeemed from the signed completion webhook before returning a 200 response.

**Why:** Checkout can complete close to expiry and Stripe webhooks can be delayed. Releasing a reservation based only on a local timeout allows a completed discounted subscription to escape the one-use record and be redeemed again later.

**How to apply:** Tie a reservation to the exact Stripe Checkout session and expiry. Before replacing a timed-out claim, retrieve that session from Stripe: retain/mark completed sessions redeemed, release only Stripe-confirmed expired sessions, and keep uncertain records blocked. If session persistence fails, expire the live Checkout session before releasing the claim; fail closed if cleanup is uncertain.