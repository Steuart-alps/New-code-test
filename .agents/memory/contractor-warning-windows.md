---
name: Contractor warning windows
description: Durable semantics for the client-configurable contractor expiry reminder lead time.
---

Contractor expiry reminders use a dedicated client setting rather than the generic compliance-item reminder lead time. Missing, null, or blank values preserve the 30-day default; accepted values are whole days from 0 through 365 inclusive. The window applies to date-based contractor expiry alerts, while the legacy DBS/PVG check-date age rule remains a fixed three-year policy.

**Why:** The generic reminder setting is consumed by unrelated compliance-item notifications, and changing the legacy age policy would change the meaning of existing DBS records.

**How to apply:** When adding contractor reminder paths, read the dedicated client setting, normalize invalid stored values to 30 days, and keep milestone keys date-based so changing the window does not resend an unchanged milestone.