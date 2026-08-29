---
name: API test readiness
description: How integration runners avoid racing API startup migrations.
---

Use `/healthz` only for process/liveness checks. Integration runners that register users or access migrated tables must wait for `/readyz`.

**Why:** The HTTP listener and `/healthz` become available before runtime migrations and startup initialization finish. Larger migration batches made tests intermittently begin registration too early and fail with misleading authentication errors.

**How to apply:** When a test runner starts a private API instance, poll `/readyz` before executing the suite. Keep deployment liveness probes on `/healthz`.