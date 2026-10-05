---
name: Roster reconciliation identity
description: Rules for monthly payroll or shift roster replacement without losing worker-linked compliance history.
---

Use a stable tenant-wide payroll or workforce identifier as the authoritative staff identity. Monthly imports update existing roster rows in place, reactivate returning workers, and make missing workers inactive; they never delete and recreate matched workers.

Legacy roster rows without an identifier may be assigned one only when there is exactly one unambiguous match by normalized email, or otherwise by normalized full name within the same site. Ambiguous matches must block the whole import for manual review. Never silently choose a match or use names as the ongoing identity.

**Why:** Training, acknowledgements, sign-offs and other compliance evidence can link to the roster row's internal ID. Replacing that row would detach the visible worker from historical evidence, while name-only matching can merge different people.

**How to apply:** Validate the complete file before writes, enforce tenant-wide identifier uniqueness, validate site ownership, preview counts before confirmation, reconcile transactionally, preserve name snapshots in historical records, and treat normal staff removal as deactivation.