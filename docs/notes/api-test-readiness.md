---
name: API test readiness
description: How integration runners avoid racing API startup migrations.
---

Use `/healthz` only for process/liveness checks. Integration runners that register users or access migrated tables must wait for `/readyz`.

**Why:** The HTTP listener and `/healthz` become available before runtime migrations and startup initialization finish. Larger migration batches made tests intermittently begin registration too early and fail with misleading authentication errors.

**How to apply:** When a test runner starts a private API instance, poll `/readyz` before executing the suite. Keep deployment liveness probes on `/healthz`.

Raw Node ESM integration tests cannot directly import the TypeScript database workspace package, and bundling that package as ESM fails on the PostgreSQL driver's dynamic CommonJS requires.

**Why:** Attempts to force database timestamps from a plain `.mjs` API test failed first on directory-style TypeScript exports and then on the driver's dynamic `events` require.

**How to apply:** Keep plain `.mjs` suites API-only, or create a dedicated esbuild test entry that owns database setup in a Node-compatible bundle format. Do not add test-only production endpoints to mutate state.