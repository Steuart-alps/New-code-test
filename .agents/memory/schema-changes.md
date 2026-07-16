---
name: Schema change workflow
description: How to actually apply DB schema changes in dev and prod in this project.
---

# Schema change workflow

**Rule:** a new table/column needs three touches: (1) drizzle schema file in `lib/db/src/schema` (+ export), (2) applied to dev DB, (3) added as an idempotent statement to the api-server runtime migrations (which run on every boot).

**Why:** `drizzle-kit push` prompts interactively (create vs rename) and cannot be answered headlessly — even `--force` and piped stdin don't work. Production never runs drizzle push; the deployed server only gets schema changes through its boot-time runtime migrations.

**How to apply:** for dev, either answer the push prompt manually or apply the DDL directly with `psql "$DATABASE_URL"` using the same `IF NOT EXISTS` statements you add to runtime migrations. Include any backfill there too, idempotently (`ON CONFLICT DO NOTHING`).
