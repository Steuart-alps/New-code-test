---
name: Storage overage pricing
description: The commercial rule for retained object storage estimates and future billing.
---

Retained storage includes 1 GiB for the base subscription entitlement. Excess storage is priced from the storage provider's rate (`STORAGE_PROVIDER_USD_PER_GIB_MONTH`, default 0.015 USD/GiB-month — the Replit App Storage rate it was set from; renamed from `STORAGE_REPLIT_USD_PER_GIB_MONTH` on 2026-10-09 with the default unchanged) plus a 20% ALPS margin, calculated in integer currency minor units and scaled by the exact excess GiB. Download traffic is metered and displayed separately but is not included in the storage overage charge. Customer-approved capacity purchases belong on the existing Stripe subscription, not a second subscription.

**Why:** The customer should bear the incremental storage cost without ALPS guessing at a fixed package price; the provider rate and margin are the source of truth.

**How to apply:** Keep the provider rate, margin, and recurring Stripe price server-controlled. Preserve the same threshold, calculation, currency treatment, and idempotency at the invoice boundary; only add capacity after an authenticated manager action.

**Price alignment (Oct 2026):** the Stripe add-on price (STORAGE_ADDON_PRICE_ID) is checked against the same calculation in `api-server/src/lib/storagePricing.ts`: provider USD rate × (1 + margin) × `STORAGE_USD_EXCHANGE_RATE` (required for non-USD prices; no default, no live FX lookup), rounded up to whole minor units, within `STORAGE_PRICE_TOLERANCE_PERCENT` (default 5). Purchases must reach Stripe's minimum charge (GBP 0.30, USD/EUR 0.50), so the minimum quantity is enforced and shown. Drift pauses new purchases (never re-prices existing subscriptions) and the hourly audit emails ADMIN_EMAIL once per finding (state row `storage_addon_price` in `service_price_audit_state`). A provider-rate change means: create a new Stripe price at the expected amount and repoint STORAGE_ADDON_PRICE_ID; customers on the old price stay on it until moved.

**Reducing paid storage (2026-10-15):** `POST /billing/storage/reduce` lowers the storage item's Stripe quantity at once with `proration_behavior: "none"` (no refund, next renewal bills less) and records a row in `storage_capacity_reductions`; GiB removed stay counted as paid until that row's `effective_at` (the period end), so Settings and the estimate keep them. Never below `ceil((retained bytes − plan GiB) / 1 GiB)`, never touches files, serialised per client by an advisory lock, idempotent per `requestId`. The storage item is per GiB, not per site: the site-count sync, per-site charge rate and billing config skip it via `isStorageSubscriptionItem` (`lib/storageCapacity.ts`). Test: `test:storage-capacity-reduction`.
