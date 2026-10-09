---
name: Drizzle transaction startup
description: Cleanup ownership when adding transaction-local actor setup to pooled Drizzle connections.
---

Transaction-start interception must own cleanup for both BEGIN and context-initialisation failures, not rely on Drizzle's transaction callback cleanup.

**Why:** The installed node-postgres Drizzle driver awaits BEGIN before entering its transaction try/finally. A failure in extra actor-context setup at that point otherwise leaves a checked-out connection and potentially an open transaction.

**How to apply:** Keep startup rollback plus exactly-once connection destruction on failure when modifying the audit adapter. Verify injected BEGIN, context-setup, and rollback failures, then verify a later request can reuse the pool without inheriting attribution.