---
name: Integration and job testing
description: Workspace helper bundling, whole-table job fixtures, and HTTP test isolation.
---

# Internal-job test pattern

Internal jobs (e.g. trial reminders) can't be tested via the HTTP-level test style. Pattern that works:

- Give the job an optional injected deps param (e.g. `{ sendEmail }`) defaulting to the real sender — never mock at module level.
- Test script is plain `.mjs` in `artifacts/api-server/tests/`; it esbuild-bundles a tiny `.entry.ts` (re-exporting the job + db + schema) at runtime, externalizing `pino`, `pino-pretty`, `resend`, `pg-native`, `nodemailer`, `@google-cloud/*`, and adds a `createRequire` banner for bundled CJS (pg). Output must land under the tests dir so externals resolve from api-server's node_modules.
- The same bundling requirement applies to HTTP integration tests that use `@workspace/db` directly to seed or clean up fixtures. A plain Node `.mjs` import fails on the workspace's TypeScript directory export, even if the separate API server build succeeded. Readiness checks for an isolated server use root `/readyz`, not `/api/readyz`.
- Whole-table job tests must inject an explicit fixture-ID candidate scope, including safe empty-scope semantics. Never neutralize unrelated rows and restore them later.

**Why:** a second test run can see or restore the first run's scheduling markers; even a fake sender does not make global state mutation hermetic.

**How to apply:** keep production invocations unscoped, pass only the current run's fixture IDs in tests, and prove two disjoint scopes work simultaneously without the outer runner lock.

**Why:** `@workspace/db` exports TS source and its dist is absent, so plain Node can't import it; bundling everything breaks on pino workers/native addons.

**How to apply:** copy `tests/trial-reminders.mjs` bundling setup for any new job test; wire it as a `test:*` script plus a console workflow like `tenant-isolation`.

## HTTP fixture isolation

Tests that mutate a database through HTTP and clean up using a direct database connection should own their private local API, with email captured explicitly.

**Why:** a ready HTTP endpoint may use a different database from the cleanup connection, leaving fixtures behind in the wrong environment. `NODE_ENV=test` alone does not suppress real email-provider calls, even for synthetic recipient addresses.

**How to apply:** self-boot the API with the same database environment as the test helpers and explicit email capture; reject arbitrary endpoint reuse. Use unique fixture identities, finally-based cleanup, and verify cleanup after deliberate request failures as well as successful runs.

Keep production login throttles enabled in integration tests.

**Why:** Unique fixture accounts do not isolate per-IP counters across suites. Relaxing the throttle to accommodate fixture volume would make approval-flow tests less representative of production.

**How to apply:** Budget fixture logins or give each suite its own private API process, rather than adding a test-only login-rate-limit bypass.
