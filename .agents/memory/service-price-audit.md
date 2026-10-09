---
name: Service-price audit alerts
description: Periodic read-only Stripe price-catalogue audit alerts once per incident via persisted state; never repairs.
---

The hourly (`:25`) service-price audit (`src/lib/servicePriceAudit.ts`) re-runs `getServicePricePreflight` against the synced `stripe.*` mirror and alerts ADMIN_EMAIL (log only when unset).

**Rule:** dedupe by a fingerprint of the affected `key:reason` set stored in `service_price_audit_state` (not in memory), so restarts and multiple instances do not repeat an alert; a different set re-alerts, recovery is reported once, a failed send leaves the incident un-notified so the next run retries, and a catalogue read failure changes nothing.

**Why:** operators need to hear about prices archived after startup before clients hit activation failures, without hourly spam or the job "fixing" prices that may still back subscriptions.

**How to apply:** the audit may write only its own state row; never call Stripe, `ensureServicePrices`, or deactivate/repair anything from it.
