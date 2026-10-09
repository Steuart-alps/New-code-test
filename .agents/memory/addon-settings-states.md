---
name: Add-on Settings states
description: Settings add-on rows show Active only for server-confirmed adds and explain unpurchasable add-ons from the price preflight.
---

- **Confirmation comes from the entitlement list.** `POST /billing/services` add returns `entitled` as `"all"` or a list of service keys, never `true`; `isServiceEntitled` in `src/lib/service-action-outcome.ts` is the single check. **Why:** the old `entitled === true` test marked every real successful add as "Payment pending" while the browser mock (which returned `true`) hid it.
- **A row is Active only if it is on the subscription and no add this session came back pending/unconfirmed.** Declined (502), API errors, network failures, `paymentPending` and unconfirmed entitlement each leave a row-level notice; Settings always re-reads `/billing/config` afterwards. Retries send the same `{service, action}` body: the Stripe idempotency key is derived server-side from subscription + service + period, so the client must never add its own varying key.
- **Purchase availability reuses the activation preflight.** `/billing/config` exposes `services.addonAvailability = { checked, unavailable }` from `getServicePricePreflight()` (missing or duplicate price → unavailable; failed read → `checked: false`, which pauses Add). Paid rows keep Active/Remove; unavailable rows (including legacy PoolTrack) stay visible with an explanation instead of an Add button. Operator detail (missing vs duplicate) stays on the consultant-only preflight.
