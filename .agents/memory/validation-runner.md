---
name: Staged validation runner
description: Every .replit validation workflow runs through scripts/validate.mjs, which bounds concurrency across runners and keeps checks off the preview port.
---

Each `isValidation` workflow in `.replit` runs `node scripts/validate.mjs <its name>`; the real command lives in the runner's `DEFAULT_CHECKS` table. Add a new validation by adding it there **and** pointing the workflow at the runner; `node scripts/validate.mjs --check-config` fails if the two drift apart.

**Why:** Replit and the parallel Project group start every validation at once. ~36 pnpm/tsc/Vite/Chromium/API processes together exhausted workspace memory until even `node --version` stalled.

**How to apply:**
- Slots are `flock` files under `$TMPDIR/complytrack-validate` shared by every runner process: `VALIDATE_CONCURRENCY` (default 2) overall, plus one heavy (typecheck/build/bundle), one API suite and one browser suite at a time. Before a start, the runner waits (up to `VALIDATE_MEM_WAIT_SECONDS`) for MemAvailable/cgroup headroom of the check's estimate plus `VALIDATE_MEM_RESERVE_MB`, but never skips a check.
- `api-codegen-drift` holds the generated-client lock exclusively and every other check holds it shared, so the drift check's temporary file deletion cannot break a concurrent build.
- Restarts: each check runs in its own process group with a watcher that kills the group if the runner dies; a dead runner's claim is reaped on the next run. Two runs of the same check never overlap (the duplicate `typecheck` workflow waits for the first).
- The runner strips `PORT`, `TEST_PORT` and `API_BASE` from checks and stops any check that listens on `VALIDATE_GUARD_PORT` (8080, the managed API preview). It never touches the preview process itself.
- Full local run: `node scripts/validate.mjs --all --concurrency 1` (stages: static → codegen → integration; the drift check needs lib/*/dist built by the typecheck). Focused: `node scripts/validate.mjs <check> ...`.
