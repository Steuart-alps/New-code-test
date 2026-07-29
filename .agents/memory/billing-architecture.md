---
name: Billing architecture
description: Durable billing decisions for ComplyTrack — per-site pricing model and subscription rules.
---

# ComplyTrack billing decisions

- **Account = client, not user.** The Stripe customer lives on the client record. Anything billing-related keys off the client.
- **Per-service prices, quantity = site count.** Every service (core, FireTrack, KitchenTrack, Complete bundle) is a per-site monthly price identified by `service_key` price metadata; ALL per-site items on a subscription track the account's site count in lockstep, floored at 1. **Why:** metadata-keyed lookup replaced "cheapest active price" (July 2026) — with multiple prices the cheapest-price heuristic silently picks the wrong plan; the legacy no-metadata fallback exists only for core.
- **Entitlements come from subscription items, not local flags.** Which branches a client can use = union of its items' `service_key`s; bundle item or per-site sum ≥ £50 unlocks everything; active trial unlocks everything free. Cached per client — invalidate alongside the trial-lock cache whenever items change. UI "Active" state must come from real subscription items (`subscribed` flag), never `clients.subscription_status`, which can say "active" with no Stripe customer.
- **Add-on add = charge first month up front or roll back.** Adding a service mid-period adds the item (proration none) plus an immediate idempotency-keyed full-month invoice, keys scoped to subscription+service+period; if the invoice can't be created, the item add is rolled back — never silently enable without collecting. Removal is immediate with no refund.
- **No proration — full month always.** Quantity changes use `proration_behavior: "none"` so every month is billed in full regardless of when sites are added/removed. **Why:** user decision (July 2026) to keep invoices and tax simple. Don't reintroduce prorations.
- **Drift is an alarm, not just self-healing.** The daily reconciliation returns the corrections it applied; drift means something upstream broke (missed webhook/failed sync), so it's logged as a warning and emailed to ADMIN_EMAIL (best-effort) rather than silently fixed.
- **Trial reminders are one-shot.** A daily job emails a client's consultants ~3 days before `trial_ends_at` and stamps `trial_reminder_sent_at` to prevent repeats.
- **Never trust a client-supplied price id.** Checkout (both signup and the in-app route) must resolve the per-site price server-side and ignore any priceId from the request, or callers can subscribe to a different price. **Why:** a rejected review caught exactly this billing-integrity hole.
- **Look subscriptions up dynamically by customer id.** No stored subscription id is reliable — the Stripe webhook only populates the synced `stripe.*` mirror tables. **Why:** a stored id goes stale; customer-id lookup is robust.
- **One subscription per client.** Checkout refuses to create a second subscription when a live (active/trialing/past_due) one exists; users manage it via the Stripe billing portal instead.
- **Quantity sync is best-effort.** It must never throw and break site create/delete; the price resolver returns null when Stripe isn't seeded, and callers must tolerate that.
