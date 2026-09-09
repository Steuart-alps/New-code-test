---
name: Restart-safe notification delivery
description: Durable delivery rule for scheduled email digests that must survive worker crashes.
---

Scheduled email digests that require daily deduplication must use an atomic, expiring delivery lease and a stable provider idempotency key derived from the tenant and delivery period.

**Why:** A permanent claim written before dispatch loses the alert if the worker crashes before sending. Releasing every uncertain claim can duplicate an email if the provider accepted it just before the crash. A reclaimable lease plus the same provider key closes both failure windows.

**How to apply:** Finalise the database record after provider acceptance and before best-effort secondary channels such as push. Release only the current worker's claim on a confirmed send failure; reclaim abandoned claims after the lease expires.