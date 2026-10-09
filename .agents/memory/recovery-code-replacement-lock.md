---
name: Recovery-code replacement lock
description: Per-user advisory lock serializes recovery-code replacement; test barrier holds the user's code rows, not the lock itself.
---
`replaceRecoveryCodes` (auth.ts; callers: /auth/2fa/enable and
/auth/2fa/recovery-codes/regenerate) takes
`pg_advisory_xact_lock(0x52434f44 /* "RCOD" */, userId)` before its DELETE.
Without it, overlapping READ COMMITTED replacements both delete the old rows,
neither sees the other's inserts, and 20 unused codes survive.

- Advisory lock chosen over `users ... FOR UPDATE` so replacement never blocks
  unrelated user-row writes. Two-int4 namespaces in use: 106, 823901
  (discount), 0x42494c4c (billing sync), 0x52434f44 (recovery codes).
- Regression (`overlappingRegenerationRegression` in tests/twofa-recovery.mjs)
  row-locks the user's existing code rows, then waits until both server
  backends are transitively blocked behind the test transaction. This barrier
  works with or without the fix, so the run without the lock deterministically
  shows 20 rows.
