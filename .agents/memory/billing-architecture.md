---
name: Billing architecture
description: How ComplyTrack billing is wired — per-site Stripe pricing, account model, and subscription lookup.
---

# ComplyTrack billing

- **Account = client** (`clientsTable`), not user. Stripe customer id is stored on the **client** (`clientsTable.stripeCustomerId`). It is set both at register (auth.ts) and lazily in `/billing/checkout`.
- **Pricing model**: single £10/month per-site Stripe price. Subscription `quantity` = client's site count, floored at 1 (`quantityForSiteCount = max(n,1)`). Updated with `proration_behavior: "create_prorations"` on site create/delete (`sites.ts` → `syncClientSubscriptionQuantity`).
- **Subscription lookup is dynamic**: nothing reliably stores `clientsTable.stripeSubscriptionId` — the Stripe webhook only runs stripe-replit-sync into `stripe.*` tables. So `findLiveSubscription(customerId)` lists subs via the Stripe API and picks the first active/trialing/past_due. One subscription per client is enforced in `/checkout` (409 if a live sub exists → use portal).
- **Per-site price resolution** (`getPerSitePrice`) queries the synced `stripe.prices`/`stripe.products` tables for the cheapest active monthly recurring price. Returns null if Stripe sync hasn't populated (e.g. seed not run) — callers must handle null.

**Why:** The sync tables are eventually-consistent and a stored sub id can go stale; looking up by customer id is robust.

**How to apply:** When touching billing, keep customer id on the client, never assume a stored subscription id, and keep `syncClientSubscriptionQuantity` best-effort (must not throw and break site CRUD).
