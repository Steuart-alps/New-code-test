---
name: Staged validation runner
description: Validation checks run through scripts/validate.mjs, which bounds concurrency across runners and keeps checks off port 8080.
---

Run checks as `node scripts/validate.mjs <check>`; the real command lives in the runner's `DEFAULT_CHECKS` table, so add a new validation there. (Until 2026-10-09 each `.replit` validation workflow called the runner and `--check-config` verified that wiring; both were removed with Replit.)

**Why:** Replit's parallel Project group used to start every validation at once (historical), and parallel agents can still do the same. ~36 pnpm/tsc/Vite/Chromium/API processes together exhausted workspace memory until even `node --version` stalled.

**How to apply:**
- Slots are `flock` files under `$TMPDIR/complytrack-validate` shared by every runner process: `VALIDATE_CONCURRENCY` (default 2) overall, plus one heavy (typecheck/build/bundle), one API suite and one browser suite at a time. Before a start, the runner waits (up to `VALIDATE_MEM_WAIT_SECONDS`) for MemAvailable/cgroup headroom of the check's estimate plus `VALIDATE_MEM_RESERVE_MB`, but never skips a check.
- `api-codegen-drift` holds the generated-client lock exclusively and every other check holds it shared, so the drift check's temporary file deletion cannot break a concurrent build.
- Restarts: each check runs in its own process group with a watcher that kills the group if the runner dies; a dead runner's claim is reaped on the next run. Two runs of the same check never overlap (a duplicate `typecheck` run waits for the first).
- The runner strips `PORT`, `TEST_PORT` and `API_BASE` from checks and stops any check that listens on `VALIDATE_GUARD_PORT` (8080, the local API dev server). It never touches that process itself.
- Full local run: `node scripts/validate.mjs --all --concurrency 1` (stages: static → codegen → integration; the drift check needs lib/*/dist built by the typecheck). Focused: `node scripts/validate.mjs <check> ...`.
