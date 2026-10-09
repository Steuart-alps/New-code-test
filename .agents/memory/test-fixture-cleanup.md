---
name: Per-run test fixture cleanup
description: API suites remove only their own run's tenants via tests/fixture-ownership.mjs; audit ledgers need a transaction-scoped trigger suspension.
---

Integration suites that register accounts (module-routes, config-endpoints,
contractor-compliance-reminders) put their run UUID in every user email (and in
created client slugs where possible), track every client id they create
(including consultant-created secondary clients), and call the shared purge in a
`finally` block. `TEST_RUN_ID` / `FIXTURE_PROBE_FAIL_AT` let
`test:fixture-cleanup-isolation` drive deliberate concurrent failures.

**Why:** `DELETE FROM clients` fails once audited records exist: `audit_log` and
`audit_events` reference clients with ON DELETE RESTRICT and are append-only
through user triggers, so per-table delete lists also go stale as tables are added.

**How to apply:** use `purgeOwnedFixtures` / `buildOwnedFixturePurgeSql`, never
hand-written client deletes. It refuses tracked clients not linked to the run's
`@test.local` users and refuses any dependent row with a foreign `client_id`.
It suspends user triggers only inside its own transaction (DDL is transactional,
so other sessions never see the guards off). Production erasure must keep this
evidence (`src/lib/offboarding.ts`); the suspension is for synthetic test tenants
only. Suites now require an explicit `API_BASE` rather than defaulting to a live API.
