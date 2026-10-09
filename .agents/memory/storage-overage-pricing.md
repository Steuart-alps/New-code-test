---
name: Storage overage pricing
description: The commercial rule for retained object storage estimates and future billing.
---

Retained storage includes 1 GiB for the base subscription entitlement. Excess storage is priced from the current Replit App Storage rate plus a 20% ALPS margin, calculated in integer currency minor units and scaled by the exact excess GiB. Download traffic is metered and displayed separately but is not included in the storage overage charge. Customer-approved capacity purchases belong on the existing Stripe subscription, not a second subscription.

**Why:** The customer should bear the incremental storage cost without ALPS guessing at a fixed package price; the provider rate and margin are the source of truth.

**How to apply:** Keep the provider rate, margin, and recurring Stripe price server-controlled. Preserve the same threshold, calculation, currency treatment, and idempotency at the invoice boundary; only add capacity after an authenticated manager action.