---
name: Validation steps setup
description: How the automated test validation steps are wired and platform quirks hit while registering them.
---

# Validation steps

- Canonical validation steps: `test-trial-reminders` and `test-tenant-isolation` (the latter runs a self-booting wrapper that starts the API server on TEST_PORT if `$API_BASE/healthz` isn't answering).
- **Why:** validation runs in a clean shell where no workflow is running, so any test needing a live server must boot one itself.
- **How to apply:** `setValidationCommand` rejects names that already exist as non-validation workflows — pick a fresh name (e.g. `test-` prefix). Watch for legacy workflows with `isValidation = true` duplicating a step; `clearValidationCommand` removes them even when `setValidationCommand` refused the name.

**Duplicate test workflows race:** `trial-reminders` and `test-trial-reminders` run the same suite; when both fire concurrently (e.g. after a restart-all), their seeded rows cross-contaminate and one fails with swapped email expectations. Re-run one alone to confirm; ignore paired failures.
