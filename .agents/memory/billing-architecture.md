---
name: Billing architecture
description: Durable billing decisions for ComplyTrack — per-site pricing model and subscription rules.
---

# ComplyTrack billing decisions

- **Account = client, not user.** The Stripe customer lives on the client record. Anything billing-related keys off the client.
- **One price, quantity = site count.** Single £10/month per-site price; subscription quantity tracks the account's site count, floored at 1.
- **No proration — full month always.** Quantity changes use `proration_behavior: "none"` so every month is billed in full regardless of when sites are added/removed. **Why:** user decision (July 2026) to keep invoices and tax simple. Don't reintroduce prorations.
- **Drift is an alarm, not just self-healing.** The daily reconciliation returns the corrections it applied; drift means something upstream broke (missed webhook/failed sync), so it's logged as a warning and emailed to ADMIN_EMAIL (best-effort) rather than silently fixed.
- **Trial reminders are one-shot.** A daily job emails a client's consultants ~3 days before `trial_ends_at` and stamps `trial_reminder_sent_at` to prevent repeats.
- **Never trust a client-supplied price id.** Checkout (both signup and the in-app route) must resolve the per-site price server-side and ignore any priceId from the request, or callers can subscribe to a different price. **Why:** a rejected review caught exactly this billing-integrity hole.
- **Look subscriptions up dynamically by customer id.** No stored subscription id is reliable — the Stripe webhook only populates the synced `stripe.*` mirror tables. **Why:** a stored id goes stale; customer-id lookup is robust.
- **One subscription per client.** Checkout refuses to create a second subscription when a live (active/trialing/past_due) one exists; users manage it via the Stripe billing portal instead.
- **Quantity sync is best-effort.** It must never throw and break site create/delete; the price resolver returns null when Stripe isn't seeded, and callers must tolerate that.
