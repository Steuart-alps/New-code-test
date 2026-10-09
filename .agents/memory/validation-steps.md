---
name: Validation steps setup
description: Historical (Replit-only) — How the automated test validation steps are wired and platform quirks hit while registering them.
---

> **Historical (Replit-only, 2026-10-09):** ComplyTrack no longer runs on Replit (see `replit-removed-render-only.md`). Replit validation steps (`setValidationCommand`, workflows, artifact-injected PORT/BASE_PATH, preview restarts) no longer exist; the contention and codegen-race lessons still apply to `scripts/validate.mjs` runs. Kept for context only.

# Validation steps

- Canonical validation steps: `test-trial-reminders` and `test-tenant-isolation` (the latter runs a self-booting wrapper that starts the API server on TEST_PORT if `$API_BASE/healthz` isn't answering).
- **Why:** validation runs in a clean shell where no workflow is running, so any test needing a live server must boot one itself.
- **How to apply:** `setValidationCommand` rejects names that already exist as non-validation workflows — pick a fresh name (e.g. `test-` prefix). Watch for legacy workflows with `isValidation = true` duplicating a step; `clearValidationCommand` removes them even when `setValidationCommand` refused the name.

**Fixture isolation and locks solve different problems:** unique identities alone do not isolate a job that scans all tenants. Scope job candidates to owned fixture IDs, and retain shared runner serialization for builds and migrations.
- **Why:** duplicate reminder tests swapped recipients because they globally neutralized candidate rows, even though fixture names were unique.
- **How to apply:** exercise disjoint job scopes concurrently without the outer lock, then exercise the launch group through its locked entrypoints. Remove duplicate workflows rather than treating paired failures as acceptable.
- Build validation steps: `build-api-server` and `build-web`. The vite config hard-requires `PORT` and `BASE_PATH` env vars (normally injected by the artifact service), so the `build-web` command must inline `PORT=5000 BASE_PATH=/`.

**Broad completion-check contention:** automatic completion validation starts builds plus many API/browser suites together. Shared lock waiters, Vite readiness and browser launches can time out; a concurrent build can be killed with exit 137 even when the same checks pass in isolation.
- **Why:** parallel completion runs have reported lock/readiness and browser-launch failures plus a killed web build, while targeted suites and the sequential build passed.
- **How to apply:** inspect failure logs for contention symptoms, run affected checks serially to separate infrastructure contention from a real regression, and avoid broad retries that reproduce the same contention. Describe any full-project validation limitation separately from successful task-specific checks.

**Codegen race in parallel checks:** the API codegen drift check temporarily removes generated client files; a concurrent fresh-schema build can fail to import them even though both checks pass in sequence.
- **Why:** completion validation once failed during that temporary file gap, while the fresh-schema suite passed independently without code changes.
- **How to apply:** when the only fresh-schema failure is a missing generated API import, run it alone after codegen finishes rather than treating it as a schema regression.

**Preview after codegen checks:** a running Vite preview can retain missing-generated-module errors after the drift check has restored the files.
- **Why:** the temporary import gap left the preview returning asset timeouts and displaying its static fallback even though codegen and builds subsequently passed.
- **How to apply:** confirm the generated files are restored, then restart the affected web workflow once and verify the rendered preview. Do not change application code to fix a stale preview graph.

**Validation inventory response shape:** the live `getValidationCommands()` callback returns `{ commands: [{ name, command }], message }`, despite the skill describing a `workflows` array.
- **Why:** following the documented shape caused an undefined-array error; the live response confirmed the different envelope.
- **How to apply:** inspect the live envelope and read `commands` when checking for existing validation names. Do not assume the skill's output shape is current.
