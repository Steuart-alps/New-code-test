---
name: Testing internal jobs
description: How to test api-server internal jobs (cron-style, no HTTP route) against the dev DB.
---

# Internal-job test pattern

Internal jobs (e.g. trial reminders) can't be tested via the HTTP-level test style. Pattern that works:

- Give the job an optional injected deps param (e.g. `{ sendEmail }`) defaulting to the real sender — never mock at module level.
- Test script is plain `.mjs` in `artifacts/api-server/tests/`; it esbuild-bundles a tiny `.entry.ts` (re-exporting the job + db + schema) at runtime, externalizing `pino`, `pino-pretty`, `resend`, `pg-native`, `nodemailer`, `@google-cloud/*`, and adds a `createRequire` banner for bundled CJS (pg). Output must land under the tests dir so externals resolve from api-server's node_modules.
- Jobs that scan whole tables: neutralize pre-existing matching rows first (temporarily set their dedupe flag), restore in `finally`, so real dev data is never emailed or permanently flagged.

**Why:** `@workspace/db` exports TS source and its dist is absent, so plain Node can't import it; bundling everything breaks on pino workers/native addons.

**How to apply:** copy `tests/trial-reminders.mjs` bundling setup for any new job test; wire it as a `test:*` script plus a console workflow like `tenant-isolation`.
