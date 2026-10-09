---
name: API test readiness
description: How integration runners avoid racing API startup migrations.
---

Use `/healthz` only for process/liveness checks. Integration runners that register users or access migrated tables must wait for `/readyz`. Outside production, an API without Stripe credentials reports 200 with `billing.state: "unconfigured"` (see stripe-startup-readiness.md).

**Why:** The HTTP listener and `/healthz` become available before runtime migrations and startup initialization finish. Larger migration batches made tests intermittently begin registration too early and fail with misleading authentication errors.

**How to apply:** When a test runner starts a private API instance, poll `/readyz` before executing the suite. Keep deployment liveness probes on `/healthz`.

Raw Node ESM integration tests cannot directly import the TypeScript database workspace package, and bundling that package as ESM fails on the PostgreSQL driver's dynamic CommonJS requires.

**Why:** Attempts to force database timestamps from a plain `.mjs` API test failed first on directory-style TypeScript exports and then on the driver's dynamic `events` require.

**How to apply:** Keep plain `.mjs` suites API-only, or create a dedicated esbuild test entry that owns database setup in a Node-compatible bundle format. Do not add test-only production endpoints to mutate state.

For file-content unit tests, keep byte detection and decoding independent from the concrete storage service. Test storage ownership and finalization separately with an isolated storage fixture.

**Why:** Bundling the storage service pulled database and provider dependencies into a pure validation test, triggering Node ESM/CommonJS resolution failures; externalizing them then exposed unsupported workspace directory imports.

**How to apply:** Feed explicit byte buffers to a standalone validator module. Keep database and object-storage integration tests in their own runners, with dedicated test resources.