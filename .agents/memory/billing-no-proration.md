---
name: No-proration billing outbox
description: How added-site charges work (event outbox, idempotency) and why — do not revert to quantity-delta charging
---

**Rule:** Site additions are billed via an event outbox: `POST /sites` inserts the site row AND a `billing_pending_charges` row (unique per `site_id`) in one DB transaction. Charging happens in `processPendingCharges` (claim via `FOR UPDATE SKIP LOCKED`, Stripe idempotency keys per row, metadata search `pending_charge_id` as a durable duplicate guard). Subscription quantity sync uses `proration_behavior: "none"`; decreases give no refund/credit.

**Why:** Architect review found quantity-delta charging loses charges under concurrent add+remove (netting) and that idempotency keys alone can duplicate after Stripe key eviction. Three review rounds converged on: event-based intent + row claiming + metadata lookup. Also: rows queued strictly BEFORE `subscription.created` are skipped (initial checkout already covers them); the comparator must be `<` (skip) not `<=`, or same-second adds lose valid charges.

**How to apply:** Any new site-creation path must call `queueSiteAddedCharge` inside the same transaction. Never re-derive charges from quantity deltas. Charge amount/billability are resolved at charge time, not enqueue time. Rows can be `pending | charged | skipped | error | void | uncollectible`; drift alerting should watch `error`.
