---
name: Validation steps setup
description: How the automated test validation steps are wired and platform quirks hit while registering them.
---

# Validation steps

- Canonical validation steps: `test-trial-reminders` and `test-tenant-isolation` (the latter runs a self-booting wrapper that starts the API server on TEST_PORT if `$API_BASE/healthz` isn't answering).
- **Why:** validation runs in a clean shell where no workflow is running, so any test needing a live server must boot one itself.
- **How to apply:** `setValidationCommand` rejects names that already exist as non-validation workflows — pick a fresh name (e.g. `test-` prefix). Watch for legacy workflows with `isValidation = true` duplicating a step; `clearValidationCommand` removes them even when `setValidationCommand` refused the name.

**Duplicate test workflows race:** `trial-reminders` and `test-trial-reminders` run the same suite; when both fire concurrently (e.g. after a restart-all), their seeded rows cross-contaminate and one fails with swapped email expectations. Re-run one alone to confirm; ignore paired failures.
- Build validation steps: `build-api-server` and `build-web`. The vite config hard-requires `PORT` and `BASE_PATH` env vars (normally injected by the artifact service), so the `build-web` command must inline `PORT=5000 BASE_PATH=/`.

**Broad completion-check contention:** automatic completion validation starts many API integration suites together. Their shared lock waiters can time out, and the suite holding the lock can miss its readiness deadline under the concurrent load even when its assertions pass in isolation.
- **Why:** a parallel completion run reported lock timeouts and module-server readiness failure while the same module suite passed when rerun alone.
- **How to apply:** inspect failure logs for lock/readiness symptoms, run the affected suite serially to separate infrastructure contention from a real regression, and avoid broad retries that reproduce the same contention.

**Codegen race in parallel checks:** the API codegen drift check temporarily removes generated client files; a concurrent fresh-schema build can fail to import them even though both checks pass in sequence.
- **Why:** completion validation once failed during that temporary file gap, while the fresh-schema suite passed independently without code changes.
- **How to apply:** when the only fresh-schema failure is a missing generated API import, run it alone after codegen finishes rather than treating it as a schema regression.

**Validation inventory response shape:** the live `getValidationCommands()` callback returns `{ commands: [{ name, command }], message }`, despite the skill describing a `workflows` array.
- **Why:** following the documented shape caused an undefined-array error; the live response confirmed the different envelope.
- **How to apply:** inspect the live envelope and read `commands` when checking for existing validation names. Do not assume the skill's output shape is current.
