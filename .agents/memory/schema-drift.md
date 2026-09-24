---
name: Schema drift vs runtime migrations
description: Live dev/prod tables can differ from the CREATE TABLE text in runtimeMigrations — verify real columns before writing raw SQL.
---

Rule: never trust the `CREATE TABLE IF NOT EXISTS` definitions in the api-server runtime migrations as the source of truth for column names. `IF NOT EXISTS` does nothing for tables that already exist, so drifted tables keep their original columns.

**Why:** the live `bike_hire_records` table uses `guest_name`, `guest_contact`, `hire_date`, `return_date_expected/actual`, while the migration text says `hirer_name`, `hire_start`, `expected_return`. A legacy `staff_roster` also lacked columns present in its current `CREATE TABLE` definition, breaking tenant export queries until the runtime migration added them.

**How to apply:** before writing raw SQL against a table, check the actual columns (`information_schema.columns`) or grep how existing routes query it. Route code is a more reliable reference than the migration file.

**Dropping legacy indexes safely:** never match candidates with `pg_get_indexdef LIKE '%...%'` — a wider unique index (e.g. same cols + one more) matches too and gets silently dropped. Resolve exact key attnums via `pg_index.indkey` (require exact column set, no expressions, no predicate).

**Route coverage:** a Drizzle table definition can exist without a runtime-created table. Add a fresh-database route test whenever a new route depends on a table, so missing runtime migrations fail before launch.
