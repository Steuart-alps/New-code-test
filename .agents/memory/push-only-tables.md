---
name: Push-only Drizzle tables
description: Drizzle tables that runtime migrations never created; how to audit and fix them.
---

Rule: every `pgTable(...)` in `lib/db/src/schema/` must have a `CREATE TABLE IF NOT EXISTS`
in `artifacts/api-server/src/lib/` (runtime baseline or runtime migrations). A table that only
drizzle push ever created makes its routes 500 on a runtime-migrated database (fresh-schema
harness, or any deployment that skips push).

**Why:** an October 2026 audit (77 Drizzle tables) found five push-only tables:
`certificates` (PR #18), `password_reset_tokens` (PR #26), `safe_inductions` and
`safe_competency_signoffs` (fixed in `migrateSafeTrackPushOnlyTables`), and
`green_machine_reconciliations`, which no API, script or web code references, so it was left
uncreated (recommendation: delete the Drizzle definition, or add a runtime migration in the
same change that first uses it).

**How to apply:** re-run the audit when adding schema: list `pgTable("name"` in the schema
folder and diff against `CREATE TABLE` names under `artifacts/api-server/src`. For a fix,
mirror the Drizzle columns/FKs exactly, then add only missing nullable or defaulted columns
with `ADD COLUMN IF NOT EXISTS` (never NOT NULL without a default), and add a
fresh-schema route test that creates, reads and cross-tenant-probes the rows.
