---
name: PostgreSQL row locking with joins
description: Constraint for locking a tenant row in route transactions that also join optional related records.
---

When a transaction selects a tenant-owned base row with nullable joins and needs to lock it, scope PostgreSQL locking to the base table with `FOR UPDATE OF base_alias`; an unqualified `FOR UPDATE` can fail because PostgreSQL tries to lock the nullable side of an outer join.

**Why:** PostgreSQL rejects unqualified row locks over the nullable side of an outer join, turning an otherwise valid request into a 500 response.

**How to apply:** Use an explicit base-table lock in route transactions, then perform related-record reads in the same transaction as needed.