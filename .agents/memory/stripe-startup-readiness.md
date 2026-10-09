---
name: Stripe start-up readiness
description: Stripe init is a bounded, supervised attempt; what /readyz reports for unconfigured, slow, failing and verified-incomplete Stripe, and how billing activation is gated.
---

Stripe initialization runs under `startStripeInitialization` (`api-server/src/lib/stripeStartup.ts`), not inline before readiness. `/readyz` is 503 `starting` until the first attempt settles or `STRIPE_INIT_TIMEOUT_MS` (120 s) passes; after that it is never `starting` because of Stripe.

- Unconfigured (no `STRIPE_SECRET_KEY`; the Replit connector fallback was removed 2026-10-09): 503 `degraded` when `NODE_ENV=production`, otherwise 200 with `billing.state: "unconfigured"`. No attempt runs.
- Slow/hung: 503 `degraded`, blocker names the step (`sync SDK import`, `credential lookup`, `managed webhook`, `backfill sync`, …). A stalled attempt is never retried concurrently (webhook find-or-create and price creation must not run twice); success later flips to `ok`.
- Failing or catalogue unreadable: 503 `degraded`, retried with back-off (30 s → 15 min).
- Catalogue read but prices missing/duplicated: 503 `degraded`, not retried (needs an admin).

**Why:** a hung step left `/readyz` on `starting` for ever after restarts, and scheduled jobs never started; with no key, test runners booting `dist/index.mjs` never became ready.

**How to apply:** checkout and add-on activation return 503 before any Stripe call unless `isBillingActivationAllowed()` (ready, or a verified catalogue whose per-service preflight then decides). Billing reconciliation (startup and daily) runs only once the catalogue has been read (`isStripeCatalogueVerified()`). (`STRIPE_CONNECTOR_TIMEOUT_MS` bounded the Replit connector fetch; it went with the connector.) Keep blockers and stage names fixed strings: `/readyz` is public and must never carry credentials or error text.
