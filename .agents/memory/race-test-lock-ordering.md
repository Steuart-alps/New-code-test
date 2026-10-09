---
name: Ordered row-lock barriers in race tests
description: Concurrency tests that hold a row lock as an overlap barrier should also fix queue order and run each ordering.
---

Holding `FOR UPDATE` on the contested row from a test-owned connection proves two requests overlap, but on its own it does not decide which request runs first. Postgres grants queued tuple locks in arrival order, so start request A, poll `pg_blocking_pids` until A is queued, then start B, and run the race once in each order (see `raceRecoveryCodeAcrossWebAndMobile` in `api-server/tests/twofa-recovery.mjs`).

**Why:** when one consumer is unsafe (an unconditional SELECT-then-UPDATE) and the other is a conditional `UPDATE ... AND used_at IS NULL RETURNING`, the bug only shows up when the unsafe one goes second. An unordered race caught it in about half the runs; the ordered rounds catch it every time.

**How to apply:** when two code paths (for example web and mobile) consume the same one-use row, run an ordered round for each path going first.
